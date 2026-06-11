"""Identity matcher — loop step 1: find the same patient across sources.

Vector similarity alone is not enough (Step 4 showed a one-letter name twin
out-scoring the real, abbreviated match). So this is a HYBRID matcher:

  1. vector recall  -> a shortlist of candidate records (pgvector),
  2. hard reject    -> never merge records whose DOB or gender plainly conflict,
  3. positive confirm -> accept on exact NIC, OR DOB+phone, OR DOB+strong vector.

Every decision carries a human-readable reason, so the match is defensible
record-by-record rather than hidden behind a similarity number.
"""

from dataclasses import dataclass

from app.db import get_client, similarity_search
from app.models import (
    AnyRecord,
    ClinicRecord,
    LabRecord,
    MatchEvidence,
    PatientIdentity,
    PharmacyRecord,
)

# If DOB agrees, a vector this strong is enough on its own to confirm. (Below
# this, we require a second exact identifier — NIC or phone.)
RECALL_THRESHOLD = 0.75

_RECORD_CLASSES = {"clinic": ClinicRecord, "lab": LabRecord, "pharmacy": PharmacyRecord}


@dataclass
class MatchResult:
    entry_record_id: str
    records: list[AnyRecord]  # confirmed same-patient cluster, incl. the entry record
    evidence: list[MatchEvidence]  # full per-candidate breakdown


def _norm(value: str | None) -> str | None:
    return value.strip().lower() if value else None


def _norm_nic(value: str | None) -> str | None:
    return value.strip().upper() if value else None


def _digits(value: str | None) -> str | None:
    return "".join(c for c in value if c.isdigit()) if value else None


def _decide(entry: PatientIdentity, cand: PatientIdentity, similarity: float | None) -> tuple[str, str]:
    """Confirm / reject / mark-uncertain one candidate against the entry identity."""
    # 1. Hard rejects first (safety): a different birth date or sex is never the
    #    same human, no matter how similar the name or vector.
    if entry.date_of_birth and cand.date_of_birth and entry.date_of_birth != cand.date_of_birth:
        return "rejected", f"DOB conflict ({cand.date_of_birth} vs {entry.date_of_birth})"
    if _norm(entry.gender) and _norm(cand.gender) and _norm(entry.gender) != _norm(cand.gender):
        return "rejected", f"gender conflict ({cand.gender} vs {entry.gender})"

    # 2. Positive confirmations, strongest first.
    if _norm_nic(entry.nic) and _norm_nic(cand.nic) and _norm_nic(entry.nic) == _norm_nic(cand.nic):
        return "confirmed", "exact NIC match"

    dob_match = bool(entry.date_of_birth and cand.date_of_birth and entry.date_of_birth == cand.date_of_birth)
    phone_match = bool(_digits(entry.phone) and _digits(cand.phone) and _digits(entry.phone) == _digits(cand.phone))
    if dob_match and phone_match:
        return "confirmed", "DOB + phone match"
    if dob_match and similarity is not None and similarity >= RECALL_THRESHOLD:
        return "confirmed", f"DOB match + strong vector ({similarity:.2f})"

    return "uncertain", "insufficient corroboration"


def _row_to_record(row: dict) -> AnyRecord:
    """Rebuild a typed per-source record from a DB row (identity/clinical JSONB)."""
    return _RECORD_CLASSES[row["source_type"]].model_validate(
        {
            "record_id": row["record_id"],
            "source_type": row["source_type"],
            "source_name": row["source_name"],
            "record_date": row["record_date"],
            "identity": row["identity"],
            **row["clinical"],
        }
    )


def _fetch_record_row(record_id: str) -> dict:
    response = (
        get_client()
        .table("records")
        .select("record_id, source_type, source_name, record_date, identity, clinical")
        .eq("record_id", record_id)
        .single()
        .execute()
    )
    return response.data


def match_patient(entry_record_id: str, candidate_pool_size: int = 20) -> MatchResult:
    """Resolve every record belonging to the patient identified by the entry record."""
    entry_row = _fetch_record_row(entry_record_id)
    entry_identity = PatientIdentity.model_validate(entry_row["identity"])

    # The entry record anchors the cluster.
    cluster: list[AnyRecord] = [_row_to_record(entry_row)]
    evidence = [
        MatchEvidence(
            record_id=entry_record_id,
            source_type=entry_row["source_type"],
            full_name=entry_identity.full_name,
            similarity=1.0,
            decision="confirmed",
            reason="entry record (anchor)",
        )
    ]

    for row in similarity_search(entry_identity, match_count=candidate_pool_size):
        if row["record_id"] == entry_record_id:
            continue  # skip the anchor matching itself
        cand_identity = PatientIdentity.model_validate(row["identity"])
        decision, reason = _decide(entry_identity, cand_identity, row.get("similarity"))
        evidence.append(
            MatchEvidence(
                record_id=row["record_id"],
                source_type=row["source_type"],
                full_name=cand_identity.full_name,
                similarity=row.get("similarity"),
                decision=decision,
                reason=reason,
            )
        )
        if decision == "confirmed":
            cluster.append(_row_to_record(row))

    return MatchResult(entry_record_id=entry_record_id, records=cluster, evidence=evidence)
