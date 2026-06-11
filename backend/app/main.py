import json

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from app.adjudicator import adjudicate
from app.config import settings
from app.db import list_entry_records, upsert_records
from app.detector import detect_conflicts
from app.executor import execute
from app.matcher import match_patient
from app.orchestrator import assemble_result, reconcile
from app.reviewer import review
from app.seed.loader import load_all_records

app = FastAPI(title=settings.app_name, version=settings.version)

# Dev-permissive CORS so the Next.js frontend (another origin) can call the API.
# No cookies/credentials are used, so a wildcard is safe here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness probe: confirms the API is up and reports its basic identity."""
    return {
        "status": "ok",
        "app": settings.app_name,
        "environment": settings.environment,
        "version": settings.version,
    }


@app.post("/seed")
def seed() -> dict[str, int]:
    """Load the seeded fake datasets into the DB (idempotent upsert). Demo setup."""
    return {"seeded": upsert_records(load_all_records())}


@app.get("/patients")
def patients() -> list[dict]:
    """The clinic records a clinician can start a reconciliation from (the picker)."""
    return list_entry_records()


@app.get("/reconcile/{record_id}")
def reconcile_endpoint(record_id: str):
    """Run the full loop and return the complete bundled result as JSON."""
    return reconcile(record_id)


def _sse(event: str, data: dict) -> str:
    """Format one Server-Sent Event."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _reconcile_events(record_id: str):
    """Run the loop, emitting one SSE per stage so the UI reveals it live."""
    match = match_patient(record_id)  # 1
    yield _sse(
        "matched",
        {
            "entry_record_id": record_id,
            "match_evidence": [e.model_dump() for e in match.evidence],
            "cluster": [r.model_dump(mode="json") for r in match.records],
        },
    )
    conflicts = detect_conflicts(match.records)  # 2
    yield _sse("detected", {"conflicts": [c.model_dump(mode="json") for c in conflicts]})

    adjudication = adjudicate(conflicts)  # 3 (LLM call 1)
    yield _sse("adjudicated", {"adjudication": adjudication.model_dump(mode="json")})

    execution = execute(record_id, match.records, conflicts, adjudication, persist=True)  # 4
    yield _sse(
        "executed",
        {
            "actions": [a.model_dump(mode="json") for a in execution.actions],
            "reconciled_record": execution.reconciled_record.model_dump(mode="json"),
        },
    )
    review_result = review(execution)  # 5 (LLM call 2)
    yield _sse("reviewed", {"review": review_result.model_dump(mode="json")})

    result = assemble_result(record_id, match, conflicts, adjudication, execution, review_result)
    yield _sse("done", result.model_dump(mode="json"))


@app.get("/reconcile/{record_id}/stream")
def reconcile_stream(record_id: str):
    """Stream the loop stage-by-stage as Server-Sent Events for the live demo."""
    return StreamingResponse(_reconcile_events(record_id), media_type="text/event-stream")
