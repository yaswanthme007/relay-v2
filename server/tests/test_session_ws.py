"""Tests for /ws/tts (server/session_ws.py) via FastAPI's TestClient.
server.session_ws.RimeSpeechClient is monkeypatched with a fake so no real
Rime connection is made."""

import re

import pytest
from fastapi.testclient import TestClient

from server import session_ws
from server.config import settings
from server.main import app
from server.models import LedgerEntry
from server.rime_ws import RimeStreamError


class FakeRimeClient:
    """Records what speak()/clear() were called with; replays a fixed
    chunk+done sequence for any speak() call."""

    def __init__(self, speaker: str):
        self.speaker = speaker
        self.contexts = {}
        self.current_context_id = None
        self.speak_calls: list[str] = []
        self.closed = False

    async def connect(self) -> bool:
        return False

    async def speak(self, text: str) -> str:
        self.speak_calls.append(text)
        context_id = f"ctx_fake_{len(self.speak_calls)}"
        self.current_context_id = context_id

        class _Ctx:
            discarded_chunks = 0

        self.contexts[context_id] = _Ctx()
        self._pending_events = [
            {"type": "chunk", "contextId": context_id, "data": b"hello-audio-bytes"},
            {"type": "done", "contextId": context_id},
        ]
        return context_id

    async def clear(self):
        return self.current_context_id

    async def events(self):
        for event in getattr(self, "_pending_events", []):
            yield event

    async def close(self):
        self.closed = True


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(session_ws, "RimeSpeechClient", FakeRimeClient)
    return TestClient(app)


def _connect(client):
    return client.websocket_connect("/ws/tts", headers={"origin": settings.ALLOWED_ORIGIN})


def test_wrong_origin_is_rejected(client):
    with pytest.raises(Exception):
        with client.websocket_connect("/ws/tts", headers={"origin": "http://evil.example"}) as ws:
            ws.receive_json()


def test_speak_produces_audio_chunk_then_synthesis_done(client):
    with _connect(client) as ws:
        ws.send_json({"type": "speak", "text": "hello", "voice": "Cove", "confidence": 0.9})
        first = ws.receive_json()
        second = ws.receive_json()

    assert first["type"] == "audio_chunk"
    assert first["contextId"].startswith("ctx_fake_")
    assert "data" in first  # base64 string
    assert second["type"] == "synthesis_done"
    assert second["contextId"] == first["contextId"]


def test_malformed_json_returns_error(client):
    with _connect(client) as ws:
        ws.send_text("not json")
        reply = ws.receive_json()
    assert reply["type"] == "error"


def test_unknown_message_type_returns_error(client):
    with _connect(client) as ws:
        ws.send_json({"type": "dance"})
        reply = ws.receive_json()
    assert reply["type"] == "error"


def test_speak_missing_required_field_returns_error(client):
    with _connect(client) as ws:
        ws.send_json({"type": "speak", "voice": "Cove", "confidence": 0.9})  # missing "text"
        reply = ws.receive_json()
    assert reply["type"] == "error"


def test_clear_with_no_prior_speak_does_not_crash(client):
    with _connect(client) as ws:
        ws.send_json({"type": "clear"})
        # No speak happened yet, so no context to clear — send a real speak
        # afterward to confirm the connection is still alive and usable.
        ws.send_json({"type": "speak", "text": "still alive", "voice": "Cove", "confidence": 0.9})
        first = ws.receive_json()
    assert first["type"] == "audio_chunk"


def test_clear_after_speak_sends_context_cleared(client):
    with _connect(client) as ws:
        ws.send_json({"type": "speak", "text": "hello", "voice": "Cove", "confidence": 0.9})
        ws.receive_json()  # audio_chunk
        ws.receive_json()  # synthesis_done
        ws.send_json({"type": "clear"})
        reply = ws.receive_json()

    assert reply["type"] == "context_cleared"
    assert "discardedChunks" in reply
    assert reply["contextId"].startswith("ctx_fake_")


def test_speak_injects_verified_ledger_pronunciation(monkeypatch):
    created_instances: list[FakeRimeClient] = []

    def tracking_factory(speaker: str) -> FakeRimeClient:
        instance = FakeRimeClient(speaker)
        created_instances.append(instance)
        return instance

    monkeypatch.setattr(session_ws, "RimeSpeechClient", tracking_factory)

    fake_entry = LedgerEntry(
        id="1", word="metformin", phoneme="{m1Etf1OrmIn}",
        category="medication", covered=True, verified=True,
    )
    monkeypatch.setattr(session_ws, "get_ledger", lambda user_id: [fake_entry])

    test_client = TestClient(app)
    with test_client.websocket_connect(
        "/ws/tts?userId=u1", headers={"origin": settings.ALLOWED_ORIGIN}
    ) as ws:
        ws.send_json({"type": "speak", "text": "I need metformin please.", "voice": "Cove", "confidence": 0.9})
        ws.receive_json()  # audio_chunk
        ws.receive_json()  # synthesis_done

    assert len(created_instances) == 1
    assert created_instances[0].speak_calls == ["I need {m1Etf1OrmIn} please."]


def test_speak_without_userid_does_not_inject(client, monkeypatch):
    calls = []
    monkeypatch.setattr(session_ws, "get_ledger", lambda user_id: calls.append(user_id) or [])

    with _connect(client) as ws:
        ws.send_json({"type": "speak", "text": "I need metformin please.", "voice": "Cove", "confidence": 0.9})
        ws.receive_json()
        ws.receive_json()

    assert calls == []  # get_ledger never called when no userId on the connection


# ─── Phase 6: prosody integration ──────────────────────────────────────────

def test_high_confidence_reaches_rime_verbatim(monkeypatch):
    created_instances: list[FakeRimeClient] = []
    monkeypatch.setattr(session_ws, "RimeSpeechClient", lambda speaker: created_instances.append(FakeRimeClient(speaker)) or created_instances[-1])

    test_client = TestClient(app)
    with test_client.websocket_connect("/ws/tts", headers={"origin": settings.ALLOWED_ORIGIN}) as ws:
        ws.send_json({"type": "speak", "text": "I need a refill of metformin.", "voice": "Cove", "confidence": 0.9})
        ws.receive_json()
        ws.receive_json()

    assert created_instances[0].speak_calls == ["I need a refill of metformin."]


def test_medium_confidence_reaches_rime_with_pause_and_question(monkeypatch):
    created_instances: list[FakeRimeClient] = []
    monkeypatch.setattr(session_ws, "RimeSpeechClient", lambda speaker: created_instances.append(FakeRimeClient(speaker)) or created_instances[-1])

    test_client = TestClient(app)
    with test_client.websocket_connect("/ws/tts", headers={"origin": settings.ALLOWED_ORIGIN}) as ws:
        ws.send_json({"type": "speak", "text": "Metformin, two fifty milligrams.", "voice": "Cove", "confidence": 0.6})
        ws.receive_json()
        ws.receive_json()

    assert created_instances[0].speak_calls == ["<300>Metformin, two fifty milligrams?"]


def test_low_confidence_never_reaches_rime(monkeypatch):
    created_instances: list[FakeRimeClient] = []
    monkeypatch.setattr(session_ws, "RimeSpeechClient", lambda speaker: created_instances.append(FakeRimeClient(speaker)) or created_instances[-1])

    test_client = TestClient(app)
    with test_client.websocket_connect("/ws/tts", headers={"origin": settings.ALLOWED_ORIGIN}) as ws:
        ws.send_json({"type": "speak", "text": "Unclear low confidence guess.", "voice": "Cove", "confidence": 0.2})
        reply = ws.receive_json()

    assert reply["type"] == "error"
    assert created_instances == []  # RimeSpeechClient never even constructed


def test_medium_confidence_with_verified_ledger_term_gets_both_transforms(monkeypatch):
    created_instances: list[FakeRimeClient] = []
    monkeypatch.setattr(session_ws, "RimeSpeechClient", lambda speaker: created_instances.append(FakeRimeClient(speaker)) or created_instances[-1])

    fake_entry = LedgerEntry(
        id="1", word="metformin", phoneme="{m1Etf1OrmIn}",
        category="medication", covered=True, verified=True,
    )
    monkeypatch.setattr(session_ws, "get_ledger", lambda user_id: [fake_entry])

    test_client = TestClient(app)
    with test_client.websocket_connect(
        "/ws/tts?userId=u1", headers={"origin": settings.ALLOWED_ORIGIN}
    ) as ws:
        ws.send_json({"type": "speak", "text": "I need metformin refilled.", "voice": "Cove", "confidence": 0.6})
        ws.receive_json()
        ws.receive_json()

    assert created_instances[0].speak_calls == ["<300>I need {m1Etf1OrmIn} refilled?"]


# ─── Phase 7: floor-hold preload, fencing forwarding, Heard Receipt ───────


def test_holding_kind_bypasses_prosody_even_at_low_confidence(monkeypatch):
    """A cached floor-hold phrase is not a candidate — it must be spoken
    verbatim regardless of the (placeholder) confidence value sent with it,
    never gated silent and never turned into a question (phase7 prompt §10)."""
    created_instances: list[FakeRimeClient] = []
    monkeypatch.setattr(session_ws, "RimeSpeechClient", lambda speaker: created_instances.append(FakeRimeClient(speaker)) or created_instances[-1])

    test_client = TestClient(app)
    with test_client.websocket_connect("/ws/tts", headers={"origin": settings.ALLOWED_ORIGIN}) as ws:
        ws.send_json({"type": "speak", "text": "One moment.", "voice": "Cove", "confidence": 0.0, "kind": "holding"})
        first = ws.receive_json()
        ws.receive_json()

    assert first["type"] == "audio_chunk"  # not the silent-branch error
    assert created_instances[0].speak_calls == ["One moment."]


def test_holding_kind_skips_ledger_injection(monkeypatch):
    """Floor-hold phrases are generic filler, not candidate text — never
    run through the per-user pronunciation ledger."""
    created_instances: list[FakeRimeClient] = []
    monkeypatch.setattr(session_ws, "RimeSpeechClient", lambda speaker: created_instances.append(FakeRimeClient(speaker)) or created_instances[-1])
    ledger_calls = []
    monkeypatch.setattr(session_ws, "get_ledger", lambda user_id: ledger_calls.append(user_id) or [])

    test_client = TestClient(app)
    with test_client.websocket_connect(
        "/ws/tts?userId=u1", headers={"origin": settings.ALLOWED_ORIGIN}
    ) as ws:
        ws.send_json({"type": "speak", "text": "Hold on.", "voice": "Cove", "confidence": 1.0, "kind": "holding"})
        ws.receive_json()
        ws.receive_json()

    assert ledger_calls == []
    assert created_instances[0].speak_calls == ["Hold on."]


def test_default_kind_is_candidate_and_unaffected(client):
    """Regression: omitting `kind` entirely (every pre-Phase-7 caller) must
    behave exactly as before — full prosody gating still applies."""
    with _connect(client) as ws:
        ws.send_json({"type": "speak", "text": "Unclear low confidence guess.", "voice": "Cove", "confidence": 0.2})
        reply = ws.receive_json()
    assert reply["type"] == "error"


class FakeRimeClientWithLateDiscards(FakeRimeClient):
    """Simulates Rime continuing to send chunks from an already-cleared
    context after the initial clear() reply went out — the forward loop
    must keep reporting updated discardedChunks for each one."""

    async def speak(self, text: str) -> str:
        context_id = await super().speak(text)
        self._pending_events += [
            {"type": "chunk_discarded", "contextId": context_id, "discardedChunks": 1},
            {"type": "chunk_discarded", "contextId": context_id, "discardedChunks": 2},
        ]
        return context_id


def test_late_chunk_discarded_events_forward_as_further_context_cleared(monkeypatch):
    monkeypatch.setattr(session_ws, "RimeSpeechClient", FakeRimeClientWithLateDiscards)
    test_client = TestClient(app)
    with test_client.websocket_connect("/ws/tts", headers={"origin": settings.ALLOWED_ORIGIN}) as ws:
        ws.send_json({"type": "speak", "text": "hello", "voice": "Cove", "confidence": 0.9})
        chunk = ws.receive_json()
        done = ws.receive_json()
        cleared_1 = ws.receive_json()
        cleared_2 = ws.receive_json()

    assert chunk["type"] == "audio_chunk"
    assert done["type"] == "synthesis_done"
    assert cleared_1 == {"type": "context_cleared", "contextId": chunk["contextId"], "discardedChunks": 1}
    assert cleared_2 == {"type": "context_cleared", "contextId": chunk["contextId"], "discardedChunks": 2}


def test_heard_report_complete_produces_heard_entry_without_cut_at(client):
    with _connect(client) as ws:
        ws.send_json({
            "type": "heard_report",
            "contextId": "ctx_1",
            "text": "Hi, I'm here to pick up a prescription.",
            "status": "complete",
        })
        reply = ws.receive_json()

    assert reply["type"] == "heard_entry"
    entry = reply["entry"]
    assert entry["status"] == "complete"
    assert entry["text"] == "Hi, I'm here to pick up a prescription."
    assert entry.get("cutAt") is None
    assert re.match(r"^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$", entry["time"])


def test_heard_report_cut_produces_heard_entry_with_measured_cut_at(client):
    with _connect(client) as ws:
        ws.send_json({
            "type": "heard_report",
            "contextId": "ctx_2",
            "text": "Metformin, two fifty—",
            "status": "cut",
            "cutAtSeconds": 0.42,
        })
        reply = ws.receive_json()

    assert reply["entry"]["status"] == "cut"
    assert reply["entry"]["cutAt"] == "0.4s"


def test_heard_report_cut_without_cut_at_seconds_is_rejected(client):
    with _connect(client) as ws:
        ws.send_json({
            "type": "heard_report",
            "contextId": "ctx_3",
            "text": "...",
            "status": "cut",
        })
        reply = ws.receive_json()
    assert reply["type"] == "error"


def test_heard_report_complete_with_cut_at_seconds_is_rejected(client):
    with _connect(client) as ws:
        ws.send_json({
            "type": "heard_report",
            "contextId": "ctx_4",
            "text": "...",
            "status": "complete",
            "cutAtSeconds": 1.0,
        })
        reply = ws.receive_json()
    assert reply["type"] == "error"


def test_heard_receipt_entries_are_independent_and_in_order(client):
    """Append-only: multiple reports on one connection each produce their
    own entry, in the order sent — the server never merges or overwrites."""
    with _connect(client) as ws:
        ws.send_json({"type": "heard_report", "contextId": "a", "text": "first", "status": "complete"})
        first = ws.receive_json()
        ws.send_json({"type": "heard_report", "contextId": "b", "text": "second-", "status": "cut", "cutAtSeconds": 0.4})
        second = ws.receive_json()

    assert first["entry"]["text"] == "first"
    assert first["entry"]["status"] == "complete"
    assert second["entry"]["text"] == "second-"
    assert second["entry"]["status"] == "cut"


# ─── Phase 8: reconnect-race retry (found via real evidence testing) ──────


def test_speak_retries_once_on_stale_connection_send_failure(monkeypatch):
    """Fails the first-ever speak() with the exact real race observed
    during Phase 8 evidence testing (Rime closes its end of the socket
    right after the previous context's `done`; a rapid-fire next speak()
    can lose that race) — succeeds from then on, same as a real forced
    reconnect would. The failure flag is shared across instances
    (`state`), not per-instance: ensure_client's retry creates a *new*
    RimeSpeechClient (force_new=True), so a per-instance flag would just
    reset and fail again on the new instance too — the point of this test
    is that the retry's fresh instance succeeds."""
    created_instances: list[FakeRimeClient] = []
    state = {"failed_once": False}

    class FlakyOnceRimeClient(FakeRimeClient):
        async def speak(self, text: str) -> str:
            if not state["failed_once"]:
                state["failed_once"] = True
                raise RimeStreamError("Could not send to Rime: ConnectionClosedOK")
            return await super().speak(text)

    monkeypatch.setattr(
        session_ws, "RimeSpeechClient",
        lambda speaker: created_instances.append(FlakyOnceRimeClient(speaker)) or created_instances[-1],
    )

    test_client = TestClient(app)
    with test_client.websocket_connect("/ws/tts", headers={"origin": settings.ALLOWED_ORIGIN}) as ws:
        ws.send_json({"type": "speak", "text": "hello", "voice": "Cove", "confidence": 0.9})
        first = ws.receive_json()
        second = ws.receive_json()

    # The retry forces a fresh client (force_new=True) rather than reusing
    # the one that just failed — a second instance is expected.
    assert len(created_instances) == 2
    assert first["type"] == "audio_chunk"
    assert second["type"] == "synthesis_done"
    assert created_instances[1].speak_calls == ["hello"]


def test_clear_on_stale_connection_is_a_silent_no_op(monkeypatch):
    """A clear() that fails because the underlying Rime connection is
    already closed is functionally equivalent to 'nothing was generating'
    — it must not surface as an error (the browser already fences its own
    context locally regardless), and the connection must stay usable
    afterward. Found via Phase 8 real evidence testing: a barge-in landing
    right as a just-finished floor-hold phrase's connection was closing."""

    class ClearFailsOnceRimeClient(FakeRimeClient):
        async def clear(self):
            raise RimeStreamError("Could not send clear to Rime: ConnectionClosedOK")

    monkeypatch.setattr(session_ws, "RimeSpeechClient", ClearFailsOnceRimeClient)

    test_client = TestClient(app)
    with test_client.websocket_connect("/ws/tts", headers={"origin": settings.ALLOWED_ORIGIN}) as ws:
        ws.send_json({"type": "speak", "text": "hello", "voice": "Cove", "confidence": 0.9})
        ws.receive_json()  # audio_chunk
        ws.receive_json()  # synthesis_done

        ws.send_json({"type": "clear"})
        # No context_cleared and no error for the failed clear — silent —
        # but the connection must stay usable afterward. A different voice
        # here (vs. the fake's simplified events()-reuse semantics, unlike
        # the real RimeSpeechClient's genuinely continuous stream) forces a
        # fresh client/forward_task, which is exactly what a real voice
        # change would do too.
        ws.send_json({"type": "speak", "text": "still alive", "voice": "Ember", "confidence": 0.9})
        reply = ws.receive_json()
    assert reply["type"] == "audio_chunk"


def test_speak_surfaces_error_when_retry_also_fails(monkeypatch):
    class AlwaysFailsRimeClient(FakeRimeClient):
        async def speak(self, text: str) -> str:
            raise RimeStreamError("Could not send to Rime: ConnectionClosedOK")

    monkeypatch.setattr(session_ws, "RimeSpeechClient", AlwaysFailsRimeClient)

    test_client = TestClient(app)
    with test_client.websocket_connect("/ws/tts", headers={"origin": settings.ALLOWED_ORIGIN}) as ws:
        ws.send_json({"type": "speak", "text": "hello", "voice": "Cove", "confidence": 0.9})
        reply = ws.receive_json()

    assert reply["type"] == "error"
