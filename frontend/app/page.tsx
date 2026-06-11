"use client";

import { useEffect, useState } from "react";
import { getPatients, reconcile } from "@/lib/api";
import type { Patient, ReconciliationResult } from "@/lib/types";

export default function Home() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ReconciliationResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    getPatients()
      .then(setPatients)
      .catch((e) => setLoadError(String(e)));
  }, []);

  async function onReconcile() {
    if (!selectedId) return;
    setRunning(true);
    setResult(null);
    setRunError(null);
    try {
      setResult(await reconcile(selectedId));
    } catch (e) {
      setRunError(String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Concord</h1>
        <p className="mt-1 text-zinc-500">
          Autonomous clinical-record reconciliation. Pick a patient and let the agent run.
        </p>
      </header>

      {loadError && (
        <div className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          Could not reach the backend. Is it running on :8000? ({loadError})
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">
          Select a patient (clinic record)
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {patients.map((p) => {
            const selected = p.record_id === selectedId;
            return (
              <button
                key={p.record_id}
                onClick={() => setSelectedId(p.record_id)}
                className={`rounded-xl border p-4 text-left transition ${
                  selected
                    ? "border-blue-500 bg-blue-50 ring-2 ring-blue-200"
                    : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50"
                }`}
              >
                <div className="font-medium">{p.full_name}</div>
                <div className="text-sm text-zinc-500">{p.record_id}</div>
                <div className="mt-1 text-xs text-zinc-400">
                  {p.source_name} · {p.record_date}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <div className="mt-8">
        <button
          onClick={onReconcile}
          disabled={!selectedId || running}
          className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
        >
          {running ? "Reconciling…" : "Reconcile"}
        </button>
      </div>

      {runError && (
        <div className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          {runError}
        </div>
      )}

      {result && (
        <section className="mt-6 rounded-xl border border-zinc-200 p-5">
          <h2 className="mb-3 font-medium">
            Reconciliation complete — {result.entry_record_id}
          </h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <Stat label="LLM calls" value={result.meta.llm_calls} />
            <Stat label="Records matched" value={result.meta.cluster_size} />
            <Stat label="Conflicts" value={result.meta.conflicts_found} />
            <Stat label="Actions taken" value={result.meta.actions_taken} />
            <Stat label="Escalated" value={result.meta.escalated ? "Yes" : "No"} />
          </dl>
          <p className="mt-4 text-xs text-zinc-400">
            (Step 14b replaces this summary with a live, stage-by-stage reveal.)
          </p>
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-zinc-400">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  );
}
