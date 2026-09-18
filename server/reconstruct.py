"""Constrained reconstruction. One job: noisy ASR transcript + known
context in, validated Candidate[] out.

Not generic grammar correction — the model performs constrained inference
against a known world (the speaker's own vocabulary, situation, and recent
history), per RELAY_PLAYBOOK.md §4. The prompt below is that section's
prompt verbatim; do not paraphrase it here or duplicate it into docs.

Model: Phase 0 found `llama-3.3-70b-versatile` deprecated for the free/dev
tier (shutdown 2026-08-16); re-verified live at Phase 3 start that
`openai/gpt-oss-120b` remains Groq's current recommended migration target
— live, JSON-mode capable, 131K context, ~500 tps. Used here."""

import asyncio
import json
import os
from typing import Optional

import httpx

from server.config import settings
from server.models import Candidate

# Phase 8 evidence hook ONLY. Reads an env var no normal deploy sets, so it
# is a no-op (0ms) for every real user and every existing test — never
# read from server/config.py's credentialed Settings object, so it can
# never accidentally become a documented/relied-on production setting.
# evidence/at3_bargein.py sets this on the backend subprocess it launches,
# to deterministically stretch the reconstruction window so a floor-hold
# phrase and a real barge-in race can both be reproduced against live
# Rime, per RELAY_PLAYBOOK.md §5 AT-3's "inject a fixed 3000ms
# reconstruction delay". Isolated, and incapable of silently affecting
# the normal path since it defaults off.
_TEST_DELAY_ENV_VAR = "RELAY_TEST_RECONSTRUCT_DELAY_MS"

GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
RECONSTRUCTION_MODEL = "openai/gpt-oss-120b"

MAX_CANDIDATES = 3

# Verbatim from RELAY_PLAYBOOK.md §4 ("The reconstruction prompt").
PROMPT_TEMPLATE = """You reconstruct intended speech from noisy ASR output produced by a speaker
with dysarthria. The transcript is unreliable at the phoneme level but the
speaker's intent is usually recoverable.

KNOWN VOCABULARY (this speaker's ledger — strongly prefer these):
{ledger_terms}

SITUATION: {situation}
LAST 3 EXCHANGES: {history}
RAW ASR: "{transcript}"

Return JSON only:
{{
  "candidates": [
    {{"text": "...", "confidence": 0.0-1.0, "reasoning": "one short clause"}}
  ]
}}

Rules:
- Return 2-3 candidates, most likely first.
- Prefer ledger vocabulary over phonetically similar common words.
- Never invent a dosage, a drug, or a number not phonetically supported by
  the transcript. If a number is unclear, mark confidence below 0.5.
- Keep candidates short. These will be spoken aloud."""

FALLBACK_REASONING = "Reconstruction unavailable; showing raw ASR output."


class ReconstructionError(Exception):
    """Raised only for conditions the caller cannot recover from itself.
    Normal model flakiness (bad JSON, empty candidates) is handled inside
    reconstruct() via retry + fallback, not by raising."""


def build_prompt(transcript: str, ledger_terms: list[str], situation: str, history: list[str]) -> str:
    ledger_block = ", ".join(ledger_terms) if ledger_terms else "(none known)"
    history_block = " | ".join(history) if history else "(none — first turn)"
    return PROMPT_TEMPLATE.format(
        ledger_terms=ledger_block,
        situation=situation,
        history=history_block,
        transcript=transcript,
    )


async def _call_groq_json(prompt: str) -> str:
    """One call to the reconstruction model, JSON mode. Returns the raw
    string content of the model's reply (not yet parsed/validated). Isolated
    behind this function so unit tests can monkeypatch it without a network
    call, per the Phase 3 test strategy."""
    headers = {"Authorization": f"Bearer {settings.GROQ_API_KEY}"}
    body = {
        "model": RECONSTRUCTION_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await client.post(GROQ_CHAT_URL, headers=headers, json=body)
        except httpx.RequestError as e:
            raise ReconstructionError(f"Could not reach Groq reconstruction API: {type(e).__name__}") from e

    if resp.status_code != 200:
        raise ReconstructionError(f"Groq reconstruction failed with status {resp.status_code}")

    try:
        payload = resp.json()
        return payload["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise ReconstructionError("Groq reconstruction returned an unexpected response shape") from e


def _validate_candidates(raw: str) -> Optional[list[Candidate]]:
    """Parse + validate a model reply. Returns None (never raises) when the
    reply is unusable, so the caller can decide to retry or fall back."""
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return None

    if not isinstance(parsed, dict):
        return None
    raw_candidates = parsed.get("candidates")
    if not isinstance(raw_candidates, list):
        return None

    valid: list[Candidate] = []
    for item in raw_candidates:
        if len(valid) >= MAX_CANDIDATES:
            break
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        confidence = item.get("confidence")
        reasoning = item.get("reasoning")
        if not isinstance(text, str) or not text.strip():
            continue
        if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
            continue
        if not isinstance(reasoning, str):
            continue
        clamped_confidence = max(0.0, min(1.0, float(confidence)))
        try:
            candidate = Candidate(text=text, confidence=clamped_confidence, reasoning=reasoning)
        except ValueError:
            continue
        valid.append(candidate)

    return valid if valid else None


def _fallback_candidate(transcript: str) -> list[Candidate]:
    return [Candidate(text=transcript, confidence=0.0, reasoning=FALLBACK_REASONING)]


async def reconstruct(
    transcript: str,
    ledger_terms: list[str],
    situation: str,
    history: list[str],
) -> list[Candidate]:
    """transcript + known context -> validated Candidate[]. Never raises for
    ordinary model/provider flakiness — retries once, then falls back to the
    raw transcript at confidence 0.0 rather than fabricating certainty."""
    prompt = build_prompt(transcript, ledger_terms, situation, history)

    delay_ms = os.environ.get(_TEST_DELAY_ENV_VAR)
    if delay_ms:
        await asyncio.sleep(int(delay_ms) / 1000)

    for _attempt in range(2):
        try:
            raw = await _call_groq_json(prompt)
        except ReconstructionError:
            continue
        candidates = _validate_candidates(raw)
        if candidates is not None:
            return candidates

    return _fallback_candidate(transcript)
