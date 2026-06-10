"""Adjudication — LLM Call 1: batch ALL conflicts into ONE structured call.

This is the architectural centerpiece: no matter how many conflicts the detector
found, they are formatted into a single prompt and adjudicated in one request that
returns structured JSON (one verdict per conflict). The LLM applies trust
principles (provenance / recency / corroboration / source role) and we get back a
typed Adjudication, validated by PydanticAI against our models.
"""

from pydantic_ai import Agent

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

For every conflict return: the conflict_ref EXACTLY as given; a short concrete
trusted_value; reasoning of 1-2 sentences that cites provenance/recency/corroboration;
a severity (low|moderate|high|critical); and exactly one action
(prescriber_alert|reconcile_record|generate_referral|no_action).
"""

# Built once; reused for every reconciliation.
_agent = Agent(get_model(), output_type=Adjudication, instructions=_INSTRUCTIONS)


def _format_conflicts(conflicts: list[Conflict]) -> str:
    """Render all conflicts into one prompt, each tagged with a stable C# ref."""
    blocks = []
    for i, c in enumerate(conflicts, start=1):
        parties = "\n".join(
            f"    - {p.source_type.value} ({p.record_id}, {p.record_date}): {p.value}"
            for p in c.parties
        )
        blocks.append(
            f"Conflict C{i} [{c.conflict_type.value}]: {c.description}\n"
            f"  Parties:\n{parties}\n"
            f"  Detail: {c.detail}"
        )
    return "\n\n".join(blocks)


def adjudicate(conflicts: list[Conflict]) -> Adjudication:
    """Run the single batched adjudication call over every detected conflict."""
    if not conflicts:
        return Adjudication(decisions=[])
    prompt = (
        f"Adjudicate the following {len(conflicts)} conflict(s) for this patient:\n\n"
        + _format_conflicts(conflicts)
    )
    return _agent.run_sync(prompt).output
