"""Execute the adjudicated actions — loop step 4 (deterministic).

For each verdict from Call 1 we produce a concrete safety artifact (alert /
reconciliation / referral) and persist it as an audit trail. Separately we
assemble ONE consolidated reconciled record: the cluster merged together with the
trusted values applied. No LLM here — we are carrying out decisions already made.
"""

import re
from collections import OrderedDict

from app.db import insert_actions
from app.models import (
    Adjudication,
    AdjudicationAction,
    AnyRecord,
    Conflict,
    ConflictAdjudication,
    ConflictType,
    ExecutedAction,
    ExecutionResult,
    Medication,
    PatientIdentity,
    ReconciledRecord,
)

# Must match the ref scheme the adjudicator used when formatting the prompt.
def _ref_map(conflicts: list[Conflict]) -> dict[str, Conflict]:
    return {f"C{i}": c for i, c in enumerate(conflicts, start=1)}


_REF_RE = re.compile(r"[Cc]\s*(\d+)")


def _normalize_ref(ref: str) -> str | None:
    """Extract the canonical 'C<n>' token from whatever the LLM echoed back.

    The model sometimes returns 'C1 [dose_clash]' or 'c1' instead of plain 'C1';
    we map all of those to 'C1' so a decision is never silently dropped.
    """
    match = _REF_RE.search(ref)
    return f"C{match.group(1)}" if match else None


def _build_action(decision: ConflictAdjudication, conflict: Conflict) -> ExecutedAction:
    """Turn one verdict into a concrete, human-readable action artifact."""
    titles = {
        AdjudicationAction.PRESCRIBER_ALERT: f"Prescriber alert ({decision.severity.value}): {conflict.conflict_type.value}",
        AdjudicationAction.RECONCILE_RECORD: f"Record reconciled: {conflict.conflict_type.value}",
        AdjudicationAction.GENERATE_REFERRAL: f"Referral packet generated ({decision.severity.value})",
        AdjudicationAction.NO_ACTION: "No action required",
    }
    return ExecutedAction(
        conflict_ref=_normalize_ref(decision.conflict_ref) or decision.conflict_ref,
        conflict_type=conflict.conflict_type,
        action=decision.action,
        severity=decision.severity,
        title=titles[decision.action],
        detail=f"Trusted: {decision.trusted_value}. {decision.reasoning}",
        payload={
            "trusted_value": decision.trusted_value,
            "conflict": conflict.description,
            "parties": [
                {"source": p.source_type.value, "record_id": p.record_id, "value": p.value}
                for p in conflict.parties
            ],
        },
    )


def _merge_identity(cluster: list[AnyRecord], anchor: AnyRecord) -> PatientIdentity:
    """Best-known identity: anchor first, fill missing fields from other sources."""
    merged = anchor.identity.model_copy()
    for record in cluster:
        for field in ("date_of_birth", "nic", "phone", "gender"):
            if getattr(merged, field) is None and getattr(record.identity, field) is not None:
                setattr(merged, field, getattr(record.identity, field))
    merged.full_name = max((r.identity.full_name for r in cluster), key=len)  # most complete name
    return merged


def _union(values: list[str]) -> list[str]:
    """Case-insensitive de-dupe that preserves first-seen order."""
    seen, out = set(), []
    for v in values:
        if v.lower() not in seen:
            seen.add(v.lower())
            out.append(v)
    return out


def _assemble_reconciled(
    entry_record_id: str,
    cluster: list[AnyRecord],
    adjudication: Adjudication,
    refs: dict[str, Conflict],
) -> ReconciledRecord:
    anchor = next(r for r in cluster if r.record_id == entry_record_id)
    applied: list[str] = []

    # Trusted dose per drug, taken from dose-clash verdicts.
    trusted_dose: dict[str, str] = {}
    for d in adjudication.decisions:
        c = refs.get(_normalize_ref(d.conflict_ref))
        if c and c.conflict_type == ConflictType.DOSE_CLASH:
            drug = str(c.detail.get("drug", "")).strip().lower()
            chosen = next((dose for dose in c.detail.get("doses", []) if dose and dose in d.trusted_value.lower()), None)
            if drug and chosen:
                trusted_dose[drug] = chosen

    # Medications: de-dupe by drug, apply trusted dose, else most-recent dose.
    meds_by_drug: "OrderedDict[str, list[tuple[AnyRecord, Medication]]]" = OrderedDict()
    for record in cluster:
        for med in getattr(record, "medications", []):
            meds_by_drug.setdefault(med.name.strip().lower(), []).append((record, med))

    medications: list[Medication] = []
    for drug_lower, items in meds_by_drug.items():
        name = items[0][1].name
        if drug_lower in trusted_dose:
            medications.append(Medication(name=name, dose=trusted_dose[drug_lower]))
            applied.append(f"Reconciled {name} dose to {trusted_dose[drug_lower]} (sources disagreed).")
        else:
            recent = max(items, key=lambda im: im[0].record_date)[1]
            medications.append(Medication(name=name, dose=recent.dose, frequency=recent.frequency))

    # Allergies: union across cluster; log any the entry record was missing.
    allergies = _union([a for r in cluster for a in getattr(r, "allergies", [])])
    entry_allergies = {a.lower() for a in getattr(anchor, "allergies", [])}
    for a in allergies:
        if a.lower() not in entry_allergies:
            applied.append(f"Added allergy '{a}' (corroborated by other sources; missing from entry record).")

    diagnoses = _union([dx for r in cluster for dx in getattr(r, "diagnoses", [])])

    return ReconciledRecord(
        patient_record_id=entry_record_id,
        identity=_merge_identity(cluster, anchor),
        diagnoses=diagnoses,
        medications=medications,
        allergies=allergies,
        source_record_ids=[r.record_id for r in cluster],
        applied_changes=applied,
    )


def execute(
    entry_record_id: str,
    cluster: list[AnyRecord],
    conflicts: list[Conflict],
    adjudication: Adjudication,
    persist: bool = True,
) -> ExecutionResult:
    """Carry out every adjudicated action and build the reconciled record."""
    refs = _ref_map(conflicts)
    actions = []
    for d in adjudication.decisions:
        conflict = refs.get(_normalize_ref(d.conflict_ref))
        if conflict is not None:
            actions.append(_build_action(d, conflict))
    reconciled = _assemble_reconciled(entry_record_id, cluster, adjudication, refs)

    if persist:
        insert_actions(entry_record_id, actions)

    return ExecutionResult(actions=actions, reconciled_record=reconciled)
