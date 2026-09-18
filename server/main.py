"""FastAPI app. Phase 1 gave it CORS and a liveness check. Phase 2 added
POST /api/turn (ASR only). Phase 3 threads its transcript through
constrained reconstruction to produce real candidates. Phase 4 adds
/ws/tts — a selected candidate streamed through Rime and back. Phase 5
replaces the static reconstruction vocabulary with each user's real
pronunciation ledger and adds the ledger routes themselves."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, Form, HTTPException, Query, Response, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from server.asr import ASRError, transcribe
from server.config import settings
from server.history import append_exchange, get_history
from server.ledger import (
    LedgerError,
    create_entry,
    delete_entry,
    get_ledger,
    init_db,
    seed_demo_ledger_if_empty,
    set_phoneme,
)
from server.models import HealthResponse, LedgerEntry, LedgerEntryCreateRequest, Situation, TurnResponse
from server.reconstruct import reconstruct
from server.session_ws import tts_endpoint


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()  # schema only — never drops existing rows
    await seed_demo_ledger_if_empty()  # fail-soft; skips if already seeded
    yield


app = FastAPI(title="RELAY", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.ALLOWED_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/api/turn", response_model=TurnResponse)
async def turn(
    audio: UploadFile,
    situation: Situation = Form(...),
    userId: str = Form(...),
) -> TurnResponse:
    if not userId.strip():
        raise HTTPException(status_code=422, detail="userId must not be empty")

    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=422, detail="audio file is empty")

    content_type = audio.content_type or "audio/webm"

    try:
        transcript = await transcribe(audio_bytes, content_type, audio.filename or "audio.webm")
    except ASRError as e:
        # Message is safe to surface (server/asr.py never puts secrets in it)
        # but never forward a raw provider stack trace or payload.
        raise HTTPException(status_code=502, detail=str(e)) from e

    # Real per-user ledger vocabulary, not the Phase 3 static fixture.
    # Reconstruction gets the full word list regardless of verified/covered
    # state — that gate is for TTS injection (server/ledger.py), not for
    # what the LLM is allowed to prefer.
    ledger_terms = [entry.word for entry in get_ledger(userId)]
    history = get_history(userId)
    candidates = await reconstruct(transcript, ledger_terms, situation, history)
    append_exchange(userId, transcript)

    return TurnResponse(transcript=transcript, candidates=candidates)


@app.get("/api/ledger", response_model=list[LedgerEntry])
def api_get_ledger(userId: str = Query(..., min_length=1)) -> list[LedgerEntry]:
    return get_ledger(userId)


@app.post("/api/ledger/entry", response_model=LedgerEntry)
async def api_create_ledger_entry(
    body: LedgerEntryCreateRequest,
    userId: str = Query(..., min_length=1),
) -> LedgerEntry:
    word = body.word.strip()
    if not word:
        raise HTTPException(status_code=422, detail="word must not be empty")
    try:
        return await create_entry(userId, word, body.category)
    except LedgerError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.post("/api/ledger/phonemize", response_model=LedgerEntry)
async def api_phonemize_ledger_entry(
    audio: UploadFile,
    id: str = Form(...),
    userId: str = Query(..., min_length=1),
) -> LedgerEntry:
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=422, detail="audio file is empty")

    try:
        entry = await set_phoneme(userId, id, audio_bytes, audio.content_type or "audio/wav")
    except LedgerError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    if entry is None:
        raise HTTPException(status_code=404, detail="ledger entry not found")
    return entry


@app.delete("/api/ledger/entry/{entry_id}", status_code=204)
def api_delete_ledger_entry(entry_id: str, userId: str = Query(..., min_length=1)) -> Response:
    """Remove one of this user's ledger entries permanently, freeing the
    word to be added and re-recorded from scratch.

    404 for an id that does not exist *and* for one that belongs to a
    different user — deliberately indistinguishable, matching the
    ownership behaviour POST /api/ledger/phonemize already has. A real
    delete, so the row stops reaching both TTS injection
    (server/ledger.py's inject_pronunciations) and the reconstruction
    vocabulary (POST /api/turn) on the very next request."""
    if not delete_entry(userId, entry_id):
        raise HTTPException(status_code=404, detail="ledger entry not found")
    return Response(status_code=204)


@app.websocket("/ws/tts")
async def ws_tts(websocket: WebSocket) -> None:
    await tts_endpoint(websocket)
