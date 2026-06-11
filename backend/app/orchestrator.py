"""The orchestrator — the autonomous loop, end to end.

reconcile(patient_id) runs the full agentic loop with no human input after the ID:

  1. match_patient   - fan out + vector-match identity (loop step 1)
  2. detect_conflicts - deterministic contradiction detection (loop step 2)
  3. adjudicate       - LLM Call 1: batch all conflicts -> structured verdicts
  4. execute          - carry out the actions + assemble the reconciled record
  5. review           - LLM Call 2: confidence + escalate only if unsure

It returns one bundled, JSON-serializable ReconciliationResult. Exactly two LLM
calls happen regardless of how many conflicts were found.
"""

from app.adjudicator import adjudicate
from app.detector import detect_conflicts
from app.executor import execute
from app.matcher import match_patient
from app.models import ReconciliationMeta, ReconciliationResult
from app.reviewer import review


def reconcile(entry_record_id: str, persist: bool = True) -> ReconciliationResult:
    """Run the whole loop for one patient (identified by their clinic record id)."""
    match = match_patient(entry_record_id)                       # 1
    conflicts = detect_conflicts(match.records)                  # 2
    adjudication = adjudicate(conflicts)                         # 3  (LLM call 1)
    execution = execute(entry_record_id, match.records, conflicts, adjudication, persist=persist)  # 4
    review_result = review(execution)                            # 5  (LLM call 2)

    return ReconciliationResult(
        entry_record_id=entry_record_id,
        match_evidence=match.evidence,
        cluster=[record.model_dump(mode="json") for record in match.records],
        conflicts=conflicts,
        adjudication=adjudication,
        actions=execution.actions,
        reconciled_record=execution.reconciled_record,
        review=review_result,
        meta=ReconciliationMeta(
            llm_calls=2,
            cluster_size=len(match.records),
            conflicts_found=len(conflicts),
            actions_taken=len(execution.actions),
            escalated=review_result.escalate_to_human,
        ),
    )
