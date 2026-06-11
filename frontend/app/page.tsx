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

const SEVERITY_TEXT: Record<Severity, string> = {
  critical: "text-red-400",
  high: "text-orange-400",
  moderate: "text-amber-300",
  low: "text-slate-400",
};
const SEVERITY_DOT: Record<Severity, string> = {
  critical: "bg-red-400",
  high: "bg-orange-400",
  moderate: "bg-amber-300",
  low: "bg-slate-500",
};

const normRef = (r: string) => r.match(/C\d+/i)?.[0]?.toUpperCase() ?? r;

type LogEntry = { at: Date; text: string };

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

  const [log, setLog] = useState<LogEntry[]>([]);
  const [durationMs, setDurationMs] = useState<number | null>(null);

  const closeRef = useRef<(() => void) | null>(null);
  const startRef = useRef<number>(0);

  useEffect(() => {
    getPatients().then(setPatients).catch((e) => setLoadError(String(e)));
    return () => closeRef.current?.();
  }, []);

  const addLog = (text: string) => setLog((l) => [...l, { at: new Date(), text }]);

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
    setDurationMs(null);
    setLog([{ at: new Date(), text: `Run started for ${selectedId}` }]);
    startRef.current = performance.now();

    closeRef.current = streamReconcile(selectedId, {
      onMatched: (d) => {
        setMatchEvidence(d.match_evidence);
        const confirmed = d.match_evidence.filter((e) => e.decision === "confirmed").length;
        addLog(`Identity resolved: ${confirmed} of ${d.match_evidence.length} candidate records confirmed`);
      },
      onDetected: (d) => {
        setConflicts(d.conflicts);
        addLog(`Conflict detection: ${d.conflicts.length} contradiction(s) found`);
      },
      onExecuted: (d) => {
        setActions(d.actions);
        setReconciled(d.reconciled_record);
        addLog(`Adjudication complete, ${d.actions.length} action(s) executed`);
      },
      onReviewed: (d) => {
        setReview(d.review);
        addLog(d.review.escalate_to_human ? "Safety review: escalated to human" : "Safety review: cleared, autonomous");
      },
      onDone: (d) => {
        setMeta(d.meta);
        setRunning(false);
        const ms = performance.now() - startRef.current;
        setDurationMs(ms);
        addLog(`Run complete in ${(ms / 1000).toFixed(1)}s with ${d.meta.llm_calls} model call(s)`);
      },
      onError: (msg) => {
        setError(msg);
        setRunning(false);
        addLog("Stream error");
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
    <div className="min-h-screen">
      <header className="flex h-14 items-center justify-between border-b border-white/10 px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-teal-500/15 text-teal-300">
            <IconPulse />
          </span>
          <span className="text-sm font-semibold text-white">Concord</span>
          <span className="text-xs text-slate-500">Clinical record reconciliation</span>
        </div>
        <HeaderStatus running={running} meta={meta} />
      </header>

      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-8 lg:grid-cols-[270px_1fr]">
        {/* Sidebar */}
        <aside>
          <h2 className="mb-2 text-xs font-medium text-slate-500">Patients</h2>
          {loadError && (
            <p className="rounded-md border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-300">
              Backend unreachable on :8000. {loadError}
            </p>
          )}
          <div className="space-y-1">
            {patients.map((p) => {
              const sel = p.record_id === selectedId;
              return (
                <button
                  key={p.record_id}
                  onClick={() => setSelectedId(p.record_id)}
                  disabled={running}
                  className={`w-full rounded-md px-3 py-2 text-left transition disabled:opacity-60 ${
                    sel ? "bg-white/[0.07] text-white" : "text-slate-400 hover:bg-white/[0.03] hover:text-slate-200"
                  }`}
                >
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-medium">{p.full_name}</span>
                    <span className="mono text-[10px] text-slate-500">{p.record_date}</span>
                  </div>
                  <div className="mono text-xs text-slate-500">{p.record_id}</div>
                </button>
              );
            })}
          </div>

          <button
            onClick={onReconcile}
            disabled={!selectedId || running}
            className="mt-4 w-full rounded-md bg-teal-600 py-2 text-sm font-medium text-white transition hover:bg-teal-500 disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-slate-500"
          >
            {running ? "Running" : "Run reconciliation"}
          </button>

          {log.length > 0 && (
            <div className="mt-6">
              <h2 className="mb-2 text-xs font-medium text-slate-500">Activity</h2>
              <ol className="space-y-1.5">
                {log.map((e, i) => (
                  <li key={i} className="flex gap-2 text-xs leading-relaxed">
                    <span className="mono tnum shrink-0 text-slate-600">
                      {e.at.toLocaleTimeString("en-GB", { hour12: false })}
                    </span>
                    <span className="text-slate-400">{e.text}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </aside>

        {/* Main */}
        <main className="min-w-0">
          {!started && (
            <div className="rounded-lg border border-dashed border-white/10 p-12 text-center">
              <p className="text-sm font-medium text-slate-300">No run yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
                Select a patient and run reconciliation. The agent pulls their records from the
                clinic, lab and pharmacy, matches identity, resolves contradictions and reports
                back. Two model calls per run, no human input.
              </p>
            </div>
          )}

          {started && (
            <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2">
              {steps.map((s, i) => {
                const active = running && i === activeIndex;
                return (
                  <span key={s.label} className="flex items-center gap-1.5 text-xs">
                    {s.done ? (
                      <span className="text-teal-400">
                        <IconCheck />
                      </span>
                    ) : active ? (
                      <Spinner />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-slate-700" />
                    )}
                    <span className={s.done ? "text-slate-300" : active ? "text-slate-200" : "text-slate-600"}>
                      {s.label}
                    </span>
                  </span>
                );
              })}
            </div>
          )}

          {error && (
            <div className="mb-5 rounded-md border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {matchEvidence && (
            <Panel
              title="Identity resolution"
              meta={`${matchEvidence.filter((e) => e.decision === "confirmed").length} confirmed of ${matchEvidence.length} candidates`}
            >
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs text-slate-500">
                    <th className="py-2 pr-4 font-medium">Record</th>
                    <th className="py-2 pr-4 font-medium">Source</th>
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 text-right font-medium">Score</th>
                    <th className="py-2 pr-4 font-medium">Decision</th>
                    <th className="hidden py-2 font-medium md:table-cell">Basis</th>
                  </tr>
                </thead>
                <tbody>
                  {matchEvidence.map((e) => {
                    const rejected = e.decision === "rejected";
                    return (
                      <tr key={e.record_id} className={`border-b border-white/[0.05] ${rejected ? "text-slate-500" : ""}`}>
                        <td className="mono py-2 pr-4 text-xs">{e.record_id}</td>
                        <td className="py-2 pr-4 capitalize">{e.source_type}</td>
                        <td className="py-2 pr-4">{e.full_name}</td>
                        <td className="mono tnum py-2 pr-4 text-right text-xs">
                          {e.similarity != null ? e.similarity.toFixed(3) : ""}
                        </td>
                        <td className={`py-2 pr-4 text-xs font-medium ${rejected ? "text-red-400/80" : "text-teal-400"}`}>
                          {e.decision === "confirmed" ? "Confirmed" : rejected ? "Rejected" : "Uncertain"}
                        </td>
                        <td className="hidden py-2 text-xs text-slate-500 md:table-cell">{e.reason}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          )}

          {conflicts && (
            <Panel title="Conflicts" meta={`${conflicts.length} found`}>
              {conflicts.length === 0 ? (
                <p className="text-sm text-slate-500">No contradictions across the matched records.</p>
              ) : (
                <div className="space-y-3">
                  {conflicts.map((c, i) => {
                    const ref = `C${i + 1}`;
                    const action = actionsByRef[ref];
                    const rev = reviewsByRef[ref];
                    return (
                      <div key={ref} className="rounded-md border border-white/10 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs font-medium capitalize text-slate-400">
                            {c.conflict_type.replace(/_/g, " ")}
                          </span>
                          {action ? (
                            <span className={`flex items-center gap-1.5 text-xs font-medium ${SEVERITY_TEXT[action.severity]}`}>
                              <span className={`h-1.5 w-1.5 rounded-full ${SEVERITY_DOT[action.severity]}`} />
                              {action.severity}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1.5 text-xs text-slate-500">
                              <Spinner /> adjudicating
                            </span>
                          )}
                        </div>
                        <p className="mt-1.5 text-sm text-slate-200">{c.description}</p>
                        {action && (
                          <div className="mt-3 rounded bg-white/[0.03] p-3">
                            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                              <span className="text-xs text-slate-500">Resolution</span>
                              <span className="text-sm font-medium text-white">
                                {String(action.payload?.trusted_value ?? "")}
                              </span>
                              <span className="text-xs text-teal-300">{action.action.replace(/_/g, " ")}</span>
                              {rev && (
                                <span className="text-xs text-slate-500">
                                  {rev.confidence} confidence{rev.escalate ? ", escalated" : ""}
                                </span>
                              )}
                            </div>
                            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{action.detail}</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
          )}

          {reconciled && (
            <Panel title="Reconciled record" meta={`merged from ${reconciled.source_record_ids.join(", ")}`}>
              <p className="text-sm font-medium text-white">{reconciled.identity.full_name}</p>
              <p className="mono mt-0.5 text-xs text-slate-500">
                DOB {reconciled.identity.date_of_birth ?? "n/a"} &nbsp; NIC {reconciled.identity.nic ?? "n/a"} &nbsp;{" "}
                {reconciled.identity.phone ?? ""}
              </p>

              <div className="mt-4 grid gap-6 md:grid-cols-2">
                <div>
                  <h3 className="mb-1.5 text-xs font-medium text-slate-500">Medications</h3>
                  <table className="w-full text-sm">
                    <tbody>
                      {reconciled.medications.map((m, i) => (
                        <tr key={i} className="border-b border-white/[0.05] last:border-0">
                          <td className="py-1.5 pr-3 text-slate-200">{m.name}</td>
                          <td className="mono tnum py-1.5 pr-3 text-xs text-slate-400">{m.dose ?? ""}</td>
                          <td className="py-1.5 text-xs text-slate-500">{m.frequency ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-4">
                  <div>
                    <h3 className="mb-1.5 text-xs font-medium text-slate-500">Allergies</h3>
                    <p className={`text-sm ${reconciled.allergies.length ? "text-red-300" : "text-slate-500"}`}>
                      {reconciled.allergies.length ? reconciled.allergies.join(", ") : "None recorded"}
                    </p>
                  </div>
                  <div>
                    <h3 className="mb-1.5 text-xs font-medium text-slate-500">Diagnoses</h3>
                    <p className="text-sm text-slate-300">
                      {reconciled.diagnoses.length ? reconciled.diagnoses.join("; ") : "None recorded"}
                    </p>
                  </div>
                </div>
              </div>

              {reconciled.applied_changes.length > 0 && (
                <div className="mt-4 border-t border-white/[0.06] pt-3">
                  <h3 className="mb-1.5 text-xs font-medium text-slate-500">Changes applied by the agent</h3>
                  <ul className="space-y-1">
                    {reconciled.applied_changes.map((ch, i) => (
                      <li key={i} className="text-xs leading-relaxed text-slate-400">
                        {ch}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Panel>
          )}

          {review && (
            <div
              className={`fade-up mt-5 flex items-start gap-3 rounded-lg border p-4 ${
                review.escalate_to_human
                  ? "border-amber-400/30 bg-amber-400/[0.06]"
                  : "border-teal-400/25 bg-teal-400/[0.05]"
              }`}
            >
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                  review.escalate_to_human ? "bg-amber-400/20 text-amber-300" : "bg-teal-400/20 text-teal-300"
                }`}
              >
                {review.escalate_to_human ? <IconAlert /> : <IconCheck />}
              </span>
              <div>
                <p className={`text-sm font-medium ${review.escalate_to_human ? "text-amber-300" : "text-teal-300"}`}>
                  {review.escalate_to_human ? "Escalated for human review" : "Completed autonomously"}
                </p>
                <p className="mt-0.5 text-sm text-slate-400">{review.summary}</p>
                {meta && (
                  <p className="tnum mt-2 text-xs text-slate-500">
                    {meta.llm_calls} model call{meta.llm_calls === 1 ? "" : "s"} &middot; {meta.cluster_size} records
                    merged &middot; {meta.conflicts_found} conflicts &middot; {meta.actions_taken} actions
                    {durationMs != null && <> &middot; {(durationMs / 1000).toFixed(1)}s</>}
                  </p>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function HeaderStatus({ running, meta }: { running: boolean; meta: ReconciliationMeta | null }) {
  if (running)
    return (
      <span className="flex items-center gap-2 text-xs text-slate-400">
        <Spinner /> Running
      </span>
    );
  if (meta)
    return (
      <span className={`flex items-center gap-2 text-xs ${meta.escalated ? "text-amber-300" : "text-teal-300"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${meta.escalated ? "bg-amber-400" : "bg-teal-400"}`} />
        {meta.escalated ? "Escalated" : "Completed"}
      </span>
    );
  return (
    <span className="flex items-center gap-2 text-xs text-slate-500">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
      Idle
    </span>
  );
}

function Panel({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <section className="fade-up mt-5 rounded-lg border border-white/10 bg-white/[0.02] p-5 first:mt-0">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-white">{title}</h2>
        {meta && <span className="text-xs text-slate-500">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-slate-600 border-t-teal-400" />;
}

function IconCheck() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8.5l3.2 3.2L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconAlert() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 5.5v3.5M8 11.5v.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconPulse() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M1.5 8h3l2-4.5L10 12l1.8-4h2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
