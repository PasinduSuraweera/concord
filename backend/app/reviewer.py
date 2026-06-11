"""Review + escalation — LLM Call 2 (the second and final LLM call).

The agent reviews the actions it just took and decides, per action, how confident
it should be and whether a human needs to look. It escalates ONLY low-confidence
or ambiguous cases — a well-corroborated critical alert stays autonomous — which is
what preserves "no human input after the patient ID" for confident reconciliations.
"""

import re

from pydantic_ai import Agent

from app.llm import get_model
from app.models import ExecutionResult, ReviewResult

_INSTRUCTIONS = """\
You are Concord's safety reviewer. You are given the actions the agent just took to
reconcile ONE patient's records. For each action decide how CONFIDENT the agent
should be, and whether a human must review it.

Judge confidence from the strength of the evidence behind the action:
- high: the trusted value is corroborated by multiple sources, recent, and clear.
- medium: reasonable but with some uncertainty (a single source, or a close call).
- low: thin, conflicting, or ambiguous evidence.

Escalate to a human ONLY for low-confidence or genuinely ambiguous actions. Do NOT
escalate an action merely because it is severe: a well-corroborated critical alert
is still high-confidence and should stay autonomous. The aim is a fully autonomous
pipeline except where the agent is genuinely unsure.

Return, for each action: its conflict_ref as the bare token (e.g. "C1"); a
confidence (low|medium|high); an escalate boolean; and a one-line note. Also return
a single one-line overall summary.
"""

_agent = Agent(get_model(), output_type=ReviewResult, instructions=_INSTRUCTIONS)


def _format_actions(execution: ExecutionResult) -> str:
    blocks = []
    for a in execution.actions:
        parties = "; ".join(
            f"{p.get('source')}={p.get('value')}" for p in a.payload.get("parties", [])
        )
        blocks.append(
            f"Action {a.conflict_ref} [{a.conflict_type.value}] "
            f"severity={a.severity.value} action={a.action.value}\n"
            f"  Detail: {a.detail}\n"
            f"  Evidence: {parties}"
        )
    return "\n\n".join(blocks)


def review(execution: ExecutionResult) -> ReviewResult:
    """Run the single review call over every executed action."""
    if not execution.actions:
        return ReviewResult(reviews=[], escalate_to_human=False, summary="No actions to review.")

    prompt = (
        f"Review these {len(execution.actions)} executed action(s) and flag any that "
        f"need a human:\n\n" + _format_actions(execution)
    )
    result = _agent.run_sync(prompt).output

    # Normalize refs the model echoed back, and derive the overall flag from the
    # per-action flags so the two can never disagree.
    for r in result.reviews:
        match = re.search(r"[Cc](\d+)", r.conflict_ref)
        if match:
            r.conflict_ref = f"C{match.group(1)}"
    result.escalate_to_human = any(r.escalate for r in result.reviews)
    return result
