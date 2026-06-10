"""The single LLM interface: Gemini 2.0 Flash primary, Groq fallback.

PydanticAI's FallbackModel wraps both providers so the agents (Calls 1 and 2)
receive one "model" and never know which one answered. If the primary errors or
rate-limits, it transparently retries on the next provider.

We use PydanticAI's direct Gemini client (GoogleGLAProvider), NOT the google-genai
SDK, because that SDK pins httpx>=0.28 which conflicts with Supabase (<0.28).

Model ids are architectural constants; the API keys come from .env.
"""

from functools import lru_cache

from pydantic_ai.models import Model
from pydantic_ai.models.fallback import FallbackModel
from pydantic_ai.models.gemini import GeminiModel
from pydantic_ai.models.groq import GroqModel
from pydantic_ai.providers.google_gla import GoogleGLAProvider
from pydantic_ai.providers.groq import GroqProvider

from app.config import settings

GEMINI_MODEL = "gemini-2.0-flash"
GROQ_MODEL = "openai/gpt-oss-120b"


@lru_cache(maxsize=1)
def get_model() -> Model:
    """Build the provider chain once: [Gemini primary, Groq fallback].

    If only one key is configured we degrade gracefully to that single provider;
    if neither is set we fail loudly rather than silently doing nothing.
    """
    chain: list[Model] = []
    if settings.gemini_api_key:
        chain.append(GeminiModel(GEMINI_MODEL, provider=GoogleGLAProvider(api_key=settings.gemini_api_key)))
    if settings.groq_api_key:
        chain.append(GroqModel(GROQ_MODEL, provider=GroqProvider(api_key=settings.groq_api_key)))

    if not chain:
        raise RuntimeError("Set GEMINI_API_KEY and/or GROQ_API_KEY in backend/.env")
    return FallbackModel(*chain) if len(chain) > 1 else chain[0]
