"""Adjudication — LLM Call 1: batch ALL conflicts into ONE structured call.

This is the architectural centerpiece: no matter how many conflicts the detector
found, they are formatted into a single prompt and adjudicated in one request that
returns structured JSON (one verdict per conflict). The LLM applies trust
principles (provenance / recency / corroboration / source role) and we get back a
typed Adjudication, validated by PydanticAI against our models.
"""

from pydantic_ai import Agent

from app.guidelines import retrieve_for_conflicts
from app.llm import get_model
from app.models import Adjudication, Conflict

_INSTRUCTIONS = """\
You are Concord's clinical-record reconciliation adjudicator. You receive a batch
of contradictions found across ONE patient's records from different sources
(clinic, lab, pharmacy). For EACH conflict, decide which value to trust and what
to do, applying these principles:

- Corroboration: a value recorded by multiple independent sources is more trustworthy.
- Recency: a more recent record (later record_date) usually reflects current truth.
- Source role: a pharmacy is authoritative on what was DISPENSED; a clinic on
  diagnoses and what was PRESCRIBED; a lab on results and allergies noted at testing.
- Safety first: when a conflict implies patient harm (a drug given despite a known
  allergy, or a dangerous interaction), raise the severity and choose an action that
  protects the patient.

Some conflicts come with retrieved clinical guidelines (tagged with ids like
SLNF-ANTI-014). Ground your decision in them when relevant, and list the ids you
relied on in guideline_refs for that conflict (empty list if none applied).

For every conflict return: the conflict_ref as the bare token only (e.g. "C1", not
"C1 [dose_clash]"); a short concrete trusted_value; reasoning of 1-2 sentences that
cites provenance/recency/corroboration; a severity (low|moderate|high|critical);
exactly one action (prescriber_alert|reconcile_record|generate_referral|no_action);
and guideline_refs.
"""

# Built once; reused for every reconciliation.
_agent = Agent(get_model(), output_type=Adjudication, instructions=_INSTRUCTIONS)


def _format_conflicts(conflicts: list[Conflict]) -> str:
    """Render all conflicts into one prompt, each tagged with a stable C# ref and
    grounded with its retrieved clinical guidelines (deterministic, not an LLM step)."""
    retrieved = retrieve_for_conflicts(conflicts)
    blocks = []
    for i, c in enumerate(conflicts, start=1):
        parties = "\n".join(
            f"    - {p.source_type.value} ({p.record_id}, {p.record_date}): {p.value}"
            for p in c.parties
        )
        guidelines = "\n".join(
            f"    [{g.guideline_id}] {g.title}: {g.body} ({g.source})"
            for g, _score in retrieved.get(i, [])
        )
        blocks.append(
            f"Conflict C{i} [{c.conflict_type.value}]: {c.description}\n"
            f"  Parties:\n{parties}\n"
            f"  Detail: {c.detail}\n"
            f"  Retrieved guidelines:\n{guidelines or '    (none relevant)'}"
        )
    return "\n\n".join(blocks)


def adjudicate(conflicts: list[Conflict], patient_context: str = "") -> Adjudication:
    """Run the single batched adjudication call over every detected conflict.

    patient_context carries cluster-level facts (diagnoses, known allergies) that
    individual conflicts don't include, e.g. a recent PCI that makes dual
    antiplatelet therapy intentional rather than an error.
    """
    if not conflicts:
        return Adjudication(decisions=[])
    context_block = f"Patient context: {patient_context}\n\n" if patient_context else ""
    prompt = (
        f"{context_block}"
        f"Adjudicate the following {len(conflicts)} conflict(s) for this patient:\n\n"
        + _format_conflicts(conflicts)
    )
    return _agent.run_sync(prompt).output


def build_patient_context(records: list) -> str:
    """Cluster-level context for the adjudication prompt: diagnoses and allergies."""
    diagnoses = sorted({dx for r in records for dx in getattr(r, "diagnoses", [])})
    allergies = sorted({a for r in records for a in getattr(r, "allergies", [])})
    parts = []
    if diagnoses:
        parts.append("diagnoses on record: " + "; ".join(diagnoses))
    if allergies:
        parts.append("allergies on record: " + ", ".join(allergies))
    return ". ".join(parts)
