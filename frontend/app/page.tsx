"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getPatients } from "@/lib/api";
import { streamReconcile } from "@/lib/stream";
import type {
  ActionReview,
  Conflict,
  ExecutedAction,
  MatchEvidence,
  Patient,
  ReconciledRecord,
  ReconciliationMeta,
  ReviewResult,
  Severity,
} from "@/lib/types";

const SEVERITY_STYLES: Record<Severity, string> = {
  critical: "bg-red-100 text-red-800 border-red-300",
  high: "bg-orange-100 text-orange-800 border-orange-300",
  moderate: "bg-amber-100 text-amber-800 border-amber-300",
  low: "bg-slate-100 text-slate-700 border-slate-300",
};

const normRef = (r: string) => r.match(/C\d+/i)?.[0]?.toUpperCase() ?? r;

export default function Home() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [matchEvidence, setMatchEvidence] = useState<MatchEvidence[] | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [actions, setActions] = useState<ExecutedAction[] | null>(null);
  const [reconciled, setReconciled] = useState<ReconciledRecord | null>(null);
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [meta, setMeta] = useState<ReconciliationMeta | null>(null);

  const closeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    getPatients().then(setPatients).catch((e) => setLoadError(String(e)));
    return () => closeRef.current?.();
  }, []);

  const actionsByRef = useMemo(() => {
    const m: Record<string, ExecutedAction> = {};
    (actions ?? []).forEach((a) => (m[normRef(a.conflict_ref)] = a));
    return m;
  }, [actions]);

  const reviewsByRef = useMemo(() => {
    const m: Record<string, ActionReview> = {};
    (review?.reviews ?? []).forEach((r) => (m[normRef(r.conflict_ref)] = r));
    return m;
  }, [review]);

  function onReconcile() {
    if (!selectedId) return;
    closeRef.current?.();
    setRunning(true);
    setError(null);
    setMatchEvidence(null);
    setConflicts(null);
    setActions(null);
    setReconciled(null);
    setReview(null);
    setMeta(null);

    closeRef.current = streamReconcile(selectedId, {
      onMatched: (d) => setMatchEvidence(d.match_evidence),
      onDetected: (d) => setConflicts(d.conflicts),
      onExecuted: (d) => {
        setActions(d.actions);
        setReconciled(d.reconciled_record);
      },
      onReviewed: (d) => setReview(d.review),
      onDone: (d) => {
        setMeta(d.meta);
        setRunning(false);
      },
      onError: (msg) => {
        setError(msg);
        setRunning(false);
      },
    });
  }

  const steps = [
    { label: "Match identity", done: !!matchEvidence },
    { label: "Detect conflicts", done: !!conflicts },
    { label: "Adjudicate (LLM 1)", done: !!actions },
    { label: "Execute", done: !!reconciled },
    { label: "Review (LLM 2)", done: !!review },
  ];
  const activeIndex = steps.findIndex((s) => !s.done);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Concord</h1>
        <p className="mt-1 text-zinc-500">
          Autonomous clinical-record reconciliation — watch the agent run, no human input.
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
                disabled={running}
                className={`rounded-xl border p-4 text-left transition disabled:opacity-60 ${
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

      {error && (
        <div className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}

      {/* Loop progress */}
      {(running || meta) && (
        <ol className="mt-8 flex flex-wrap gap-2">
          {steps.map((s, i) => {
            const active = running && i === activeIndex;
            return (
              <li
                key={s.label}
                className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${
                  s.done
                    ? "border-green-300 bg-green-50 text-green-700"
                    : active
                    ? "border-blue-300 bg-blue-50 text-blue-700"
                    : "border-zinc-200 text-zinc-400"
                }`}
              >
                <span>{s.done ? "✓" : active ? "⏳" : "○"}</span>
                {s.label}
              </li>
            );
          })}
        </ol>
      )}

      {/* 1. Identity resolution */}
      {matchEvidence && (
        <Panel title="Identity resolution">
          <ul className="space-y-1.5 text-sm">
            {matchEvidence.map((e) => (
              <li key={e.record_id} className="flex items-center gap-3">
                <DecisionBadge decision={e.decision} />
                <span className="font-mono text-xs text-zinc-500">{e.record_id}</span>
                <span className="w-28 truncate">{e.full_name}</span>
                {e.similarity != null && (
                  <span className="text-xs text-zinc-400">sim {e.similarity.toFixed(3)}</span>
                )}
                <span className="text-zinc-500">— {e.reason}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* 2 + 3. Conflicts, enriched with verdicts as they arrive */}
      {conflicts && (
        <Panel title={`Conflicts detected (${conflicts.length})`}>
          <div className="space-y-3">
            {conflicts.map((c, i) => {
              const ref = `C${i + 1}`;
              const action = actionsByRef[ref];
              const rev = reviewsByRef[ref];
              return (
                <div key={ref} className="rounded-lg border border-zinc-200 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                      {c.conflict_type.replace(/_/g, " ")}
                    </span>
                    {action ? (
                      <SeverityBadge severity={action.severity} />
                    ) : (
                      <span className="text-xs text-blue-600">adjudicating…</span>
                    )}
                  </div>
                  <p className="mt-1 text-sm">{c.description}</p>
                  {action && (
                    <div className="mt-2 border-t border-zinc-100 pt-2 text-sm">
                      <p>
                        <span className="text-zinc-400">Action:</span>{" "}
                        <span className="font-medium">{action.action.replace(/_/g, " ")}</span>
                      </p>
                      <p className="text-zinc-600">{action.detail}</p>
                      {rev && (
                        <p className="mt-1 text-xs text-zinc-500">
                          confidence: <b>{rev.confidence}</b>
                          {rev.escalate ? " · escalated to human" : " · autonomous"}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {/* 4. Reconciled record */}
      {reconciled && (
        <Panel title="Reconciled record">
          <div className="text-sm">
            <p className="font-medium">{reconciled.identity.full_name}</p>
            <p className="text-zinc-500">
              DOB {reconciled.identity.date_of_birth ?? "—"} · NIC {reconciled.identity.nic ?? "—"} · from{" "}
              {reconciled.source_record_ids.join(", ")}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Medications" items={reconciled.medications.map((m) => `${m.name} ${m.dose ?? ""}`.trim())} />
              <Field label="Allergies" items={reconciled.allergies} />
              <Field label="Diagnoses" items={reconciled.diagnoses} />
              <Field label="Applied changes" items={reconciled.applied_changes} />
            </div>
          </div>
        </Panel>
      )}

      {/* 5. Review / escalation */}
      {review && (
        <div
          className={`mt-6 rounded-xl border p-5 ${
            review.escalate_to_human
              ? "border-amber-300 bg-amber-50"
              : "border-green-300 bg-green-50"
          }`}
        >
          <h2 className="font-medium">
            {review.escalate_to_human
              ? "⚠ Human review requested"
              : "✓ Fully autonomous — no human input needed"}
          </h2>
          <p className="mt-1 text-sm text-zinc-700">{review.summary}</p>
        </div>
      )}

      {/* meta */}
      {meta && (
        <p className="mt-4 text-xs text-zinc-400">
          {meta.llm_calls} LLM calls · {meta.cluster_size} records matched · {meta.conflicts_found} conflicts ·{" "}
          {meta.actions_taken} actions
        </p>
      )}
    </main>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-xl border border-zinc-200 p-5">
      <h2 className="mb-3 font-medium">{title}</h2>
      {children}
    </section>
  );
}

function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[severity]}`}>
      {severity}
    </span>
  );
}

function DecisionBadge({ decision }: { decision: string }) {
  const styles: Record<string, string> = {
    confirmed: "bg-green-100 text-green-700",
    rejected: "bg-red-100 text-red-700",
    uncertain: "bg-amber-100 text-amber-700",
  };
  return (
    <span className={`w-20 rounded px-2 py-0.5 text-center text-xs font-medium ${styles[decision] ?? ""}`}>
      {decision}
    </span>
  );
}

function Field({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-zinc-400">{label}</p>
      {items.length ? (
        <ul className="list-inside list-disc text-zinc-700">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      ) : (
        <p className="text-zinc-400">—</p>
      )}
    </div>
  );
}
