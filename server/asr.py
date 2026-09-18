"""ASR only. One job: browser audio bytes in, Groq Whisper transcript out.

No FastAPI route logic here, no candidate generation, no Rime. Uses the
verified-live Groq Whisper model from Phase 0 (`whisper-large-v3-turbo`) —
`llama-3.3-70b-versatile`'s Phase 0 deprecation is a reconstruction-model
concern (Phase 3) and irrelevant to this module."""

import httpx

from server.config import settings

GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
WHISPER_MODEL = "whisper-large-v3-turbo"


class ASRError(Exception):
    """Raised when Groq transcription fails. Message is safe to surface —
    never includes the API key or the raw provider payload."""


async def transcribe(audio_bytes: bytes, content_type: str, filename: str = "audio.webm") -> str:
    """Send recorded browser audio to Groq Whisper, return the transcript
    string. `content_type` should be the browser's actual
    `MediaRecorder.mimeType` (e.g. "audio/webm;codecs=opus") — Groq's
    transcription endpoint accepts webm/opus directly, no server-side
    transcoding needed."""

    files = {"file": (filename, audio_bytes, content_type)}
    data = {"model": WHISPER_MODEL, "response_format": "json"}
    headers = {"Authorization": f"Bearer {settings.GROQ_API_KEY}"}

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await client.post(GROQ_TRANSCRIPTION_URL, headers=headers, data=data, files=files)
        except httpx.RequestError as e:
            raise ASRError(f"Could not reach Groq transcription API: {type(e).__name__}") from e

    if resp.status_code != 200:
        # Groq's error body may echo request details but never our credentials
        # (the key only ever appears in the outgoing Authorization header).
        raise ASRError(f"Groq transcription failed with status {resp.status_code}")

    try:
        payload = resp.json()
    except ValueError as e:
        raise ASRError("Groq transcription returned an unparseable response") from e

    transcript = payload.get("text")
    if not isinstance(transcript, str):
        raise ASRError("Groq transcription response missing 'text' field")

    return transcript
