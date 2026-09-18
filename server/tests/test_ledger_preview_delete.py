"""Post-Phase-8 Voice Ledger enhancements.

Two features, both scoped to the ledger and nothing else:

  * pronunciation preview — `kind: "preview"` on /ws/tts, which loads one
    ledger row server-side and speaks its stored pronunciation through the
    existing Rime mistv2 pipeline.
  * DELETE /api/ledger/entry/{id} — a real delete, so a wrong pronunciation
    can be removed and the same word added and re-recorded.

Preview tests monkeypatch server.session_ws.RimeSpeechClient (no real Rime
connection) and server.session_ws.get_entry (no real database); delete
tests run against a fresh temp SQLite file with the provider calls faked at
the server.ledger level, exactly like test_ledger_api.py.
"""

import pytest
from fastapi.testclient import TestClient

from server import ledger, session_ws
from server.config import settings
from server.main import app
from server.models import LedgerEntry
from server.rime_ws import _connection_url


# ═══ Pronunciation preview ════════════════════════════════════════════════


class FakeRimeClient:
    """Records what speak() was called with; replays a fixed chunk+done
    sequence. Same shape as test_session_ws.py's fake."""

    def __init__(self, speaker: str):
        self.speaker = speaker
        self.contexts = {}
        self.current_context_id = None
        self.speak_calls: list[str] = []
        self._pending_events: list[dict] = []

    async def connect(self) -> bool:
        # True == "a fresh connection was opened", which makes session_ws
        # restart its events()-forwarding task. Real Rime closes its end of
        # the socket after every finished context, so this is also what a
        # real second speak() on one connection does — and it is what lets
        # a test send two speak() messages down one /ws/tts connection.
        return True

    async def speak(self, text: str) -> str:
        self.speak_calls.append(text)
        context_id = f"ctx_fake_{len(self.speak_calls)}"
        self.current_context_id = context_id

        class _Ctx:
            discarded_chunks = 0

        self.contexts[context_id] = _Ctx()
        self._pending_events = [
            {"type": "chunk", "contextId": context_id, "data": b"preview-audio-bytes"},
            {"type": "done", "contextId": context_id},
        ]
        return context_id

    async def clear(self):
        return self.current_context_id

    async def events(self):
        for event in self._pending_events:
            yield event

    async def close(self):
        pass


VERIFIED_ENTRY = LedgerEntry(
    id="e1", word="Metformin", phoneme="{m1Etf1OrmIn}",
    category="medication", covered=False, verified=True,
)

UNVERIFIED_ENTRY = LedgerEntry(
    id="e2", word="Lisinopril", phoneme="",
    category="medication", covered=False, verified=False,
)


def _preview_setup(monkeypatch, entry):
    """A TestClient whose ledger lookup returns `entry` only for userId
    "owner" — the ownership contract server/ledger.py's get_entry()
    enforces against the real database."""
    created: list[FakeRimeClient] = []

    def factory(speaker: str) -> FakeRimeClient:
        instance = FakeRimeClient(speaker)
        created.append(instance)
        return instance

    monkeypatch.setattr(session_ws, "RimeSpeechClient", factory)

    lookups: list[tuple[str, str]] = []

    def fake_get_entry(user_id: str, entry_id: str):
        lookups.append((user_id, entry_id))
        if entry is None:
            return None
        return entry if (user_id == "owner" and entry_id == entry.id) else None

    monkeypatch.setattr(session_ws, "get_entry", fake_get_entry)
    return TestClient(app), created, lookups


def _preview_msg(entry_id: str, text: str = "Metformin", voice: str = "Cove", confidence: float = 1.0):
    return {
        "type": "speak", "text": text, "voice": voice,
        "confidence": confidence, "kind": "preview", "entryId": entry_id,
    }


def _ws(test_client, query: str = "?userId=owner"):
    return test_client.websocket_connect(f"/ws/tts{query}", headers={"origin": settings.ALLOWED_ORIGIN})


def test_preview_of_verified_entry_speaks_its_stored_phoneme(monkeypatch):
    """The entire point of the verification UI: a verified entry previews
    with the phoneme string a real sentence would inject, rather than
    asking Rime to guess the pronunciation again."""
    test_client, created, _ = _preview_setup(monkeypatch, VERIFIED_ENTRY)
    with _ws(test_client) as ws:
        ws.send_json(_preview_msg("e1"))
        first = ws.receive_json()
        ws.receive_json()

    assert first["type"] == "audio_chunk"
    assert created[0].speak_calls == ["{m1Etf1OrmIn}"]


def test_preview_of_unverified_entry_uses_the_plain_word(monkeypatch):
    """No fabricated phoneme for a pending entry — it gets Rime's own
    model-predicted pronunciation of the visible word."""
    test_client, created, _ = _preview_setup(monkeypatch, UNVERIFIED_ENTRY)
    with _ws(test_client) as ws:
        ws.send_json(_preview_msg("e2", text="Lisinopril"))
        ws.receive_json()
        ws.receive_json()

    spoken = created[0].speak_calls[0]
    assert spoken == "Lisinopril"
    assert "{" not in spoken


def test_preview_of_verified_entry_with_empty_phoneme_uses_the_plain_word(monkeypatch):
    """verified == True but phoneme == "" is still not eligible for
    injection (server/ledger.py requires both)."""
    entry = LedgerEntry(
        id="e3", word="Raghunathan", phoneme="",
        category="clinician", covered=False, verified=True,
    )
    test_client, created, _ = _preview_setup(monkeypatch, entry)
    with _ws(test_client) as ws:
        ws.send_json({**_preview_msg("e3", text="Raghunathan")})
        ws.receive_json()
        ws.receive_json()

    assert created[0].speak_calls == ["Raghunathan"]


def test_preview_ignores_browser_supplied_text(monkeypatch):
    """`text` on a preview message is only the label the browser renders.
    The server takes the word from the loaded row, so a tampered message
    can't make it speak an arbitrary bracket string."""
    test_client, created, _ = _preview_setup(monkeypatch, UNVERIFIED_ENTRY)
    with _ws(test_client) as ws:
        ws.send_json(_preview_msg("e2", text="{tOtAl1yFAk3}"))
        ws.receive_json()
        ws.receive_json()

    assert created[0].speak_calls == ["Lisinopril"]


def test_preview_only_reads_the_connections_own_user_entry(monkeypatch):
    """User B supplying user A's entry id gets the ownership-safe failure
    and no synthesis at all."""
    test_client, created, lookups = _preview_setup(monkeypatch, VERIFIED_ENTRY)
    with _ws(test_client, "?userId=intruder") as ws:
        ws.send_json(_preview_msg("e1"))
        reply = ws.receive_json()

    assert reply["type"] == "error"
    assert lookups == [("intruder", "e1")]  # scoped to the connection's own userId
    assert created == []  # Rime never contacted


def test_preview_without_userid_is_refused(monkeypatch):
    test_client, created, lookups = _preview_setup(monkeypatch, VERIFIED_ENTRY)
    with _ws(test_client, "") as ws:
        ws.send_json(_preview_msg("e1"))
        reply = ws.receive_json()

    assert reply["type"] == "error"
    assert lookups == []
    assert created == []


def test_preview_of_missing_entry_errors_without_synthesis(monkeypatch):
    test_client, created, _ = _preview_setup(monkeypatch, None)
    with _ws(test_client) as ws:
        ws.send_json(_preview_msg("nope", text="Gone"))
        reply = ws.receive_json()

    assert reply["type"] == "error"
    assert created == []


def test_preview_uses_the_voices_py_speaker_mapping(monkeypatch):
    """'Meadow' is not a real mistv2 speaker — server/voices.py maps it to
    'breeze'. Preview goes through that same mapping rather than assuming
    display name == speaker ID."""
    test_client, created, _ = _preview_setup(monkeypatch, VERIFIED_ENTRY)
    with _ws(test_client) as ws:
        ws.send_json(_preview_msg("e1", voice="Meadow"))
        ws.receive_json()
        ws.receive_json()

    assert created[0].speaker == "breeze"


def test_preview_uses_mistv2_and_the_bracket_phoneme_flags():
    """Preview reuses RimeSpeechClient unchanged, so every preview request
    carries modelId=mistv2 — omitting it silently routes to Mist v3, which
    ignores {phoneme} strings entirely."""
    url = _connection_url("breeze")
    assert "modelId=mistv2" in url
    assert "phonemizeBetweenBrackets=true" in url
    assert "pauseBetweenBrackets=true" in url
    assert "audioFormat=mp3" in url
    assert "speaker=breeze" in url


def test_preview_is_not_confidence_gated(monkeypatch):
    """A preview is not a candidate: the Phase 6 silent branch must not
    swallow it, and no prosody transform may be applied to it."""
    test_client, created, _ = _preview_setup(monkeypatch, VERIFIED_ENTRY)
    with _ws(test_client) as ws:
        ws.send_json(_preview_msg("e1", confidence=0.0))
        first = ws.receive_json()
        ws.receive_json()

    assert first["type"] == "audio_chunk"
    assert created[0].speak_calls == ["{m1Etf1OrmIn}"]  # no "<300>" prefix, no "?" suffix


def test_preview_emits_no_heard_entry(monkeypatch):
    """A pronunciation audition is not conversational speech and must never
    reach the Heard Receipt."""
    test_client, _, _ = _preview_setup(monkeypatch, VERIFIED_ENTRY)
    with _ws(test_client) as ws:
        ws.send_json(_preview_msg("e1"))
        received = [ws.receive_json(), ws.receive_json()]

    assert [m["type"] for m in received] == ["audio_chunk", "synthesis_done"]


def test_preview_does_not_mutate_the_entry(monkeypatch):
    """Previewing is read-only — a pending entry stays pending, and a
    verified one keeps exactly the phoneme it had."""
    entry = LedgerEntry(
        id="e2", word="Lisinopril", phoneme="",
        category="medication", covered=False, verified=False,
    )
    test_client, _, _ = _preview_setup(monkeypatch, entry)
    with _ws(test_client) as ws:
        ws.send_json(_preview_msg("e2", text="Lisinopril"))
        ws.receive_json()
        ws.receive_json()

    assert entry.verified is False
    assert entry.phoneme == ""


def test_preview_without_entry_id_is_rejected(monkeypatch):
    test_client, created, _ = _preview_setup(monkeypatch, VERIFIED_ENTRY)
    with _ws(test_client) as ws:
        ws.send_json({"type": "speak", "text": "Metformin", "voice": "Cove", "confidence": 1.0, "kind": "preview"})
        reply = ws.receive_json()

    assert reply["type"] == "error"
    assert created == []


def test_entry_id_on_a_candidate_message_is_rejected(monkeypatch):
    """Backwards-compatibility guard the other way round: entryId is only
    meaningful for a preview and is never silently accepted elsewhere."""
    test_client, _, _ = _preview_setup(monkeypatch, VERIFIED_ENTRY)
    with _ws(test_client) as ws:
        ws.send_json({"type": "speak", "text": "hi", "voice": "Cove", "confidence": 0.9, "entryId": "e1"})
        reply = ws.receive_json()

    assert reply["type"] == "error"


def test_candidate_and_holding_paths_are_unchanged_by_the_preview_kind(monkeypatch):
    """Regression: adding the preview branch must not alter how a plain
    candidate or a floor-hold phrase is handled."""
    test_client, created, _ = _preview_setup(monkeypatch, VERIFIED_ENTRY)
    monkeypatch.setattr(session_ws, "get_ledger", lambda user_id: [])

    with _ws(test_client) as ws:
        ws.send_json({"type": "speak", "text": "I need a refill.", "voice": "Cove", "confidence": 0.9})
        ws.receive_json()
        ws.receive_json()
        ws.send_json({"type": "speak", "text": "One moment.", "voice": "Cove", "confidence": 0.0, "kind": "holding"})
        ws.receive_json()
        ws.receive_json()

    assert created[0].speak_calls == ["I need a refill.", "One moment."]


# ═══ Delete ═══════════════════════════════════════════════════════════════


@pytest.fixture(autouse=True)
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "DB_PATH", tmp_path / "test_relay.db")
    ledger.init_db()


@pytest.fixture
def client(temp_db, monkeypatch):
    async def fake_check_coverage(text):
        return "uncovered" not in text.lower()

    async def fake_phonemize(audio_bytes, content_type):
        return "{f1Ak3ph0onEm}"

    monkeypatch.setattr(ledger, "check_coverage", fake_check_coverage)
    monkeypatch.setattr(ledger, "phonemize", fake_phonemize)
    return TestClient(app)


def _create(client, user_id: str, word: str, category: str = "medication") -> str:
    res = client.post(
        "/api/ledger/entry", params={"userId": user_id},
        json={"word": word, "category": category},
    )
    assert res.status_code == 200
    return res.json()["id"]


def _words(client, user_id: str) -> list[str]:
    return [e["word"] for e in client.get("/api/ledger", params={"userId": user_id}).json()]


def test_delete_removes_the_users_own_entry(client):
    entry_id = _create(client, "u1", "Metformin")
    res = client.delete(f"/api/ledger/entry/{entry_id}", params={"userId": "u1"})
    assert res.status_code == 204


def test_deleted_entry_is_gone_from_get_ledger(client):
    entry_id = _create(client, "u1", "Metformin")
    _create(client, "u1", "Lisinopril")

    client.delete(f"/api/ledger/entry/{entry_id}", params={"userId": "u1"})

    assert _words(client, "u1") == ["Lisinopril"]


def test_deleting_one_entry_leaves_every_other_untouched(client):
    keep_a = _create(client, "u1", "Amlodipine")
    target = _create(client, "u1", "Metformin")
    keep_b = _create(client, "u1", "Ananya Sharma", "name")

    client.delete(f"/api/ledger/entry/{target}", params={"userId": "u1"})

    remaining = client.get("/api/ledger", params={"userId": "u1"}).json()
    assert [e["id"] for e in remaining] == [keep_a, keep_b]
    assert all(e["id"] != target for e in remaining)


def test_deleting_a_missing_entry_returns_404(client):
    res = client.delete("/api/ledger/entry/does-not-exist", params={"userId": "u1"})
    assert res.status_code == 404


def test_deleting_an_already_deleted_entry_returns_404(client):
    entry_id = _create(client, "u1", "Metformin")
    assert client.delete(f"/api/ledger/entry/{entry_id}", params={"userId": "u1"}).status_code == 204
    assert client.delete(f"/api/ledger/entry/{entry_id}", params={"userId": "u1"}).status_code == 404


def test_cross_user_deletion_is_refused(client):
    """User A: entry X. User B: entry Y. A must not be able to delete Y by
    supplying Y's id — and Y must survive intact."""
    entry_x = _create(client, "userA", "Metformin")
    entry_y = _create(client, "userB", "Lisinopril")

    res = client.delete(f"/api/ledger/entry/{entry_y}", params={"userId": "userA"})

    assert res.status_code == 404
    assert _words(client, "userB") == ["Lisinopril"]
    assert _words(client, "userA") == ["Metformin"]
    assert entry_x != entry_y


def test_delete_requires_a_user_id(client):
    entry_id = _create(client, "u1", "Metformin")
    res = client.delete(f"/api/ledger/entry/{entry_id}")
    assert res.status_code == 422
    assert _words(client, "u1") == ["Metformin"]  # nothing removed


def test_deleted_phoneme_is_no_longer_available_to_synthesis(client):
    """Phase 3/5 both read the user's *current* ledger, so a deleted term
    must vanish from injection and from the reconstruction vocabulary the
    moment the delete succeeds."""
    entry_id = _create(client, "u1", "Metformin")
    phonemized = client.post(
        "/api/ledger/phonemize", params={"userId": "u1"},
        data={"id": entry_id}, files={"audio": ("p.wav", b"RIFFfake", "audio/wav")},
    ).json()
    assert phonemized["verified"] is True

    before = ledger.get_ledger("u1")
    assert ledger.inject_pronunciations("I need Metformin.", before) == "I need {f1Ak3ph0onEm}."

    client.delete(f"/api/ledger/entry/{entry_id}", params={"userId": "u1"})

    after = ledger.get_ledger("u1")
    assert after == []
    assert ledger.inject_pronunciations("I need Metformin.", after) == "I need Metformin."


def test_deleted_entry_can_no_longer_be_previewed(client):
    """get_entry() is what the preview path loads from — a deleted row is
    unreachable there too, not just in the list view."""
    entry_id = _create(client, "u1", "Metformin")
    assert ledger.get_entry("u1", entry_id) is not None

    client.delete(f"/api/ledger/entry/{entry_id}", params={"userId": "u1"})

    assert ledger.get_entry("u1", entry_id) is None


def test_same_word_can_be_added_again_after_deletion(client):
    """The delete -> add -> re-record workflow: the UNIQUE(user_id,
    normalized_word) constraint must be freed, and the new row must start
    clean (no phoneme, not verified) rather than resurrecting the old one."""
    first_id = _create(client, "u1", "Metformin")
    client.post(
        "/api/ledger/phonemize", params={"userId": "u1"},
        data={"id": first_id}, files={"audio": ("p.wav", b"RIFFfake", "audio/wav")},
    )
    client.delete(f"/api/ledger/entry/{first_id}", params={"userId": "u1"})

    res = client.post(
        "/api/ledger/entry", params={"userId": "u1"},
        json={"word": "Metformin", "category": "medication"},
    )
    assert res.status_code == 200
    recreated = res.json()

    assert recreated["id"] != first_id
    assert recreated["word"] == "Metformin"
    assert recreated["phoneme"] == ""
    assert recreated["verified"] is False


def test_re_recorded_entry_gets_a_new_verified_phoneme(client):
    """Completing the workflow end to end: delete -> add -> phonemize ->
    verified, with the new phoneme replacing the old one in synthesis."""
    first_id = _create(client, "u1", "Metformin")
    client.delete(f"/api/ledger/entry/{first_id}", params={"userId": "u1"})

    new_id = _create(client, "u1", "Metformin")
    updated = client.post(
        "/api/ledger/phonemize", params={"userId": "u1"},
        data={"id": new_id}, files={"audio": ("p.wav", b"RIFFfake", "audio/wav")},
    ).json()

    assert updated["verified"] is True
    assert updated["phoneme"] == "{f1Ak3ph0onEm}"
    assert ledger.inject_pronunciations("Metformin", ledger.get_ledger("u1")) == "{f1Ak3ph0onEm}"


# ─── delete_entry() unit-level ownership ─────────────────────────────────


async def test_delete_entry_returns_false_for_another_users_row(temp_db, monkeypatch):
    """Ownership is enforced in server/ledger.py itself, not only in the
    route — no caller can delete across users by skipping the check."""
    async def fake_check_coverage(_text):
        return True

    monkeypatch.setattr(ledger, "check_coverage", fake_check_coverage)
    entry = await ledger.create_entry("userB", "Lisinopril", "medication")

    assert ledger.delete_entry("userA", entry.id) is False
    assert ledger.get_entry("userB", entry.id) is not None
    assert ledger.delete_entry("userB", entry.id) is True
    assert ledger.get_entry("userB", entry.id) is None


async def test_get_entry_refuses_another_users_row(temp_db, monkeypatch):
    """Same ownership contract on the read the preview path uses."""
    async def fake_check_coverage(_text):
        return True

    monkeypatch.setattr(ledger, "check_coverage", fake_check_coverage)
    entry = await ledger.create_entry("userB", "Lisinopril", "medication")

    assert ledger.get_entry("userA", entry.id) is None
    assert ledger.get_entry("userB", entry.id).word == "Lisinopril"
