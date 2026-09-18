"""Rime ws3 WebSocket client. One job: connect to Rime, submit synthesis
text, surface streamed audio chunks incrementally as they arrive. No
FastAPI/browser-WebSocket logic here (that's server/session_ws.py).

Verified against live Rime docs at Phase 4 implementation time
(docs.rime.ai/docs/streaming, /api-reference/mistv2/websockets-json):

  Endpoint   wss://users-ws.rime.ai/ws3
             ?speaker=<id>&modelId=mistv2&audioFormat=mp3
             &phonemizeBetweenBrackets=true&pauseBetweenBrackets=true
  Auth       Authorization: Bearer <RIME_API_KEY> header
  Client ->  {"text": "...", "contextId": "..."}
             {"operation": "eos"}     -- finish this context, flush+close out
             {"operation": "clear"}   -- cancel whatever is generating now
  Server ->  {"type": "chunk", "data": "<base64>", "contextId": "..."}
             {"type": "done", "contextId": "..."}   (ws3: minimal — type + contextId only)
             {"type": "error", "message": "..."}
             {"type": "timestamps", ...}             -- ignored, Phase 4 doesn't need it

Rime echoes contextId on its responses but does not itself run multiple
simultaneous contexts or fence stale ones — that discard/fencing logic is
RELAY's own responsibility (Phase 7). This module only tracks per-context
counts (chunksReceived, bytesReceived, stale flag) so Phase 7 has
something to build fencing on top of, per Phase 4."""

import base64
import json
import uuid
from typing import AsyncIterator, Optional

import websockets

from server.config import settings

RIME_WS_URL = "wss://users-ws.rime.ai/ws3"
MODEL_ID = "mistv2"  # never omit — omitting it silently routes to Mist v3


class RimeStreamError(Exception):
    """Provider/connection failure. Message is safe to surface (never
    includes the API key or a raw exception dump)."""


class RimeContext:
    """Per-synthesis-context accounting. Phase 4 only counts; Phase 7 owns
    the discard/fencing decisions built on top of `stale`."""

    def __init__(self, context_id: str):
        self.context_id = context_id
        self.chunks_received = 0
        self.bytes_received = 0
        self.stale = False
        self.discarded_chunks = 0


def _connection_url(speaker: str) -> str:
    params = {
        "speaker": speaker,
        "modelId": MODEL_ID,
        "audioFormat": "mp3",
        "phonemizeBetweenBrackets": "true",
        "pauseBetweenBrackets": "true",
    }
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{RIME_WS_URL}?{query}"


class RimeSpeechClient:
    """One Rime ws3 connection per RELAY speech session (Phase 4).
    Opened lazily on the first `speak()`, reused for subsequent turns in
    the same browser session, closed when the session ends."""

    def __init__(self, speaker: str):
        self.speaker = speaker
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self.contexts: dict[str, RimeContext] = {}
        self.current_context_id: Optional[str] = None

    async def connect(self) -> bool:
        """Idempotent: establishes the Rime connection if not already open.
        Returns True if a *new* connection was opened, False if an existing
        live one was reused — callers that keep a long-running events()
        consumer task (server/session_ws.py) need this to know whether that
        task must be restarted against the new socket.

        Rime closes the ws3 socket itself once a context finishes (`done`)
        — discovered during Phase 6 verification, where a second speak() on
        the same reused connection failed with ConnectionClosedOK. So
        "already open" means self._ws is set *and* not already closed —
        otherwise this reconnects rather than trying to send on a dead
        socket. `close_code` is None while the connection is open on both
        the modern `websockets.asyncio.client.ClientConnection` this
        library returns by default and the legacy `WebSocketClientProtocol`
        — unlike `.closed`, which only the legacy class exposes.

        Callers that need to start reading events() concurrently with the
        first speak() must await this *before* spawning the events()-
        consuming task — events() returns immediately while self._ws is
        still None, so a race here would silently drop the first
        utterance's audio."""
        if self._ws is not None and self._ws.close_code is None:
            return False
        self._ws = None
        headers = {"Authorization": f"Bearer {settings.RIME_API_KEY}"}
        try:
            self._ws = await websockets.connect(_connection_url(self.speaker), additional_headers=headers)
        except (websockets.exceptions.WebSocketException, OSError) as e:
            raise RimeStreamError(f"Could not connect to Rime: {type(e).__name__}") from e
        return True

    async def speak(self, text: str) -> str:
        """Start a new synthesis context for `text`. Returns the new
        contextId; the caller reads events() to get its audio/done/error."""
        await self.connect()
        context_id = f"ctx_{uuid.uuid4().hex[:12]}"
        self.contexts[context_id] = RimeContext(context_id)
        self.current_context_id = context_id
        assert self._ws is not None
        try:
            await self._ws.send(json.dumps({"text": text, "contextId": context_id}))
            await self._ws.send(json.dumps({"operation": "eos"}))
        except (websockets.exceptions.WebSocketException, OSError) as e:
            raise RimeStreamError(f"Could not send to Rime: {type(e).__name__}") from e
        return context_id

    async def clear(self) -> Optional[str]:
        """Cancel whatever is currently generating. Returns the contextId
        that was marked stale (if any). This is protocol plumbing only —
        full stale-chunk discard/flush-timing semantics are Phase 7's job."""
        if self._ws is None or self.current_context_id is None:
            return None
        stale_id = self.current_context_id
        self.contexts[stale_id].stale = True
        try:
            await self._ws.send(json.dumps({"operation": "clear"}))
        except (websockets.exceptions.WebSocketException, OSError) as e:
            raise RimeStreamError(f"Could not send clear to Rime: {type(e).__name__}") from e
        return stale_id

    async def events(self) -> AsyncIterator[dict]:
        """Yield decoded server events for as long as the connection is
        open: {"type": "chunk"|"done"|"error", "contextId": ..., ...}.
        Audio bytes are forwarded per-message, immediately — never
        accumulated into a full clip."""
        if self._ws is None:
            return
        try:
            async for raw in self._ws:
                try:
                    event = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                etype = event.get("type")
                context_id = event.get("contextId")

                if etype == "chunk":
                    data_b64 = event.get("data")
                    if not data_b64:
                        continue
                    audio_bytes = base64.b64decode(data_b64)
                    ctx = self.contexts.get(context_id)
                    if ctx is not None:
                        ctx.chunks_received += 1
                        ctx.bytes_received += len(audio_bytes)
                        if ctx.stale:
                            ctx.discarded_chunks += 1
                            # Never forwarded as playable audio, but never
                            # silently dropped either: surface the updated count so
                            # session_ws can push a fresh context_cleared to
                            # the browser for every late chunk, not just the
                            # ones that happened to arrive before clear()
                            # returned.
                            yield {
                                "type": "chunk_discarded",
                                "contextId": context_id,
                                "discardedChunks": ctx.discarded_chunks,
                            }
                            continue  # never forward audio from a cleared context
                    yield {"type": "chunk", "contextId": context_id, "data": audio_bytes}

                elif etype == "done":
                    yield {"type": "done", "contextId": context_id}

                elif etype == "error":
                    yield {"type": "error", "contextId": context_id, "message": event.get("message", "Rime error")}

                # "timestamps" and anything else are ignored — not needed yet.
        except (websockets.exceptions.WebSocketException, OSError) as e:
            raise RimeStreamError(f"Rime connection failed: {type(e).__name__}") from e

    async def close(self) -> None:
        if self._ws is not None:
            await self._ws.close()
            self._ws = None
