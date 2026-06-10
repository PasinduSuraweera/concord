from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application configuration, loaded from environment variables or a .env file.

    Every field has a safe default, so the app runs without a .env during early
    development. As we add components (LLM keys, Supabase), new fields get added
    here and documented in .env.example.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Concord"
    environment: str = "development"
    version: str = "0.1.0"


# One shared, import-anywhere settings instance.
settings = Settings()
