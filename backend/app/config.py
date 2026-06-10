from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Resolve .env relative to THIS file (backend/.env), not the working directory,
# so config loads no matter where the process is launched from.
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    """Application configuration, loaded from environment variables or a .env file.

    Every field has a safe default, so the app runs without a .env during early
    development. As we add components (LLM keys, Supabase), new fields get added
    here and documented in .env.example.
    """

    model_config = SettingsConfigDict(
        env_file=_ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Concord"
    environment: str = "development"
    version: str = "0.1.0"

    # Supabase (server-side service_role key — never expose to the frontend).
    # Empty defaults so the app still boots without them; db.py errors clearly
    # if they're used while unset.
    supabase_url: str = ""
    supabase_key: str = ""


# One shared, import-anywhere settings instance.
settings = Settings()
