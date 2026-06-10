from fastapi import FastAPI

from app.config import settings

app = FastAPI(title=settings.app_name, version=settings.version)


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness probe: confirms the API is up and reports its basic identity."""
    return {
        "status": "ok",
        "app": settings.app_name,
        "environment": settings.environment,
        "version": settings.version,
    }
