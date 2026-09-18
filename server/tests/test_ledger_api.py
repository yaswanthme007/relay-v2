"""API tests for GET /api/ledger, POST /api/ledger/entry, POST
/api/ledger/phonemize. Provider calls (Coverage/Phonemize) are mocked at
the server.ledger level; a fresh temp SQLite file is used per test."""

import pytest
from fastapi.testclient import TestClient

from server import ledger
from server.main import app


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


def test_get_ledger_empty_for_new_user(client):
    res = client.get("/api/ledger", params={"userId": "u1"})
    assert res.status_code == 200
    assert res.json() == []


def test_get_ledger_requires_userid(client):
    res = client.get("/api/ledger")
    assert res.status_code == 422


def test_create_entry_returns_full_ledger_entry_shape(client):
    res = client.post(
        "/api/ledger/entry",
        params={"userId": "u1"},
        json={"word": "Metformin", "category": "medication"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["word"] == "Metformin"
    assert body["category"] == "medication"
    assert body["covered"] is True
    assert body["phoneme"] == ""
    assert body["verified"] is False
    assert "id" in body


def test_create_entry_covered_false_for_uncovered_term(client):
    res = client.post(
        "/api/ledger/entry",
        params={"userId": "u1"},
        json={"word": "uncovered term", "category": "phrase"},
    )
    assert res.status_code == 200
    assert res.json()["covered"] is False


def test_created_entry_appears_in_get_ledger(client):
    client.post("/api/ledger/entry", params={"userId": "u1"}, json={"word": "Metformin", "category": "medication"})
    res = client.get("/api/ledger", params={"userId": "u1"})
    words = [e["word"] for e in res.json()]
    assert "Metformin" in words


def test_user_isolation_on_get(client):
    client.post("/api/ledger/entry", params={"userId": "u1"}, json={"word": "Metformin", "category": "medication"})
    res = client.get("/api/ledger", params={"userId": "u2"})
    assert res.json() == []


def test_phonemize_sets_verified_and_phoneme(client):
    created = client.post(
        "/api/ledger/entry", params={"userId": "u1"}, json={"word": "Metformin", "category": "medication"}
    ).json()

    res = client.post(
        "/api/ledger/phonemize",
        params={"userId": "u1"},
        data={"id": created["id"]},
        files={"audio": ("pronunciation.wav", b"fake wav bytes", "audio/wav")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["verified"] is True
    assert body["phoneme"] == "{f1Ak3ph0onEm}"


def test_phonemize_rejects_other_users_entry(client):
    created = client.post(
        "/api/ledger/entry", params={"userId": "u1"}, json={"word": "Metformin", "category": "medication"}
    ).json()

    res = client.post(
        "/api/ledger/phonemize",
        params={"userId": "u2"},
        data={"id": created["id"]},
        files={"audio": ("pronunciation.wav", b"fake wav bytes", "audio/wav")},
    )
    assert res.status_code == 404


def test_phonemize_missing_entry_returns_404(client):
    res = client.post(
        "/api/ledger/phonemize",
        params={"userId": "u1"},
        data={"id": "does-not-exist"},
        files={"audio": ("pronunciation.wav", b"fake wav bytes", "audio/wav")},
    )
    assert res.status_code == 404


def test_phonemize_empty_audio_rejected(client):
    created = client.post(
        "/api/ledger/entry", params={"userId": "u1"}, json={"word": "Metformin", "category": "medication"}
    ).json()

    res = client.post(
        "/api/ledger/phonemize",
        params={"userId": "u1"},
        data={"id": created["id"]},
        files={"audio": ("pronunciation.wav", b"", "audio/wav")},
    )
    assert res.status_code == 422


def test_create_entry_rejects_empty_word(client):
    res = client.post("/api/ledger/entry", params={"userId": "u1"}, json={"word": "   ", "category": "medication"})
    assert res.status_code == 422


def test_create_entry_rejects_invalid_category(client):
    res = client.post("/api/ledger/entry", params={"userId": "u1"}, json={"word": "Metformin", "category": "bogus"})
    assert res.status_code == 422
