# Concord

An autonomous clinical-record reconciliation agent.

Sri Lankan patient records are scattered across clinics, labs, and pharmacies with
no shared ID. Given a single patient ID, Concord autonomously pulls fragmented
records, fuzzy-matches patient identity across sources via vector similarity,
detects clinical contradictions (conflicting medications, allergy mismatches,
dangerous drug interactions), adjudicates which source to trust using provenance +
recency + corroboration, executes safety actions, and escalates only low-confidence
cases. No human input after the patient ID is entered.

> **Honest scope:** the *intelligence* is real (embeddings, identity matching,
> conflict detection, LLM adjudication). The *integrations* are mocked — data comes
> from three seeded fake datasets with deliberately planted contradictions.

## The agentic loop

1. **[code]** Fan out, pull records from sources, vector-match identity via pgvector.
2. **[code]** Detect conflicts deterministically (rules, not the LLM).
3. **[LLM call 1]** Batch *all* conflicts into one adjudication call → structured JSON.
4. **[code]** Execute the actions.
5. **[LLM call 2]** Review actions, flag low-confidence items for human escalation.

Exactly **two** LLM calls per reconciliation, regardless of conflict count — a
deliberate cost, latency, and determinism choice.

## Stack

- **LLM:** Gemini 2.0 Flash (free tier) primary, Groq fallback — behind one interface.
- **Agent framework:** PydanticAI (structured outputs).
- **Backend:** FastAPI (Python 3.11).
- **DB + vectors:** Supabase with pgvector.
- **Frontend:** Next.js 15 (App Router).
- **Embeddings:** local sentence-transformers (free, no paid API).

## Repo layout

```
concord/
├── backend/      # FastAPI app (Python 3.11)
│   ├── app/
│   ├── requirements.txt
│   └── .env.example
└── frontend/     # Next.js 15 (added later)
```

## Running the backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Then open http://127.0.0.1:8000/health
