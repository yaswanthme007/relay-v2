"""Server configuration. Reads credentials and runtime settings from the
environment only. RIME_API_KEY and GROQ_API_KEY are required — missing
either one fails startup loudly rather than falling back to an
unauthenticated path. Credentials never reach the browser; this is the
one place they exist server-side."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    RIME_API_KEY: str
    GROQ_API_KEY: str
    ALLOWED_ORIGIN: str = "http://localhost:5173"
    PORT: int = 8000


settings = Settings()
