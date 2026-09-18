"""Unit tests for server/rime_ws.py — connection URL construction, message
creation, context accounting, and clear/stale-discard bookkeeping. No real
Rime connection: `websockets.connect` is monkeypatched with a fake socket."""

import base64
import json

import pytest

from server import rime_ws
from server.rime_ws import MODEL_ID, RimeSpeechClient, _connection_url


class FakeWebSocket:
    """Minimal stand-in for websockets.WebSocketClientProtocol: records
    what was sent, replays a preset queue of incoming raw JSON strings."""

    def __init__(self, incoming: list[str]):
        self._incoming = list(incoming)
        self.sent: list[str] = []
        self.close_code: int | None = None  # None == open, matching real websockets.ClientConnection

    async def send(self, message: str) -> None:
        self.sent.append(message)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._incoming:
            raise StopAsyncIteration
        return self._incoming.pop(0)

    async def close(self) -> None:
        self.close_code = 1000


def _chunk_event(context_id: str, raw_bytes: bytes) -> str:
    return json.dumps({"type": "chunk", "contextId": context_id, "data": base64.b64encode(raw_bytes).decode()})


def _done_event(context_id: str) -> str:
    return json.dumps({"type": "done", "contextId": context_id})


def test_connection_url_has_required_params():
    url = _connection_url("cove")
    assert "modelId=mistv2" in url
    assert MODEL_ID == "mistv2"
    assert "speaker=cove" in url
    assert "audioFormat=mp3" in url
    assert "phonemizeBetweenBrackets=true" in url
    assert "pauseBetweenBrackets=true" in url
    assert url.startswith("wss://users-ws.rime.ai/ws3?")


async def test_speak_sends_text_then_eos_with_context_id(monkeypatch):
    fake_ws = FakeWebSocket(incoming=[])

    async def fake_connect(url, additional_headers):
        return fake_ws

    monkeypatch.setattr(rime_ws.websockets, "connect", fake_connect)

    client = RimeSpeechClient(speaker="cove")
    context_id = await client.speak("hello world")

    assert len(fake_ws.sent) == 2
    first = json.loads(fake_ws.sent[0])
    assert first["text"] == "hello world"
    assert first["contextId"] == context_id
    second = json.loads(fake_ws.sent[1])
    assert second == {"operation": "eos"}
    assert context_id in client.contexts


async def test_events_accounts_chunks_and_bytes(monkeypatch):
    ctx_id_holder = {}

    async def fake_connect(url, additional_headers):
        return FakeWebSocket(incoming=[])  # replaced below once we know the context id

    monkeypatch.setattr(rime_ws.websockets, "connect", fake_connect)

    client = RimeSpeechClient(speaker="cove")
    context_id = await client.speak("some text")

    chunk1, chunk2 = b"AAAA", b"BBBBBB"
    client._ws._incoming = [
        _chunk_event(context_id, chunk1),
        _chunk_event(context_id, chunk2),
        _done_event(context_id),
    ]

    events = [e async for e in client.events()]

    assert [e["type"] for e in events] == ["chunk", "chunk", "done"]
    assert events[0]["data"] == chunk1
    assert events[1]["data"] == chunk2
    ctx = client.contexts[context_id]
    assert ctx.chunks_received == 2
    assert ctx.bytes_received == len(chunk1) + len(chunk2)


async def test_clear_marks_stale_and_late_chunks_are_discarded_not_forwarded(monkeypatch):
    async def fake_connect(url, additional_headers):
        return FakeWebSocket(incoming=[])

    monkeypatch.setattr(rime_ws.websockets, "connect", fake_connect)

    client = RimeSpeechClient(speaker="cove")
    context_id = await client.speak("text")

    stale_id = await client.clear()
    assert stale_id == context_id
    assert client.contexts[context_id].stale is True
    # clear() itself sends the Rime "clear" operation
    assert json.loads(client._ws.sent[-1]) == {"operation": "clear"}

    # Chunks that still arrive from the now-stale context must be counted
    # but never yielded as playable audio — instead a chunk_discarded event
    # surfaces the running count, so callers never lose track of a stale
    # chunk silently (phase7 prompt §18/§20).
    client._ws._incoming = [_chunk_event(context_id, b"late-chunk")]
    events = [e async for e in client.events()]

    assert events == [{"type": "chunk_discarded", "contextId": context_id, "discardedChunks": 1}]
    assert client.contexts[context_id].discarded_chunks == 1


async def test_multiple_late_chunks_each_increment_discarded_count(monkeypatch):
    """Every late chunk gets its own chunk_discarded event with the
    updated running total — not just the first one (phase7 prompt §20:
    'the counter must increase for every stale chunk discarded')."""
    async def fake_connect(url, additional_headers):
        return FakeWebSocket(incoming=[])

    monkeypatch.setattr(rime_ws.websockets, "connect", fake_connect)

    client = RimeSpeechClient(speaker="cove")
    context_id = await client.speak("text")
    await client.clear()

    client._ws._incoming = [
        _chunk_event(context_id, b"late-1"),
        _chunk_event(context_id, b"late-2"),
        _chunk_event(context_id, b"late-3"),
    ]
    events = [e async for e in client.events()]

    assert [e["discardedChunks"] for e in events] == [1, 2, 3]
    assert all(e["type"] == "chunk_discarded" for e in events)
    assert client.contexts[context_id].discarded_chunks == 3


async def test_old_context_discarded_new_context_forwarded(monkeypatch):
    """Race ordering (phase7 prompt §23): a late chunk from the
    cleared/stale context interleaved with chunks from a brand new context
    must never be mistaken for each other — old is discarded and counted,
    new is forwarded and played."""
    async def fake_connect(url, additional_headers):
        return FakeWebSocket(incoming=[])

    monkeypatch.setattr(rime_ws.websockets, "connect", fake_connect)

    client = RimeSpeechClient(speaker="cove")
    old_id = await client.speak("old text")
    await client.clear()

    new_id = await client.speak("new text")
    assert new_id != old_id

    client._ws._incoming = [
        _chunk_event(old_id, b"stale-late"),
        _chunk_event(new_id, b"fresh-chunk"),
        _done_event(new_id),
    ]
    events = [e async for e in client.events()]

    assert events[0] == {"type": "chunk_discarded", "contextId": old_id, "discardedChunks": 1}
    assert events[1] == {"type": "chunk", "contextId": new_id, "data": b"fresh-chunk"}
    assert events[2] == {"type": "done", "contextId": new_id}
    assert client.contexts[old_id].stale is True
    assert client.contexts[old_id].discarded_chunks == 1
    assert client.contexts[new_id].stale is False
    assert client.contexts[new_id].chunks_received == 1


async def test_clear_with_no_active_speech_is_a_noop():
    client = RimeSpeechClient(speaker="cove")
    result = await client.clear()
    assert result is None


async def test_connect_reopens_after_rime_closes_the_socket(monkeypatch):
    """Regression test (found during Phase 6 real verification): Rime
    closes its end of the ws3 socket once a context finishes. A second
    speak() on the same reused client must detect that and reconnect
    rather than trying to send on a dead socket (ConnectionClosedOK)."""
    connect_calls = []

    async def fake_connect(url, additional_headers):
        ws = FakeWebSocket(incoming=[])
        connect_calls.append(ws)
        return ws

    monkeypatch.setattr(rime_ws.websockets, "connect", fake_connect)

    client = RimeSpeechClient(speaker="cove")
    opened_first = await client.connect()
    assert opened_first is True
    assert len(connect_calls) == 1

    # connection still live -> connect() is a no-op
    opened_again = await client.connect()
    assert opened_again is False
    assert len(connect_calls) == 1

    # Rime closes its end (simulated) -> next connect() must reopen
    client._ws.close_code = 1000
    opened_after_close = await client.connect()
    assert opened_after_close is True
    assert len(connect_calls) == 2


async def test_malformed_event_json_is_skipped(monkeypatch):
    async def fake_connect(url, additional_headers):
        return FakeWebSocket(incoming=["not json at all", '{"type": "unknown_type"}'])

    monkeypatch.setattr(rime_ws.websockets, "connect", fake_connect)

    client = RimeSpeechClient(speaker="cove")
    await client.speak("text")
    events = [e async for e in client.events()]

    assert events == []  # both lines produced nothing to forward, no crash


async def test_completed_context_state_is_retained(monkeypatch):
    """Phase 7 needs a completed context's chunk/byte/discard counts still
    readable after 'done' — for the Heard Receipt and for reporting
    discardedChunks after the fact (phase7 prompt §21)."""
    async def fake_connect(url, additional_headers):
        return FakeWebSocket(incoming=[])

    monkeypatch.setattr(rime_ws.websockets, "connect", fake_connect)

    client = RimeSpeechClient(speaker="cove")
    context_id = await client.speak("text")
    client._ws._incoming = [_chunk_event(context_id, b"abcd"), _done_event(context_id)]
    _ = [e async for e in client.events()]

    ctx = client.contexts[context_id]
    assert ctx.chunks_received == 1
    assert ctx.bytes_received == 4
    assert ctx.discarded_chunks == 0
    assert ctx.stale is False
