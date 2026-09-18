"""Pydantic models. These mirror the frontend TypeScript interfaces exactly
— the frontend is the contract, these models follow it, not
the reverse.

Source of truth for each shape:
  Candidate    -> web/src/pages/SessionPage.tsx
  HeardEntry   -> web/src/pages/SessionPage.tsx
  LedgerEntry  -> web/src/pages/LedgerPage.tsx

Wire-contract models below (TurnResponse, the /ws/tts message shapes, and
the ledger request/response bodies) mirror the documented /ws/tts and
/api wire contract. No route implements them yet — Phase 1 registers only
GET /health."""

from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

Situation = Literal["pharmacy", "clinic", "home", "phone"]
LedgerCategory = Literal["name", "medication", "clinician", "location", "phrase"]
HeardStatus = Literal["complete", "cut", "pending"]

# HH:MM:SS, 24-hour, as used by HeardEntry.time.
TIME_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$"


class Candidate(BaseModel):
    text: str
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str


class HeardEntry(BaseModel):
    time: str = Field(pattern=TIME_PATTERN)
    status: HeardStatus
    text: str
    cutAt: Optional[str] = None

    @model_validator(mode="after")
    def _cut_at_only_when_cut(self) -> "HeardEntry":
        if self.cutAt is not None and self.status != "cut":
            raise ValueError('cutAt is only meaningful when status == "cut"')
        return self


class LedgerEntry(BaseModel):
    id: str
    word: str
    phoneme: str  # full Rime bracket string e.g. "{m1Etf1OrmIn}", or "" if not yet phonemized
    category: LedgerCategory
    covered: bool
    verified: bool


class HealthResponse(BaseModel):
    status: Literal["ok"]


# ─── Wire contract (documented shape, no route yet) ─────────────────────────────


class TurnResponse(BaseModel):
    transcript: str
    candidates: list[Candidate]


class SpeakMessage(BaseModel):
    type: Literal["speak"]
    text: str
    voice: str
    # Phase 6: the server must be able to enforce the silent branch itself
    # rather than trusting the browser not to call speak() on a low-
    # confidence candidate — required, not
    # optional, since a missing value must never default to "speak anyway".
    confidence: float = Field(ge=0.0, le=1.0)
    pauseHint: Optional[int] = None
    # Phase 7: floor-hold preload synthesizes plain cached phrases, not
    # candidates. "holding" bypasses confidence/prosody and ledger
    # injection entirely (playbook: floor-holding is not a candidate) —
    # default keeps every Phase 1-6 caller's wire shape unchanged.
    #
    # Post-Phase-8: "preview" is a Voice Ledger pronunciation check, not
    # conversational speech. It is deliberately its own kind rather than
    # being folded into "candidate" or "holding": a preview must never be
    # confidence-gated or prosody-transformed (it is not a candidate), and
    # it must go through the per-user ledger's verified-phoneme rules
    # (which "holding" bypasses entirely). It also never produces a Heard
    # Receipt entry — the receipt describes what the user actually chose
    # to relay, not a pronunciation audition.
    kind: Literal["candidate", "holding", "preview"] = "candidate"
    # Which ledger row to preview. Required for kind == "preview" and
    # meaningless otherwise. The server loads that row itself and takes
    # the word and the `{phoneme}` string from the database — `text` on a
    # preview message is only the display word the browser happens to be
    # rendering, and is never trusted as the pronunciation source (a
    # browser-supplied phoneme would let one user preview another user's
    # pronunciation data, or inject an arbitrary bracket string).
    entryId: Optional[str] = None

    @model_validator(mode="after")
    def _entry_id_only_for_preview(self) -> "SpeakMessage":
        if self.kind == "preview" and not self.entryId:
            raise ValueError('entryId is required when kind == "preview"')
        if self.kind != "preview" and self.entryId is not None:
            raise ValueError('entryId is only meaningful when kind == "preview"')
        return self


class ClearMessage(BaseModel):
    type: Literal["clear"]


class HeardReportMessage(BaseModel):
    """Browser -> server, Phase 7. The browser is the only thing that
    actually knows what reached the speakers (AudioContext playback state);
    the server only knows context IDs/staleness/synthesis lifecycle
    (RELAY_PLAYBOOK.md §5 / phase7 prompt §28). This message lets the
    browser report what it observed so the server can timestamp it and
    re-emit the existing documented heard_entry event — HeardEntry's shape
    and the append-only receipt log stay exactly as already defined."""

    type: Literal["heard_report"]
    contextId: str
    text: str
    status: Literal["complete", "cut"]
    cutAtSeconds: Optional[float] = Field(default=None, ge=0.0)

    @model_validator(mode="after")
    def _cut_at_seconds_matches_status(self) -> "HeardReportMessage":
        if self.status == "cut" and self.cutAtSeconds is None:
            raise ValueError('cutAtSeconds is required when status == "cut"')
        if self.status != "cut" and self.cutAtSeconds is not None:
            raise ValueError('cutAtSeconds is only meaningful when status == "cut"')
        return self


class AudioChunkMessage(BaseModel):
    type: Literal["audio_chunk"]
    contextId: str
    data: str  # base64


class ContextClearedMessage(BaseModel):
    type: Literal["context_cleared"]
    contextId: str
    discardedChunks: int


class HeardEntryMessage(BaseModel):
    type: Literal["heard_entry"]
    entry: HeardEntry


class LedgerEntryCreateRequest(BaseModel):
    word: str
    category: LedgerCategory
