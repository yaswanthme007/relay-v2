"""Browser-facing WebSocket layer: /ws/tts. Translates the browser's
application-level messages (speak/clear/heard_report) into Rime synthesis
actions via server/rime_ws.py, and forwards Rime's streamed events back to
the browser. The browser never sees Rime's protocol or RIME_API_KEY
directly — only the documented application wire contract, extended in
Phase 7 with heard_report/chunk_discarded.

Phase 7 adds: `kind: "holding"` on speak (floor-hold preload — bypasses
confidence/prosody/ledger entirely, since a cached holding phrase is not a
candidate); `heard_report` from the browser, which is the only thing that
actually knows what reached the speakers (AudioContext playback state) —
this module just timestamps it and re-emits the already-documented
heard_entry event; and forwarding rime_ws's per-late-chunk
`chunk_discarded` signal as additional `context_cleared` updates, so the
browser's discarded-chunk count reflects chunks that arrive *after* the
first clear reply too.

Post-Phase-8 adds `kind: "preview"` — a Voice Ledger pronunciation check.
It reads one ledger row (scoped to this connection's userId) and speaks
that row's stored pronunciation through the same Rime mistv2 pipeline, so
what the user hears in the ledger is what a real sentence would produce.
It is not confidence-gated or prosody-transformed (it is not a candidate),
it never mutates the ledger, and it never produces a Heard Receipt entry —
the receipt describes speech the user chose to relay, not an audition."""

import asyncio
import base64
import json
from datetime import datetime

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from server.config import settings
from server.ledger import get_entry, get_ledger, inject_pronunciations
from server.models import ClearMessage, HeardEntry, HeardReportMessage, SpeakMessage
from server.prosody import apply_prosody
from server.rime_ws import RimeSpeechClient, RimeStreamError
from server.voices import resolve_speaker


def _now_hhmmss() -> str:
    """HH:MM:SS, 24-hour — matches HeardEntry.time exactly."""
    return datetime.now().strftime("%H:%M:%S")


async def _drain_and_close(client: RimeSpeechClient, task: "asyncio.Task | None", grace_seconds: float = 5.0) -> None:
    """Let an abandoned client's forward task keep running for a bounded
    grace period before closing the connection — used when a barge-in
    replaces the active client (Phase 7 fencing). That
    forward task is the only thing still reading the old ws3 connection,
    and reading is what counts stale chunks (rime_ws.py's events()) and
    keeps pushing updated context_cleared messages to the browser for them
    (session_ws's chunk_discarded handling). Cancelling it immediately —
    an earlier version of ensure_client() did, to switch over to the new
    connection right away — silenced discardedChunks counting the instant
    a barge-in's replacement speak() arrived, since that always coincides
    with the moment a fresh connection is forced (found via Phase 8 real
    evidence testing: discarded counts fell to 0 immediately after fixing
    a *different* real bug that required force-reconnecting after every
    clear() — the two fixes were in tension until this one runs the old
    connection's drain independently of the new one)."""
    if task is not None:
        try:
            await asyncio.wait_for(task, timeout=grace_seconds)
        except asyncio.TimeoutError:
            task.cancel()
        except Exception:
            pass
    try:
        await asyncio.wait_for(client.close(), timeout=2.0)
    except Exception:
        pass


async def tts_endpoint(websocket: WebSocket) -> None:
    # CORSMiddleware doesn't cover WebSocket upgrades — check Origin ourselves
    # so /ws/tts honors the same ALLOWED_ORIGIN restriction as the HTTP routes.
    origin = websocket.headers.get("origin")
    if origin != settings.ALLOWED_ORIGIN:
        await websocket.close(code=4403)
        return

    # Identifies whose ledger to inject from — a connection-time query param,
    # not a new message-body field, so the documented speak/clear message
    # shapes stay exactly as Phase 4 defined them.
    user_id = websocket.query_params.get("userId")

    await websocket.accept()

    rime_client: RimeSpeechClient | None = None
    forward_task: asyncio.Task | None = None
    send_lock = asyncio.Lock()
    # Set whenever a `clear` is sent — found via Phase 8 real evidence
    # testing: reusing the *same* live ws3 connection for the next speak()
    # immediately after clear() is unreliable in practice (Rime appears to
    # keep draining the cancelled context's buffered audio on that socket
    # rather than reliably accepting a brand-new context on it right away
    # — the new speak's audio never arrived in a real barge-in run, even
    # though clear/fencing/discard-counting all worked correctly). A
    # barge-in is exactly the moment correctness matters most, so the next
    # speak() after any clear() gets a fully fresh connection instead of
    # reusing the just-cleared one — a small cost (one extra reconnect)
    # confined to the barge-in path; ordinary sequential turns still reuse
    # connections exactly as before.
    force_reconnect_next_speak = False

    async def send(payload: dict) -> None:
        async with send_lock:
            await websocket.send_json(payload)

    async def ensure_client(speaker: str, force_new: bool = False) -> None:
        """Make sure `rime_client` is a live, connected client for
        `speaker`, with `forward_task` consuming its events(). `force_new`
        always discards the current client even if the speaker matches —
        used by the retry-on-stale-connection path below."""
        nonlocal rime_client, forward_task
        if force_new or rime_client is None or rime_client.speaker != speaker:
            if rime_client is not None:
                # Orphaned, not cancelled+closed synchronously — see
                # _drain_and_close()'s docstring for why. This coroutine
                # must not block on the old connection's cleanup either
                # way: an earlier version awaited close() directly here,
                # which could stall this same message-processing loop
                # indefinitely on a connection already mid-clear/mid-flush
                # (exactly the state being abandoned), and the *next*
                # utterance after a barge-in would then never reach Rime
                # at all — confirmed with a raw protocol test, no browser
                # involved.
                asyncio.create_task(_drain_and_close(rime_client, forward_task))
            rime_client = RimeSpeechClient(speaker)
            needs_new_forward_task = True
        else:
            # Rime closes its own end of the socket once a context finishes
            # — a second speak() on the same voice needs to detect that and
            # reconnect (found during Phase 6 real verification: reusing a
            # finished connection failed with ConnectionClosedOK).
            # connect() reopens the socket transparently; forward_task must
            # restart too, since its `async for` loop was bound to the
            # now-dead one.
            needs_new_forward_task = False

        # Connect BEFORE spawning the events()-forwarding task: events()
        # returns immediately while the socket is still None, so starting
        # it any earlier races the connection and silently drops this
        # utterance's audio.
        reconnected = await rime_client.connect()
        if needs_new_forward_task or reconnected:
            if forward_task is not None:
                forward_task.cancel()
            forward_task = asyncio.create_task(forward_rime_events(rime_client))

    async def forward_rime_events(client: RimeSpeechClient) -> None:
        """Runs concurrently with the browser receive loop below, pushing
        each Rime event to the browser the moment it arrives — never
        accumulated server-side."""
        try:
            async for event in client.events():
                if event["type"] == "chunk":
                    await send({
                        "type": "audio_chunk",
                        "contextId": event["contextId"],
                        "data": base64.b64encode(event["data"]).decode("ascii"),
                    })
                elif event["type"] == "done":
                    await send({"type": "synthesis_done", "contextId": event["contextId"]})
                elif event["type"] == "chunk_discarded":
                    # A late chunk from an already-fenced context — never
                    # played, but re-reported so the browser's discarded
                    # count keeps climbing for as long as Rime keeps
                    # sending them (phase7 prompt §20: a stale count must
                    # never go silently stale itself).
                    await send({
                        "type": "context_cleared",
                        "contextId": event["contextId"],
                        "discardedChunks": event["discardedChunks"],
                    })
                elif event["type"] == "error":
                    await send({"type": "error", "contextId": event.get("contextId"), "message": event["message"]})
        except RimeStreamError as e:
            try:
                await send({"type": "error", "message": str(e)})
            except Exception:
                pass

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                payload = json.loads(raw)
            except (ValueError, TypeError):
                await send({"type": "error", "message": "Malformed message: not valid JSON"})
                continue

            msg_type = payload.get("type") if isinstance(payload, dict) else None

            if msg_type == "speak":
                try:
                    speak_msg = SpeakMessage(**payload)
                except ValidationError:
                    await send({"type": "error", "message": "Invalid speak message"})
                    continue

                if speak_msg.kind == "preview":
                    # Voice Ledger pronunciation preview: the user is
                    # auditioning one stored ledger term, not relaying a
                    # sentence. Deliberately *not* confidence-gated or
                    # prosody-transformed (a preview is not a candidate),
                    # and deliberately not exempt from ledger semantics
                    # the way "holding" is — reproducing the pronunciation
                    # a real sentence would get is the entire point.
                    #
                    # The row is loaded from the database, scoped to this
                    # connection's userId. Nothing the browser sent about
                    # the pronunciation is trusted: speak_msg.text is only
                    # the word the browser happens to be displaying, and
                    # there is no wire field for a phoneme at all, so one
                    # user can never make the server speak another user's
                    # stored pronunciation (or an arbitrary bracket
                    # string) by supplying an id or a phoneme.
                    if not user_id:
                        await send({
                            "type": "error",
                            "message": "Preview requires an identified session.",
                        })
                        continue
                    entry = get_entry(user_id, speak_msg.entryId)
                    if entry is None:
                        # Same response for "no such entry" and "someone
                        # else's entry" — matches the ledger routes' 404.
                        await send({"type": "error", "message": "Ledger entry not found."})
                        continue
                    # Exactly the Phase 5 injection helper, run over this
                    # one entry: a verified entry with a stored phoneme
                    # previews as its `{phoneme}` string; an unverified one
                    # (or a verified one with phoneme == "") previews as
                    # the plain word and gets Rime's own model-predicted
                    # pronunciation. Never a fabricated phoneme, and the
                    # ledger row itself is never mutated by a preview.
                    synthesis_text = inject_pronunciations(entry.word, [entry])
                elif speak_msg.kind == "holding":
                    # Floor-hold preload (Phase 7): a cached
                    # conversational filler, not a
                    # candidate. It must never be confidence-gated, turned
                    # into a question, or run through ledger injection —
                    # doing so risks e.g. "<300>One moment?" or a phrase
                    # rejected outright because the browser sent a low
                    # placeholder confidence for it.
                    synthesis_text = speak_msg.text
                else:
                    # Confidence -> delivery decision happens before anything
                    # else touches Rime. The server does not trust the browser
                    # alone to withhold speak() on a low-confidence candidate
                    # (Phase 6) — SpeakMessage.confidence is
                    # required, and a silent result stops here, unconditionally.
                    prosody = apply_prosody(speak_msg.text, speak_msg.confidence)
                    if not prosody.should_speak:
                        await send({
                            "type": "error",
                            "message": "Confidence below synthesis threshold; not spoken.",
                        })
                        continue
                    synthesis_text = prosody.text
                    if user_id:
                        synthesis_text = inject_pronunciations(synthesis_text, get_ledger(user_id))

                speaker = resolve_speaker(speak_msg.voice)
                try:
                    await ensure_client(speaker, force_new=force_reconnect_next_speak)
                    force_reconnect_next_speak = False
                    try:
                        await rime_client.speak(synthesis_text)
                    except RimeStreamError:
                        # A reused connection can lose a race against Rime
                        # closing its end of the socket right after the
                        # previous context's `done` — connect()'s "already
                        # open" check (close_code is None) can pass a beat
                        # before the close is actually reflected, so the
                        # send() right after fails with ConnectionClosedOK.
                        # Found via Phase 8 real evidence testing (floor-hold
                        # preload's four rapid-fire back-to-back speak()
                        # calls hit this reliably). One forced fresh
                        # reconnect + retry absorbs the race; a second real
                        # failure is an actual provider/connection problem,
                        # not a race, and is allowed to surface normally.
                        await ensure_client(speaker, force_new=True)
                        await rime_client.speak(synthesis_text)
                except RimeStreamError as e:
                    await send({"type": "error", "message": str(e)})

            elif msg_type == "clear":
                try:
                    ClearMessage(**payload)
                except ValidationError:
                    await send({"type": "error", "message": "Invalid clear message"})
                    continue

                if rime_client is None:
                    continue
                # Whatever happens next, the *next* speak() must not reuse
                # this connection (see the module-level comment on this
                # flag's declaration above).
                force_reconnect_next_speak = True
                try:
                    stale_id = await rime_client.clear()
                except RimeStreamError:
                    # Same reconnect race as speak()'s retry above (Rime
                    # closed its end of the socket right after the last
                    # context finished): a clear() that fails to send
                    # because the connection is already dead is functionally
                    # a no-op — there was nothing live left to cancel,
                    # exactly like the `current_context_id is None` early
                    # return above. Not surfaced as an error: the browser
                    # already fences its own local context unconditionally
                    # on barge-in (defense-in-depth from Phase 7), so
                    # nothing is lost by staying silent here. Found via
                    # Phase 8 real evidence testing (a barge-in landing
                    # right as a just-finished floor-hold phrase's
                    # connection was closing).
                    continue
                if stale_id is not None:
                    ctx = rime_client.contexts.get(stale_id)
                    await send({
                        "type": "context_cleared",
                        "contextId": stale_id,
                        # Snapshot at the moment of clear() — usually 0,
                        # since Rime hasn't had time to send a late chunk
                        # yet. forward_rime_events() sends further
                        # context_cleared updates as chunk_discarded events
                        # keep arriving for this same context afterward.
                        "discardedChunks": ctx.discarded_chunks if ctx else 0,
                    })

            elif msg_type == "heard_report":
                try:
                    report = HeardReportMessage(**payload)
                except ValidationError:
                    await send({"type": "error", "message": "Invalid heard_report message"})
                    continue

                # The browser is the only thing that knows what actually
                # reached the speakers (AudioContext playback state) —
                # this is a report of that fact, not a server decision
                # (phase7 prompt §28). The server's only job is to
                # timestamp it and re-emit the documented heard_entry
                # event; HeardEntry's own validator still enforces that
                # cutAt is present iff status == "cut".
                entry = HeardEntry(
                    time=_now_hhmmss(),
                    status=report.status,
                    text=report.text,
                    cutAt=f"{report.cutAtSeconds:.1f}s" if report.cutAtSeconds is not None else None,
                )
                await send({"type": "heard_entry", "entry": entry.model_dump()})

            else:
                await send({"type": "error", "message": f"Unknown message type: {msg_type!r}"})

    except WebSocketDisconnect:
        pass
    finally:
        if forward_task is not None:
            forward_task.cancel()
        if rime_client is not None:
            await rime_client.close()
