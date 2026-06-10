"""Local, free identity embeddings via sentence-transformers.

We turn a patient's *soft* identity (name + date of birth + gender) into a vector
so we can fuzzy-match the same human across sources that share no ID. The model
runs entirely on CPU and offline after a one-time weight download — no paid API.

Why only name + DOB + gender? Those are the fuzzy, human fields a vector handles
well. NIC and phone are exact identifiers; embeddings are poor at matching digit
strings, so we deliberately leave them out here and corroborate them
deterministically in the matcher (Step 6).
"""

from functools import lru_cache

from sentence_transformers import SentenceTransformer

from app.models import PatientIdentity

# Architectural constant, not an env knob: this model fixes our vector dimension,
# which in turn fixes the pgvector column width in the DB (Step 5). Changing it
# is a schema change, so it lives in code.
MODEL_NAME = "all-MiniLM-L6-v2"
EMBEDDING_DIM = 384


@lru_cache(maxsize=1)
def _get_model() -> SentenceTransformer:
    """Load the model once, lazily on first use, then reuse it (cached)."""
    return SentenceTransformer(MODEL_NAME)


def identity_to_text(identity: PatientIdentity) -> str:
    """The canonical, normalized string we embed for one identity.

    Normalizing (lowercase, ISO date) means trivial formatting differences
    between sources don't show up as vector differences.
    """
    name = identity.full_name.strip().lower()
    dob = identity.date_of_birth.isoformat() if identity.date_of_birth else ""
    gender = (identity.gender or "").strip().lower()
    return f"{name} | {dob} | {gender}"


def embed_identity(identity: PatientIdentity) -> list[float]:
    """Embed a single identity into a unit-length 384-d vector."""
    vector = _get_model().encode(identity_to_text(identity), normalize_embeddings=True)
    return vector.tolist()


def embed_identities(identities: list[PatientIdentity]) -> list[list[float]]:
    """Batch-embed many identities at once (one encode call, faster fan-out)."""
    texts = [identity_to_text(i) for i in identities]
    vectors = _get_model().encode(texts, normalize_embeddings=True)
    return [v.tolist() for v in vectors]
