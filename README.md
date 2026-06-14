# Concord

An autonomous, voice-controlled clinical-record reconciliation agent.

In Sri Lanka a patient's records are scattered across clinics, labs, and pharmacies
with **no shared patient ID**. Given a single record ID, Concord autonomously pulls
the fragmented records, fuzzy-matches the patient's identity across sources via
vector similarity, detects clinical contradictions (conflicting doses, allergy
violations, dangerous drug interactions), adjudicates which source to trust using
provenance + recency + corroboration **grounded in retrieved clinical guidelines**,
executes safety actions, and escalates only the cases it is not confident about.
No human input after the record ID is entered.

> **Honest scope:** the *intelligence* is real: real embeddings, real vector
> search, real retrieval-augmented grounding, real LLM adjudication. The *source
> integrations* are mocked: data comes from three seeded fake datasets (clinic, lab,
> pharmacy) with deliberately planted contradictions. The agent parses and validates
> them through the same models it would use for live feeds, so only the *fetch* is
> mocked, not the downstream reasoning.

## Why this is an AI agent (not an LLM wrapper)

1. **Autonomy.** One input (a record ID), then the agent runs a full multi-step loop
   and produces concrete artifacts (prescriber alerts, referral packets, and one
   merged reconciled record) with no human in the loop.
2. **Tool use & structured action.** It queries a vector database, retrieves
   guidelines, and emits typed actions (`prescriber_alert`, `reconcile_record`,
   `generate_referral`, `no_action`) that are schema-validated by PydanticAI.
3. **Self-judgement & escalation.** The final step is the agent reviewing its own
   work and deciding when it is too unsure to act alone, escalating *only*
   low-confidence or ambiguous actions, and staying autonomous otherwise.

## The agentic loop

Defined end-to-end in [`orchestrator.py`](backend/app/orchestrator.py):

| # | Step | LLM? | Code |
|---|------|------|------|
| 1 | **Match identity**: fan out, vector-recall candidates, hybrid-confirm the same patient across sources | no (code) | [`matcher.py`](backend/app/matcher.py) |
| 2 | **Detect conflicts**: deterministic clinical rules surface contradictions (facts only) | no (code) | [`detector.py`](backend/app/detector.py) |
| 3 | **Adjudicate**: batch *all* conflicts into ONE call → structured per-conflict verdicts | **LLM call 1** | [`adjudicator.py`](backend/app/adjudicator.py) |
| 4 | **Execute**: build safety-action artifacts + assemble the merged reconciled record | no (code) | [`executor.py`](backend/app/executor.py) |
| 5 | **Review**: score confidence per action, escalate only the uncertain ones | **LLM call 2** | [`reviewer.py`](backend/app/reviewer.py) |

**Exactly two LLM calls per reconciliation, regardless of conflict count.** Every
conflict is batched into the single adjudication call; every action into the single
review call. This is a deliberate cost, latency, and determinism choice: the
deterministic layers do the heavy lifting and the LLM is reserved for the judgement
that genuinely needs reasoning. The whole loop streams to the UI stage-by-stage over
Server-Sent Events.

## RAG: two vector systems, one local model

Both retrieval systems use the same free, offline embedding model
(`all-MiniLM-L6-v2`, 384-dim, CPU-only, no paid embedding API).

### 1. Identity-matching retrieval: finding the same patient across sources

Sources share no ID, so identity is resolved by **vector similarity + deterministic
corroboration** ([`embeddings.py`](backend/app/embeddings.py),
[`matcher.py`](backend/app/matcher.py), [`db.py`](backend/app/db.py)):

- A patient's *soft* identity (name + DOB + gender) is embedded and stored in
  **Supabase/pgvector**.
- Matching does a cosine-similarity **recall** (the `match_records` SQL function in
  [`schema.sql`](backend/db/schema.sql)) to shortlist candidates, then a **hybrid
  confirm**: vector score alone is explicitly not trusted (a one-letter name twin can
  out-score a real abbreviated match), so it **hard-rejects** on any DOB/gender
  conflict and only **confirms** on exact NIC, DOB + phone, or DOB + strong vector.
- Every decision carries a human-readable reason, shown as an audit table in the UI.

### 2. Clinical-guideline retrieval: grounding the LLM's verdicts

This is the classic "RAG to ground an LLM" pattern ([`guidelines.py`](backend/app/guidelines.py)):

- A curated corpus of Sri Lankan clinical guidelines is embedded once.
- For **each** detected conflict, the top-relevant guidelines (cosine similarity above
  a threshold) are retrieved and injected into the single adjudication prompt.
- The LLM therefore decides **grounded in cited guidance** (e.g. `SLNF-ANTI-014`)
  rather than from memory, and records which guideline IDs it relied on, surfaced in
  the UI and the voice answers as citations.
- Retrieval is plain in-process code (numpy dot product over unit vectors), so it adds
  **zero** LLM calls; the count stays exactly 2.

## Voice control (Vapi), browser-orchestrated

Voice is a **conversation layer over a reconciliation the clinician has already run**
([`voice.ts`](frontend/lib/voice.ts), [`page.tsx`](frontend/app/page.tsx)). The
clinician selects a patient and runs the reconciliation themselves, then talks to the
assistant about the result. The key design point: **the browser page stays the
orchestrator, and Vapi's cloud never touches the backend.**

- **Vapi** handles speech-to-text (Deepgram `nova-3-medical`), the conversational LLM
  (GPT-4o), and text-to-speech.
- The assistant **never identifies patients or starts runs from speech**. That was
  unreliable with mis-transcribed Sinhala names, so patient selection is deliberate
  (click or the roster search), and voice is reserved for the part it does well: Q&A.
- When a run finishes, the page formats the full result and sends it to the assistant
  as a system message (a call that connects *after* a run is handed the latest result
  on connect). The assistant speaks a short summary, then answers detailed follow-ups
  (exact doses, dates, sources, confidence, guideline IDs) **strictly from that result
  data**, with no medical advice beyond it. If asked before any run, it tells the
  clinician to run one first.

## End-to-end flow

```text
Clinician picks/says a patient
        │
        ▼
1. match_patient      pgvector recall ──► hybrid confirm (NIC / DOB+phone / DOB+vector)
2. detect_conflicts   clinical_kb rules ──► dose clashes, allergy blocks, interactions
3. adjudicate         retrieve guidelines (RAG) ──► LLM CALL 1 ──► structured verdicts
4. execute            build alerts/referrals + merged reconciled record
5. review             LLM CALL 2 ──► confidence + escalate only if unsure
        │
        ▼
Reconciled record + audit trail (streamed live; spoken back over Vapi)
```

## Stack

| Layer | Choice |
|-------|--------|
| LLM | Gemini 2.0 Flash (primary) → Groq fallback, behind one PydanticAI interface ([`llm.py`](backend/app/llm.py)) |
| Agent framework | PydanticAI, typed schema-validated structured outputs |
| Backend | FastAPI (Python 3.11), streaming over Server-Sent Events |
| DB + vectors | Supabase with pgvector (HNSW cosine index) |
| Embeddings | local `sentence-transformers` (free, offline, no paid API) |
| Frontend | Next.js 15 (App Router) + Tailwind, live SSE worksheet |
| Voice | Vapi (Deepgram STT + GPT-4o + TTS), browser-orchestrated |

## Repo layout

```text
concord/
├── backend/                  # FastAPI app (Python 3.11)
│   ├── app/
│   │   ├── orchestrator.py   # the 5-step autonomous loop
│   │   ├── matcher.py        # step 1: hybrid identity matching (vector + rules)
│   │   ├── detector.py       # step 2: deterministic conflict detection
│   │   ├── clinical_kb.py    #   curated drug/allergy/interaction rulebook
│   │   ├── adjudicator.py    # step 3: LLM call 1 (batched, RAG-grounded)
│   │   ├── guidelines.py     #   clinical-guideline corpus + vector retrieval
│   │   ├── executor.py       # step 4: build actions + reconciled record
│   │   ├── reviewer.py       # step 5: LLM call 2 (confidence + escalation)
│   │   ├── embeddings.py     # local MiniLM identity embeddings
│   │   ├── db.py             # Supabase persistence + pgvector search
│   │   ├── llm.py            # Gemini→Groq fallback model
│   │   ├── models.py         # Pydantic domain models (the contracts)
│   │   ├── main.py           # FastAPI routes + SSE stream
│   │   └── seed/             # mock clinic / lab / pharmacy datasets
│   ├── db/schema.sql         # pgvector schema + match_records function
│   ├── requirements.txt
│   └── .env.example
└── frontend/                 # Next.js 15
    ├── app/page.tsx          # live worksheet + voice orchestration
    └── lib/
        ├── stream.ts         # SSE client
        ├── voice.ts          # Vapi session
        └── api.ts            # REST client
```

## Running it

### Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows  (use: source .venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Set `backend/.env` from `.env.example` (`SUPABASE_URL`, `SUPABASE_KEY`,
`GEMINI_API_KEY` and/or `GROQ_API_KEY`). Apply [`db/schema.sql`](backend/db/schema.sql)
once in the Supabase SQL editor, then `POST /seed` to load the mock datasets.

Health check: <http://127.0.0.1:8000/health>

### Loading your own data

The seeded datasets are just a demo starting point. To ingest real (or more) data,
`POST /records` a JSON array of source records and they are validated, embedded, and
indexed exactly like the seed data, so the reconciliation engine is not limited to
the bundled patients:

```bash
curl -X POST http://127.0.0.1:8000/records \
  -H "Content-Type: application/json" \
  -d '[{"record_id":"NWK-2001","source_type":"clinic",
        "source_name":"Nawaloka Medical Centre, Colombo 05","record_date":"2026-06-10",
        "identity":{"full_name":"Anoma Silva","date_of_birth":"1979-02-11","nic":"795551234V","gender":"F"},
        "diagnoses":["Essential hypertension"],
        "medications":[{"name":"Amlodipine","dose":"5mg","frequency":"OD"}],"allergies":[]}]'
```

Each record's `source_type` (`clinic` / `lab` / `pharmacy`) selects its schema.
Upserts are keyed by `record_id`, so re-posting updates a record in place. The roster
search box then finds any uploaded patient by name, record id, or NIC.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Set `NEXT_PUBLIC_API_URL` (defaults to `http://127.0.0.1:8000`) and, for voice,
`NEXT_PUBLIC_VAPI_PUBLIC_KEY`. Open <http://localhost:3000>.

## API

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/health` | Liveness probe |
| `POST` | `/seed` | Load the mock clinic/lab/pharmacy datasets (idempotent) |
| `POST` | `/records` | Ingest a JSON array of source records (validated, embedded, upserted) |
| `GET` | `/patients` | Clinic records, the valid entry points for the roster |
| `GET` | `/search?q=` | Find clinic entry records by name, record id, or NIC |
| `GET` | `/reconcile/{record_id}` | Run the full loop, return the bundled result |
| `GET` | `/reconcile/{record_id}/stream` | Run the loop, stream each stage as SSE |
