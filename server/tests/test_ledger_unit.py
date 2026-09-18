"""Unit tests for server/ledger.py — Coverage parsing, phoneme
normalization, injection, boundary matching, and per-user isolation. No
network calls: `_coverage_request` / `_phonemize_request` are monkeypatched.
Uses a fresh temp SQLite file per test (never the real server/relay.db)."""

import pytest

from server import ledger
from server.models import LedgerEntry


@pytest.fixture(autouse=True)
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "DB_PATH", tmp_path / "test_relay.db")
    ledger.init_db()


# ─── Coverage parsing ──────────────────────────────────────────────────────

async def test_check_coverage_true_when_word_absent_from_uncovered_list(monkeypatch):
    async def fake_request(text):
        return ["someotherword"]

    monkeypatch.setattr(ledger, "_coverage_request", fake_request)
    assert await ledger.check_coverage("metformin") is True


async def test_check_coverage_false_when_word_present(monkeypatch):
    async def fake_request(text):
        return ["metformin"]

    monkeypatch.setattr(ledger, "_coverage_request", fake_request)
    assert await ledger.check_coverage("metformin") is False


async def test_check_coverage_multiword_false_if_any_word_uncovered(monkeypatch):
    async def fake_request(text):
        return ["raghunathan"]

    monkeypatch.setattr(ledger, "_coverage_request", fake_request)
    assert await ledger.check_coverage("Dr. Raghunathan") is False


async def test_check_coverage_multiword_true_if_all_words_covered(monkeypatch):
    async def fake_request(text):
        return []

    monkeypatch.setattr(ledger, "_coverage_request", fake_request)
    assert await ledger.check_coverage("Maple Street Pharmacy") is True


# ─── Phoneme normalization ──────────────────────────────────────────────────

def test_normalize_phoneme_adds_braces():
    assert ledger.normalize_phoneme("h0El1o !") == "{h0El1o !}"


def test_normalize_phoneme_does_not_double_wrap():
    assert ledger.normalize_phoneme("{h0El1o !}") == "{h0El1o !}"


async def test_phonemize_returns_braced_string(monkeypatch):
    async def fake_request(audio_bytes, content_type):
        return {"audioId": "abc", "phonemeString": "m1Etf1OrmIn", "authed": 1}

    monkeypatch.setattr(ledger, "_phonemize_request", fake_request)
    result = await ledger.phonemize(b"fake wav bytes")
    assert result == "{m1Etf1OrmIn}"


async def test_phonemize_rejects_empty_phoneme_string(monkeypatch):
    async def fake_request(audio_bytes, content_type):
        return {"audioId": "abc", "phonemeString": "", "authed": 1}

    monkeypatch.setattr(ledger, "_phonemize_request", fake_request)
    with pytest.raises(ledger.LedgerError):
        await ledger.phonemize(b"fake wav bytes")


# ─── Injection ──────────────────────────────────────────────────────────────

def _entry(word, phoneme, verified, covered=False, category="medication"):
    return LedgerEntry(id=word, word=word, phoneme=phoneme, category=category, covered=covered, verified=verified)


def test_injection_replaces_verified_term():
    entries = [_entry("metformin", "{m1Etf1OrmIn}", verified=True)]
    result = ledger.inject_pronunciations("I need a refill of metformin.", entries)
    assert result == "I need a refill of {m1Etf1OrmIn}."


def test_injection_skips_unverified_entry():
    entries = [_entry("metformin", "{m1Etf1OrmIn}", verified=False)]
    result = ledger.inject_pronunciations("I need a refill of metformin.", entries)
    assert result == "I need a refill of metformin."


def test_injection_skips_empty_phoneme_even_if_verified():
    entries = [_entry("metformin", "", verified=True)]
    result = ledger.inject_pronunciations("I need a refill of metformin.", entries)
    assert result == "I need a refill of metformin."


def test_injection_is_case_insensitive():
    entries = [_entry("metformin", "{m1Etf1OrmIn}", verified=True)]
    result = ledger.inject_pronunciations("METFORMIN please, not Metformin.", entries)
    assert result == "{m1Etf1OrmIn} please, not {m1Etf1OrmIn}."


def test_injection_does_not_match_partial_word():
    entries = [_entry("metformin", "{m1Etf1OrmIn}", verified=True)]
    result = ledger.inject_pronunciations("metforminX is not a real drug.", entries)
    assert result == "metforminX is not a real drug."


def test_injection_handles_multiword_phrase():
    entries = [_entry("Dr. Raghunathan", "{d1Okt0Er r1Ag2Un1At2an}", verified=True, category="clinician")]
    result = ledger.inject_pronunciations("Please call Dr. Raghunathan today.", entries)
    assert result == "Please call {d1Okt0Er r1Ag2Un1At2an} today."


def test_injection_prefers_longer_phrase_over_substring():
    entries = [
        _entry("Sharma", "{sh1Arm2ah}", verified=True, category="name"),
        _entry("Ananya Sharma", "{ah1nUn2yah sh1Arm2ah}", verified=True, category="name"),
    ]
    result = ledger.inject_pronunciations("Ananya Sharma is here.", entries)
    assert result == "{ah1nUn2yah sh1Arm2ah} is here."


# ─── Persistence + user isolation ──────────────────────────────────────────

async def test_create_entry_sets_covered_from_coverage(monkeypatch):
    monkeypatch.setattr(ledger, "check_coverage", lambda text: _async_true())
    entry = await ledger.create_entry("user-a", "Metformin", "medication")
    assert entry.covered is True
    assert entry.phoneme == ""
    assert entry.verified is False


async def test_create_entry_duplicate_returns_same_entry(monkeypatch):
    monkeypatch.setattr(ledger, "check_coverage", lambda text: _async_true())
    first = await ledger.create_entry("user-a", "Metformin", "medication")
    second = await ledger.create_entry("user-a", "metformin", "medication")  # different case/whitespace
    assert first.id == second.id


async def test_different_users_get_independent_entries(monkeypatch):
    monkeypatch.setattr(ledger, "check_coverage", lambda text: _async_true())
    a = await ledger.create_entry("user-a", "Metformin", "medication")
    b = await ledger.create_entry("user-b", "Metformin", "medication")
    assert a.id != b.id


async def test_user_cannot_see_another_users_ledger(monkeypatch):
    monkeypatch.setattr(ledger, "check_coverage", lambda text: _async_true())
    await ledger.create_entry("user-a", "Metformin", "medication")
    assert ledger.get_ledger("user-b") == []
    assert len(ledger.get_ledger("user-a")) == 1


async def test_user_cannot_phonemize_another_users_entry(monkeypatch):
    monkeypatch.setattr(ledger, "check_coverage", lambda text: _async_true())
    entry = await ledger.create_entry("user-a", "Metformin", "medication")

    async def fake_phonemize(audio_bytes, content_type):
        return "{m1Etf1OrmIn}"

    monkeypatch.setattr(ledger, "phonemize", fake_phonemize)
    result = await ledger.set_phoneme("user-b", entry.id, b"wav bytes")
    assert result is None

    still_unverified = ledger.get_ledger("user-a")[0]
    assert still_unverified.verified is False


async def test_set_phoneme_marks_verified_only_after_success(monkeypatch):
    monkeypatch.setattr(ledger, "check_coverage", lambda text: _async_true())
    entry = await ledger.create_entry("user-a", "Metformin", "medication")

    async def fake_phonemize(audio_bytes, content_type):
        return "{m1Etf1OrmIn}"

    monkeypatch.setattr(ledger, "phonemize", fake_phonemize)
    updated = await ledger.set_phoneme("user-a", entry.id, b"wav bytes")
    assert updated.verified is True
    assert updated.phoneme == "{m1Etf1OrmIn}"


async def _async_true():
    return True
