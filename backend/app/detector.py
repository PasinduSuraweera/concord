"""Deterministic conflict detection — loop step 2 (rules, never the LLM).

Given the matched patient cluster, this surfaces clinical contradictions using
the curated clinical_kb. It emits Conflict facts only — it does NOT judge how
dangerous they are or what to do; that is the LLM's job in adjudication (Call 1).
"""

from collections import defaultdict

from app import clinical_kb
from app.models import AnyRecord, Conflict, ConflictParty, ConflictType


def _meds_with_provenance(records: list[AnyRecord]) -> list[tuple[AnyRecord, object]]:
    """Every (record, medication) pair across the cluster. Lab records have none."""
    return [(r, m) for r in records for m in getattr(r, "medications", [])]


def _party(record: AnyRecord, value: str) -> ConflictParty:
    return ConflictParty(
        record_id=record.record_id,
        source_type=record.source_type,
        source_name=record.source_name,
        record_date=record.record_date,
        value=value,
    )


def _detect_dose_clashes(records: list[AnyRecord]) -> list[Conflict]:
    """Same drug recorded at different doses across sources."""
    by_drug: dict[str, list[tuple[AnyRecord, object]]] = defaultdict(list)
    for record, med in _meds_with_provenance(records):
        by_drug[med.name.strip().lower()].append((record, med))

    conflicts = []
    for items in by_drug.values():
        doses = {(med.dose or "").strip().lower() for _, med in items}
        if len(items) >= 2 and len(doses) > 1:
            parties = [_party(r, f"{m.name} {m.dose or '(no dose)'}") for r, m in items]
            drug = items[0][1].name
            conflicts.append(
                Conflict(
                    conflict_type=ConflictType.DOSE_CLASH,
                    description=f"{drug} recorded at different doses: "
                    + ", ".join(f"{p.source_type.value}={p.value}" for p in parties),
                    parties=parties,
                    detail={"drug": drug, "doses": sorted(doses)},
                )
            )
    return conflicts


def _detect_allergy_contraindications(records: list[AnyRecord]) -> list[Conflict]:
    """A drug in the cluster is contraindicated by an allergy recorded in the cluster."""
    allergy_records = [(r, a) for r in records for a in getattr(r, "allergies", [])]

    conflicts = []
    seen: set[tuple[str, str, str]] = set()
    for record, med in _meds_with_provenance(records):
        blockers = [(ar, a) for ar, a in allergy_records if clinical_kb.allergy_contraindicates(a, med.name)]
        if not blockers:
            continue
        allergy_term = blockers[0][1]
        key = (record.record_id, med.name.strip().lower(), allergy_term.strip().lower())
        if key in seen:
            continue
        seen.add(key)

        allergy_parties = [_party(ar, f"{a} allergy") for ar, a in blockers]
        sources_with_allergy = sorted({p.source_type.value for p in allergy_parties})
        conflicts.append(
            Conflict(
                conflict_type=ConflictType.ALLERGY_MISMATCH,
                description=(
                    f"{med.name} ({clinical_kb.drug_class(med.name)}-class) recorded by "
                    f"{record.source_type.value}, but a {allergy_term} allergy is recorded by "
                    f"{', '.join(sources_with_allergy)} - {record.source_type.value} did not list it."
                ),
                parties=[_party(record, f"{med.name} prescribed/dispensed"), *allergy_parties],
                detail={"drug": med.name, "drug_class": clinical_kb.drug_class(med.name), "allergy": allergy_term},
            )
        )
    return conflicts


def _detect_interactions(records: list[AnyRecord]) -> list[Conflict]:
    """Any pair of drugs across the cluster that dangerously interact."""
    meds = _meds_with_provenance(records)
    conflicts = []
    seen: set[frozenset[str]] = set()
    for i in range(len(meds)):
        for j in range(i + 1, len(meds)):
            r1, m1 = meds[i]
            r2, m2 = meds[j]
            risk = clinical_kb.interaction_risk(m1.name, m2.name)
            if not risk:
                continue
            pair = frozenset({m1.name.strip().lower(), m2.name.strip().lower()})
            if pair in seen:
                continue
            seen.add(pair)
            conflicts.append(
                Conflict(
                    conflict_type=ConflictType.DRUG_INTERACTION,
                    description=f"{m1.name} ({r1.source_type.value}) + {m2.name} ({r2.source_type.value}): {risk}",
                    parties=[_party(r1, m1.name), _party(r2, m2.name)],
                    detail={"drug_a": m1.name, "drug_b": m2.name, "risk": risk},
                )
            )
    return conflicts


def detect_conflicts(records: list[AnyRecord]) -> list[Conflict]:
    """Run every rule over the cluster and return all detected conflicts."""
    return [
        *_detect_dose_clashes(records),
        *_detect_allergy_contraindications(records),
        *_detect_interactions(records),
    ]
