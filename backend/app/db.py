"""Supabase persistence + pgvector similarity search.

Runtime data ops go through the official Supabase client (PostgREST + RPC),
which fits the service_role key in .env. The schema itself (table, index, the
match_records function) is applied once from db/schema.sql via the Supabase SQL
editor — PostgREST cannot run DDL.
"""

from functools import lru_cache

from supabase import Client, create_client

from app.config import settings
from app.embeddings import embed_identity
from app.models import AnyRecord, ExecutedAction, PatientIdentity


@lru_cache(maxsize=1)
def get_client() -> Client:
    """Create the Supabase client once, from settings. Errors clearly if unset."""
    if not settings.supabase_url or not settings.supabase_key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_KEY must be set in backend/.env"
        )
    return create_client(settings.supabase_url, settings.supabase_key)


def _to_row(record: AnyRecord) -> dict:
    """Flatten a record into a DB row, computing its identity embedding.

    Base provenance/identity fields become columns; whatever clinical fields the
    source carries (diagnoses / medications / allergies) go into the JSONB blob.
    """
    data = record.model_dump(mode="json")
    base = {"record_id", "source_type", "source_name", "record_date"}
    identity = data.pop("identity")
    clinical = {k: v for k, v in data.items() if k not in base}
    return {
        "record_id": data["record_id"],
        "source_type": data["source_type"],
        "source_name": data["source_name"],
        "record_date": data["record_date"],
        "identity": identity,
        "clinical": clinical,
        "embedding": embed_identity(record.identity),
    }


def upsert_records(records: list[AnyRecord]) -> int:
    """Insert/replace records by their source-local record_id. Returns the count."""
    rows = [_to_row(r) for r in records]
    get_client().table("records").upsert(rows, on_conflict="record_id").execute()
    return len(rows)


def list_entry_records() -> list[dict]:
    """Clinic records — the valid entry points a clinician can reconcile from."""
    response = (
        get_client()
        .table("records")
        .select("record_id, source_name, record_date, identity")
        .eq("source_type", "clinic")
        .order("record_id")
        .execute()
    )
    return [
        {
            "record_id": r["record_id"],
            "full_name": r["identity"].get("full_name"),
            "source_name": r["source_name"],
            "record_date": r["record_date"],
        }
        for r in response.data
    ]


def search_entry_records(query: str, limit: int = 8) -> list[dict]:
    """Clinic entry records whose patient matches a free-text query.

    The query may be part of a name, a record id, or an NIC. We match on the
    queryable identity/provenance columns directly (case-insensitive), so a
    clinician can find a patient to start a run without scrolling the roster.
    This is the patient-facing lookup; the vector search in similarity_search is
    the agent's internal identity recall (a different job).
    """
    q = query.strip()
    if not q:
        return list_entry_records()

    like = f"%{q}%"
    response = (
        get_client()
        .table("records")
        .select("record_id, source_name, record_date, identity")
        .eq("source_type", "clinic")
        # identity is JSONB; ->> extracts the text value for an ilike match.
        .or_(f"record_id.ilike.{like},identity->>full_name.ilike.{like},identity->>nic.ilike.{like}")
        .order("record_id")
        .limit(limit)
        .execute()
    )
    return [
        {
            "record_id": r["record_id"],
            "full_name": r["identity"].get("full_name"),
            "source_name": r["source_name"],
            "record_date": r["record_date"],
        }
        for r in response.data
    ]


def insert_actions(patient_record_id: str, actions: list[ExecutedAction]) -> int:
    """Persist executed actions as an audit trail. Returns the number stored."""
    rows = [
        {
            "patient_record_id": patient_record_id,
            "conflict_ref": a.conflict_ref,
            "conflict_type": a.conflict_type.value,
            "action": a.action.value,
            "severity": a.severity.value,
            "title": a.title,
            "detail": a.detail,
            "payload": a.payload,
        }
        for a in actions
    ]
    if rows:
        get_client().table("actions").insert(rows).execute()
    return len(rows)


def similarity_search(identity: PatientIdentity, match_count: int = 10) -> list[dict]:
    """Return the records most similar to a query identity, ranked by cosine."""
    response = (
        get_client()
        .rpc(
            "match_records",
            {
                "query_embedding": embed_identity(identity),
                "match_count": match_count,
            },
        )
        .execute()
    )
    return response.data
