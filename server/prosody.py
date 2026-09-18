"""Confidence-gated prosody. One job: convert a candidate's confidence into
a deterministic delivery decision (and, for the question path, the text
transformation Rime needs) — independent of FastAPI, Rime, and the ledger.

Thresholds mirror the frontend exactly
(web/src/pages/SessionPage.tsx's getConfidenceLabel/getDeliveryMode) —
this is not a second, competing threshold system:

    > 0.85   -> statement
    >= 0.5   -> question
    < 0.5    -> silent

High/medium/low are confidence *labels* (the frontend's concern); statement/
question/silent are delivery *modes* (this module's concern) — kept
separate on purpose."""

from typing import Literal, NamedTuple

DeliveryMode = Literal["statement", "question", "silent"]

# Rime's custom-pause syntax (pauseBetweenBrackets: true) — RELAY_PLAYBOOK.md
# §4's confidence-gated prosody section.
PAUSE_MARKER = "<300>"


class ProsodyResult(NamedTuple):
    mode: DeliveryMode
    text: str
    should_speak: bool


def decide_delivery(confidence: float) -> DeliveryMode:
    """The exact boundaries the frontend already uses — do not adjust
    without adjusting SessionPage.tsx's getConfidenceLabel/getDeliveryMode
    to match, or the two sides would disagree on the same number."""
    if confidence > 0.85:
        return "statement"
    elif confidence >= 0.5:
        return "question"
    else:
        return "silent"


def _strip_trailing_terminal_punctuation(text: str) -> str:
    return text.rstrip().rstrip(".!?").rstrip()


def apply_prosody(text: str, confidence: float) -> ProsodyResult:
    """candidate text + confidence -> delivery decision.

    statement (>0.85): text unchanged — no pauses, qualifiers, or added
    punctuation.

    question (0.5-0.85): there is no uncertain-span field on Candidate
    (text, confidence, reasoning only), so this uses the
    playbook's other documented form, a whole-candidate confirmation:
    "<300>{text}?" — pause before the whole utterance, terminal punctuation
    normalized to a single "?" so Rime's rising intonation applies to the
    entire confirmation rather than a guessed sub-span.

    silent (<0.5): should_speak=False. The caller (server/session_ws.py)
    must not send anything to Rime for this result — a safety property,
    not a suggestion."""
    mode = decide_delivery(confidence)

    if mode == "silent":
        return ProsodyResult(mode="silent", text=text, should_speak=False)

    if mode == "statement":
        return ProsodyResult(mode="statement", text=text, should_speak=True)

    # question
    base = _strip_trailing_terminal_punctuation(text)
    transformed = f"{PAUSE_MARKER}{base}?"
    return ProsodyResult(mode="question", text=transformed, should_speak=True)
