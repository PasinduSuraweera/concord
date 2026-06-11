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

const SEVERITY: Record<Severity, { chip: string; bar: string; glow: string }> = {
  critical: { chip: "border-red-500/40 bg-red-500/10 text-red-300", bar: "bg-red-500", glow: "glow-red" },
  high: { chip: "border-orange-500/40 bg-orange-500/10 text-orange-300", bar: "bg-orange-500", glow: "" },
  moderate: { chip: "border-amber-500/40 bg-amber-500/10 text-amber-300", bar: "bg-amber-500", glow: "" },
  low: { chip: "border-slate-500/40 bg-slate-500/10 text-slate-300", bar: "bg-slate-500", glow: "" },
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
    { label: "Match", done: !!matchEvidence },
    { label: "Detect", done: !!conflicts },
    { label: "Adjudicate", done: !!actions },
    { label: "Execute", done: !!reconciled },
    { label: "Review", done: !!review },
  ];
  const activeIndex = steps.findIndex((s) => !s.done);
  const started = running || !!meta;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-white/10 pb-5">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-cyan-400" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-[0.3em] text-white">CONCORD</h1>
            <p className="text-xs tracking-wide text-slate-400">
              Autonomous clinical-record reconciliation
            </p>
          </div>
        </div>
        <StatusPill running={running} meta={meta} />
      </header>

      {loadError && (
        <div className="mt-6 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          Can&apos;t reach the backend on :8000. ({loadError})
        </div>
      )}

      {/* Patient picker + run */}
      <section className="mt-7">
        <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500">
          Patient
        </p>
        <div className="flex flex-wrap items-center gap-2.5">
          {patients.map((p) => {
            const sel = p.record_id === selectedId;
            return (
              <button
                key={p.record_id}
                onClick={() => setSelectedId(p.record_id)}
                disabled={running}
                className={`group rounded-xl border px-4 py-2.5 text-left transition disabled:opacity-50 ${
                  sel
                    ? "border-cyan-400/60 bg-cyan-400/10 glow-cyan"
                    : "border-white/10 bg-white/[0.03] hover:border-white/25"
                }`}
              >
                <div className="text-sm font-medium text-white">{p.full_name}</div>
                <div className="mono text-[11px] text-slate-400">{p.record_id}</div>
              </button>
            );
          })}

          <button
            onClick={onReconcile}
            disabled={!selectedId || running}
            className="ml-auto rounded-xl bg-cyan-500 px-6 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-500 enabled:glow-cyan"
          >
            {running ? "Reconciling…" : "▸ Reconcile"}
          </button>
        </div>
      </section>

      {error && (
        <div className="mt-6 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Pipeline */}
      {started && <Pipeline steps={steps} activeIndex={activeIndex} running={running} />}

      {/* Identity resolution */}
      {matchEvidence && (
        <Panel title="Identity resolution" subtitle={`${matchEvidence.filter((e) => e.decision === "confirmed").length} confirmed · ${matchEvidence.length} candidates`}>
          <div className="space-y-1">
            {matchEvidence.map((e) => (
              <div
                key={e.record_id}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${
                  e.decision === "confirmed" ? "bg-green-500/[0.06]" : "bg-white/[0.02]"
                }`}
              >
                <DecisionMark decision={e.decision} />
                <span className="mono w-24 shrink-0 text-xs text-slate-400">{e.record_id}</span>
                <span className="w-32 shrink-0 truncate text-slate-200">{e.full_name}</span>
                {e.similarity != null && <SimBar value={e.similarity} />}
                <span className="hidden flex-1 truncate text-xs text-slate-500 sm:block">{e.reason}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* Conflicts + verdicts */}
      {conflicts && (
        <Panel title="Conflicts" subtitle={`${conflicts.length} detected`}>
          {conflicts.length === 0 ? (
            <p className="text-sm text-slate-400">No contradictions found across the sources.</p>
          ) : (
            <div className="space-y-3">
              {conflicts.map((c, i) => {
                const ref = `C${i + 1}`;
                const action = actionsByRef[ref];
                const rev = reviewsByRef[ref];
                const sev = action ? SEVERITY[action.severity] : null;
                return (
                  <div
                    key={ref}
                    className={`relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] p-4 pl-5 ${
                      sev?.glow ?? ""
                    }`}
                  >
                    <span className={`absolute inset-y-0 left-0 w-1 ${sev?.bar ?? "bg-white/15"}`} />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-400">
                        {c.conflict_type.replace(/_/g, " ")}
                      </span>
                      {action ? (
                        <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${sev!.chip}`}>
                          {action.severity}
                        </span>
                      ) : (
                        <span className="text-xs text-cyan-300">adjudicating…</span>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm text-slate-200">{c.description}</p>
                    {action && (
                      <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="rounded bg-cyan-400/10 px-2 py-1 font-medium text-cyan-300">
                            {action.action.replace(/_/g, " ")}
                          </span>
                          {rev && <ConfidencePill review={rev} />}
                        </div>
                        <p className="text-xs leading-relaxed text-slate-400">{action.detail}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      )}

      {/* Reconciled record */}
      {reconciled && (
        <Panel title="Reconciled record" subtitle={`merged from ${reconciled.source_record_ids.length} sources`}>
          <div className="mb-4">
            <p className="text-base font-semibold text-white">{reconciled.identity.full_name}</p>
            <p className="mono text-xs text-slate-400">
              DOB {reconciled.identity.date_of_birth ?? "—"} · NIC {reconciled.identity.nic ?? "—"} ·{" "}
              {reconciled.source_record_ids.join(" + ")}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <ChipField label="Medications" items={reconciled.medications.map((m) => `${m.name} ${m.dose ?? ""}`.trim())} />
            <ChipField label="Allergies" items={reconciled.allergies} tone="danger" />
            <ChipField label="Diagnoses" items={reconciled.diagnoses} />
          </div>
          {reconciled.applied_changes.length > 0 && (
            <div className="mt-4 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.04] p-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-cyan-300">
                Applied changes
              </p>
              <ul className="space-y-1 text-xs text-slate-300">
                {reconciled.applied_changes.map((ch, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-cyan-400">↻</span>
                    {ch}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      )}

      {/* Autonomy banner */}
      {review && (
        <div
          className={`rise mt-6 overflow-hidden rounded-2xl border p-6 text-center ${
            review.escalate_to_human
              ? "border-amber-500/40 bg-amber-500/10 glow-amber"
              : "border-green-500/40 bg-green-500/10 glow-green"
          }`}
        >
          <p className={`text-lg font-semibold ${review.escalate_to_human ? "text-amber-300" : "text-green-300"}`}>
            {review.escalate_to_human ? "⚠  Human review requested" : "✓  Fully autonomous — no human input needed"}
          </p>
          <p className="mt-1 text-sm text-slate-300">{review.summary}</p>
        </div>
      )}

      {/* Meta */}
      {meta && (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetaTile label="LLM calls" value={meta.llm_calls} accent />
          <MetaTile label="Records matched" value={meta.cluster_size} />
          <MetaTile label="Conflicts" value={meta.conflicts_found} />
          <MetaTile label="Actions" value={meta.actions_taken} />
        </div>
      )}
    </main>
  );
}

function StatusPill({ running, meta }: { running: boolean; meta: ReconciliationMeta | null }) {
  let text = "Idle";
  let cls = "border-white/15 text-slate-400";
  let dot = "bg-slate-500";
  if (running) {
    text = "Reconciling";
    cls = "border-cyan-400/40 text-cyan-300";
    dot = "bg-cyan-400 animate-pulse";
  } else if (meta) {
    text = meta.escalated ? "Escalated" : "Autonomous";
    cls = meta.escalated ? "border-amber-400/40 text-amber-300" : "border-green-400/40 text-green-300";
    dot = meta.escalated ? "bg-amber-400" : "bg-green-400";
  }
  return (
    <span className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {text}
    </span>
  );
}

function Pipeline({ steps, activeIndex, running }: { steps: { label: string; done: boolean }[]; activeIndex: number; running: boolean }) {
  const doneCount = steps.filter((s) => s.done).length;
  const frac = doneCount <= 1 ? 0 : (doneCount - 1) / (steps.length - 1);
  return (
    <div className="rise mt-8 rounded-2xl border border-white/10 bg-white/[0.02] px-6 py-6">
      <div className="relative flex justify-between">
        <div className="absolute left-4 right-4 top-4 h-0.5 bg-white/10" />
        <div
          className={`absolute left-4 top-4 h-0.5 bg-cyan-400/70 transition-all duration-500 ${running ? "flow" : ""}`}
          style={{ width: `calc((100% - 2rem) * ${frac})` }}
        />
        {steps.map((s, i) => {
          const active = running && i === activeIndex;
          return (
            <div key={s.label} className="relative z-10 flex flex-col items-center gap-2">
              <span
                className={`flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold transition ${
                  s.done
                    ? "border-green-400/60 bg-green-500/20 text-green-300 glow-green"
                    : active
                    ? "breathe border-cyan-400 bg-cyan-400/20 text-cyan-200"
                    : "border-white/15 bg-slate-900 text-slate-500"
                }`}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <span className={`text-[11px] ${s.done ? "text-slate-300" : active ? "text-cyan-300" : "text-slate-500"}`}>
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rise mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-[0.15em] text-slate-300">{title}</h2>
        {subtitle && <span className="text-xs text-slate-500">{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

function DecisionMark({ decision }: { decision: string }) {
  const map: Record<string, string> = {
    confirmed: "bg-green-500/20 text-green-300",
    rejected: "bg-red-500/20 text-red-300",
    uncertain: "bg-amber-500/20 text-amber-300",
  };
  const sym: Record<string, string> = { confirmed: "✓", rejected: "✕", uncertain: "?" };
  return (
    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs font-bold ${map[decision] ?? ""}`}>
      {sym[decision] ?? "•"}
    </span>
  );
}

function SimBar({ value }: { value: number }) {
  return (
    <span className="flex w-20 shrink-0 items-center gap-1.5">
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
        <span className="block h-full rounded-full bg-cyan-400/70" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className="mono text-[10px] text-slate-500">{value.toFixed(2)}</span>
    </span>
  );
}

function ConfidencePill({ review }: { review: ActionReview }) {
  const map = { high: "text-green-300", medium: "text-amber-300", low: "text-red-300" };
  return (
    <span className="text-slate-500">
      confidence <b className={map[review.confidence]}>{review.confidence}</b>
      {review.escalate ? " · escalated" : " · autonomous"}
    </span>
  );
}

function ChipField({ label, items, tone }: { label: string; items: string[]; tone?: "danger" }) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      {items.length ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it, i) => (
            <span
              key={i}
              className={`rounded-md border px-2 py-1 text-xs ${
                tone === "danger"
                  ? "border-red-500/30 bg-red-500/10 text-red-300"
                  : "border-white/10 bg-white/5 text-slate-200"
              }`}
            >
              {it}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-600">—</p>
      )}
    </div>
  );
}

function MetaTile({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-center">
      <div className={`text-2xl font-bold ${accent ? "text-cyan-300" : "text-white"}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );
}
