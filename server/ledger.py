"""Personal pronunciation ledger: real Rime Coverage, real Rime Phonemize,
real SQLite persistence, and the injection helper that turns verified
ledger terms into Rime `{phoneme}` bracket strings before synthesis.

Every API-calling function here is plain async/sync Python, importable and
runnable outside FastAPI — Phase 8's evidence/at1_pronunciation.py reuses
these directly rather than re-implementing Coverage/Phonemize logic.

Verified against live Rime docs at Phase 5 implementation time:
  Coverage   POST https://users.rime.ai/oov         {"text": "..."}
             -> JSON array of words NOT in Rime's dictionary (word-level,
             not phrase-level — a multi-word term is covered only if none
             of its individual words appear in that array).
  Phonemize  POST https://optimize.rime.ai/phonemize
             body = raw audio bytes (not JSON, not multipart)
             -> {"audioId": "...", "phonemeString": "...", "authed": 1}
             phonemeString has NO braces — docs.rime.ai/api-reference/
             custom-pronunciation: "paste into your TTS request inside {}".
             This module adds them, exactly once.
"""

import json
import re
import sqlite3
import uuid
from pathlib import Path
from typing import Optional

import httpx

from server.config import settings
from server.models import LedgerCategory, LedgerEntry

DB_PATH = Path(__file__).parent / "relay.db"
FIXTURE_PATH = Path(__file__).parent.parent / "evidence" / "fixtures" / "vocabulary.json"

# Fixed id (not a real login) so the synthetic persona's seeded ledger is a
# stable, reachable fixture for manual verification and for Phase 8's AT-1
# script — distinct from any real browser's random anonymous userId.
DEMO_USER_ID = "demo-user"

COVERAGE_URL = "https://users.rime.ai/oov"
PHONEMIZE_URL = "https://optimize.rime.ai/phonemize"


class LedgerError(Exception):
    """Provider/lookup failure. Message is safe to surface — never
    includes the API key or a raw provider payload."""


# ─── persistence ──────────────────────────────────────────────────────────

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Create the table/index if missing. Safe to call on every startup —
    never drops or truncates existing rows."""
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ledger_entries (
                id              TEXT PRIMARY KEY,
                user_id         TEXT NOT NULL,
                word            TEXT NOT NULL,
                normalized_word TEXT NOT NULL,
                phoneme         TEXT NOT NULL DEFAULT '',
                category        TEXT NOT NULL,
                covered         INTEGER NOT NULL,
                verified        INTEGER NOT NULL DEFAULT 0,
                UNIQUE(user_id, normalized_word)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries(user_id)")


def normalize_word(word: str) -> str:
    """Whitespace-collapsed, lowercased form used for per-user uniqueness
    and for matching. Display form (`word`) is preserved separately."""
    return " ".join(word.split()).lower()


def _row_to_entry(row: sqlite3.Row) -> LedgerEntry:
    return LedgerEntry(
        id=row["id"],
        word=row["word"],
        phoneme=row["phoneme"],
        category=row["category"],
        covered=bool(row["covered"]),
        verified=bool(row["verified"]),
    )


def get_ledger(user_id: str) -> list[LedgerEntry]:
    """This user's entries only — never another user's."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, word, phoneme, category, covered, verified "
            "FROM ledger_entries WHERE user_id = ? ORDER BY rowid",
            (user_id,),
        ).fetchall()
    return [_row_to_entry(r) for r in rows]


def _get_own_entry(user_id: str, entry_id: str) -> Optional[sqlite3.Row]:
    """Row only if it exists AND belongs to user_id — the ownership check
    lives here so no caller can accidentally skip it."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, user_id, word, phoneme, category, covered, verified "
            "FROM ledger_entries WHERE id = ?",
            (entry_id,),
        ).fetchone()
    if row is None or row["user_id"] != user_id:
        return None
    return row


def get_entry(user_id: str, entry_id: str) -> Optional[LedgerEntry]:
    """One entry, but only if it belongs to `user_id` — None otherwise, so
    a caller can never distinguish "someone else's entry" from "no such
    entry" (same ownership behaviour set_phoneme() already relies on).
    Used by the pronunciation-preview path in server/session_ws.py, which
    must read the stored word and `{phoneme}` string from the database
    rather than trusting anything the browser sent."""
    row = _get_own_entry(user_id, entry_id)
    if row is None:
        return None
    return _row_to_entry(row)


def delete_entry(user_id: str, entry_id: str) -> bool:
    """Hard-delete this user's entry. True if a row was actually removed,
    False if it doesn't exist or belongs to a different user (caller maps
    that to 404 — one user must never be able to delete another's row by
    supplying its id).

    A real DELETE, not a soft-delete/tombstone: the whole point of the
    workflow this serves is "wrong pronunciation -> delete -> add again ->
    re-record", and a retained row would keep feeding a stale `{phoneme}`
    string to inject_pronunciations() and a stale term to reconstruction.
    The UNIQUE(user_id, normalized_word) constraint also has to be freed
    for the same word to be re-addable afterwards."""
    with _connect() as conn:
        cursor = conn.execute(
            "DELETE FROM ledger_entries WHERE id = ? AND user_id = ?",
            (entry_id, user_id),
        )
        return cursor.rowcount > 0


async def create_entry(user_id: str, word: str, category: LedgerCategory) -> LedgerEntry:
    """Same user + same normalized word -> returns/updates the existing
    entry rather than creating a duplicate.
    Different users adding the same word get their own independent rows."""
    normalized = normalize_word(word)

    with _connect() as conn:
        existing = conn.execute(
            "SELECT id, word, phoneme, category, covered, verified "
            "FROM ledger_entries WHERE user_id = ? AND normalized_word = ?",
            (user_id, normalized),
        ).fetchone()
    if existing is not None:
        return _row_to_entry(existing)

    covered = await check_coverage(word)  # real Rime call — never fabricated
    entry_id = uuid.uuid4().hex
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO ledger_entries "
                "(id, user_id, word, normalized_word, phoneme, category, covered, verified) "
                "VALUES (?, ?, ?, ?, '', ?, ?, 0)",
                (entry_id, user_id, word, normalized, category, int(covered)),
            )
    except sqlite3.IntegrityError:
        # Lost a race against a concurrent insert of the same normalized
        # word for this user — return what actually landed, not a duplicate.
        with _connect() as conn:
            existing = conn.execute(
                "SELECT id, word, phoneme, category, covered, verified "
                "FROM ledger_entries WHERE user_id = ? AND normalized_word = ?",
                (user_id, normalized),
            ).fetchone()
        return _row_to_entry(existing)

    return LedgerEntry(id=entry_id, word=word, phoneme="", category=category, covered=covered, verified=False)


async def set_phoneme(user_id: str, entry_id: str, audio_bytes: bytes, content_type: str = "audio/wav") -> Optional[LedgerEntry]:
    """Real Phonemize call, then store + mark verified. Returns None if the
    entry doesn't exist or belongs to a different user (caller maps that to
    404 — never let one user phonemize another's entry). verified is set to
    True only after the phoneme result is actually in hand — never before."""
    row = _get_own_entry(user_id, entry_id)
    if row is None:
        return None

    phoneme = await phonemize(audio_bytes, content_type)  # raises LedgerError on failure; verified stays False

    with _connect() as conn:
        conn.execute(
            "UPDATE ledger_entries SET phoneme = ?, verified = 1 WHERE id = ? AND user_id = ?",
            (phoneme, entry_id, user_id),
        )

    return LedgerEntry(
        id=row["id"], word=row["word"], phoneme=phoneme, category=row["category"],
        covered=bool(row["covered"]), verified=True,
    )


# ─── Rime Coverage ─────────────────────────────────────────────────────────

def _tokenize(text: str) -> list[str]:
    return [t.strip(".,!?;:\"'").lower() for t in text.split() if t.strip(".,!?;:\"'")]


async def _coverage_request(text: str) -> list:
    """The actual Rime call, isolated so unit tests can monkeypatch it
    without a network call (mirrors server/reconstruct.py's _call_groq_json
    seam)."""
    headers = {"Authorization": f"Bearer {settings.RIME_API_KEY}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.post(COVERAGE_URL, headers=headers, json={"text": text})
        except httpx.RequestError as e:
            raise LedgerError(f"Could not reach Rime Coverage API: {type(e).__name__}") from e

    if resp.status_code != 200:
        raise LedgerError(f"Rime Coverage API failed with status {resp.status_code}")

    try:
        uncovered = resp.json()
    except ValueError as e:
        raise LedgerError("Rime Coverage API returned an unparseable response") from e
    if not isinstance(uncovered, list):
        raise LedgerError("Rime Coverage API returned an unexpected response shape")
    return uncovered


async def check_coverage(text: str) -> bool:
    """True if every word in `text` is already in Rime's pronunciation
    dictionary (real https://users.rime.ai/oov call — never cached, never
    guessed from a hand-maintained list)."""
    uncovered = await _coverage_request(text)
    uncovered_words = {str(w).strip(".,!?;:\"'").lower() for w in uncovered}
    return not any(word in uncovered_words for word in _tokenize(text))


# ─── Rime Phonemize ────────────────────────────────────────────────────────

def normalize_phoneme(raw: str) -> str:
    """Rime's Phonemize response has no braces — add them exactly once,
    regardless of whether the caller already wrapped it."""
    inner = raw.strip()
    if inner.startswith("{") and inner.endswith("}"):
        inner = inner[1:-1]
    return "{" + inner + "}"


async def _phonemize_request(audio_bytes: bytes, content_type: str) -> dict:
    """The actual Rime call, isolated so unit tests can monkeypatch it
    without a network call."""
    headers = {"Authorization": f"Bearer {settings.RIME_API_KEY}", "Content-Type": content_type}
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await client.post(PHONEMIZE_URL, headers=headers, content=audio_bytes)
        except httpx.RequestError as e:
            raise LedgerError(f"Could not reach Rime Phonemize API: {type(e).__name__}") from e

    if resp.status_code != 200:
        raise LedgerError(f"Rime Phonemize API failed with status {resp.status_code}")

    try:
        return resp.json()
    except ValueError as e:
        raise LedgerError("Rime Phonemize API returned an unparseable response") from e


async def phonemize(audio_bytes: bytes, content_type: str = "audio/wav") -> str:
    """Real https://optimize.rime.ai/phonemize call. Body is the raw audio
    bytes (not JSON, not multipart — verified against live docs). Returns
    the normalized `{phoneme}` string."""
    payload = await _phonemize_request(audio_bytes, content_type)
    try:
        raw_phoneme = payload["phonemeString"]
    except (KeyError, TypeError) as e:
        raise LedgerError("Rime Phonemize API returned an unexpected response shape") from e

    if not isinstance(raw_phoneme, str) or not raw_phoneme.strip():
        raise LedgerError("Rime Phonemize API returned an empty phoneme string")

    return normalize_phoneme(raw_phoneme)


# ─── injection ─────────────────────────────────────────────────────────────

def inject_pronunciations(text: str, ledger_entries: list[LedgerEntry]) -> str:
    """candidate text -> text with verified ledger terms replaced by their
    `{phoneme}` bracket string, ready for mistv2 + phonemizeBetweenBrackets.

    Only `verified == True AND phoneme != ""` entries are eligible
    — a covered-but-unverified term is left as
    plain text and spoken with Rime's model-predicted pronunciation
    instead; an unverified term never gets a fabricated phoneme string.

    Matching is case-insensitive with word/phrase boundaries (so
    "metformin" doesn't match inside "metforminX"), longest term first so a
    multi-word phrase is matched before a shorter substring of it would be."""
    eligible = [e for e in ledger_entries if e.verified and e.phoneme]
    eligible.sort(key=lambda e: len(e.word), reverse=True)

    result = text
    for entry in eligible:
        pattern = re.compile(r"(?<!\w)" + re.escape(entry.word) + r"(?!\w)", re.IGNORECASE)
        result = pattern.sub(entry.phoneme, result)
    return result


# ─── seeding ───────────────────────────────────────────────────────────────

async def seed_demo_ledger_if_empty() -> None:
    """Seed DEMO_USER_ID's ledger from evidence/fixtures/vocabulary.json —
    once. If that user already has rows (a prior run seeded it, or a demo
    session has since edited it), do nothing: never reseed duplicates,
    never overwrite user-modified state.
    Real Coverage calls happen during seeding; a failure for one term is
    logged and that term is skipped rather than crashing startup."""
    with _connect() as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM ledger_entries WHERE user_id = ?", (DEMO_USER_ID,)
        ).fetchone()[0]
    if count > 0:
        return

    if not FIXTURE_PATH.exists():
        return

    with open(FIXTURE_PATH, encoding="utf-8") as f:
        fixture = json.load(f)

    for item in fixture:
        try:
            await create_entry(DEMO_USER_ID, item["word"], item["category"])
        except LedgerError as e:
            print(f"[ledger seed] skipped {item.get('word')!r}: {e}")
