"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getPatients } from "@/lib/api";
import { streamReconcile } from "@/lib/stream";
import { startVoice, VAPI_PUBLIC_KEY, type VoiceSession } from "@/lib/voice";
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

// Severity is printed, not badged: it colors the finding's margin numeral and
// its small caption, the way an abnormal value is flagged on a lab report.
const SEVERITY_INK: Record<Severity, string> = {
  critical: "text-red-700",
  high: "text-orange-700",
  moderate: "text-amber-700",
  low: "text-stone-400",
};

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, high: 2, moderate: 1, low: 0 };

const normRef = (r: string) => r.match(/C\d+/i)?.[0]?.toUpperCase() ?? r;
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

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
  const [finishedAt, setFinishedAt] = useState<Date | null>(null);

  const [voiceState, setVoiceState] = useState<"off" | "connecting" | "live">("off");

  const closeRef = useRef<(() => void) | null>(null);
  const startRef = useRef<number>(0);
  const voiceRef = useRef<VoiceSession | null>(null);
  const patientsRef = useRef<Patient[]>([]);
  const runningRef = useRef(false);

  useEffect(() => {
    getPatients().then(setPatients).catch((e) => setLoadError(String(e)));
    return () => {
      closeRef.current?.();
      voiceRef.current?.stop();
    };
  }, []);
  patientsRef.current = patients;
  runningRef.current = running;

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

  function onReconcile(recordId?: string) {
    const id = recordId ?? selectedId;
    if (!id || runningRef.current) return;
    setSelectedId(id);
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
    setFinishedAt(null);
    setLog([{ at: new Date(), text: `Run started for ${id}` }]);
    startRef.current = performance.now();

    closeRef.current = streamReconcile(id, {
      onMatched: (d) => {
        setMatchEvidence(d.match_evidence);
        const confirmed = d.match_evidence.filter((e) => e.decision === "confirmed").length;
        addLog(`Identity resolved, ${confirmed} of ${d.match_evidence.length} candidates confirmed`);
      },
      onDetected: (d) => {
        setConflicts(d.conflicts);
        addLog(`Detection found ${d.conflicts.length} contradiction(s)`);
      },
      onExecuted: (d) => {
        setActions(d.actions);
        setReconciled(d.reconciled_record);
        addLog(`Adjudicated, ${d.actions.length} action(s) executed`);
      },
      onReviewed: (d) => {
        setReview(d.review);
        addLog(d.review.escalate_to_human ? "Review escalated to a clinician" : "Review cleared, autonomous");
      },
      onDone: (d) => {
        setMeta(d.meta);
        setRunning(false);
        const ms = performance.now() - startRef.current;
        setDurationMs(ms);
        setFinishedAt(new Date());
        addLog(`Complete in ${(ms / 1000).toFixed(1)}s, ${d.meta.llm_calls} model call(s)`);
        if (voiceRef.current) {
          const worst = d.actions.length
            ? d.actions.map((a) => a.severity).sort((x, y) => SEVERITY_RANK[y] - SEVERITY_RANK[x])[0]
            : null;
          voiceRef.current.reportResult(
            `Patient ${d.reconciled_record.identity.full_name}: ${d.meta.conflicts_found} contradiction(s) ` +
              `across ${d.meta.cluster_size} matched records` +
              (worst ? `, most serious severity ${worst}` : "") +
              `. ${d.review.summary} ` +
              (d.meta.escalated ? "Escalated for clinician review." : "Completed autonomously."),
          );
        }
      },
      onError: (msg) => {
        setError(msg);
        setRunning(false);
        addLog("Stream error");
      },
    });
  }

  function matchPatientByFirstName(text: string): Patient | null {
    // First-name token match: robust to the transcriber's surname spellings
    // ("Pereira" for "Perera") and to shared surnames on the roster.
    const words = text.toLowerCase().split(/[^a-z]+/);
    const hits = patientsRef.current.filter((p) =>
      words.includes(p.full_name.split(/\s+/)[0].toLowerCase()),
    );
    return hits.length === 1 ? hits[0] : null;
  }

  function onUserUtterance(text: string) {
    // The page is the orchestrator: a patient named on the call starts a normal run.
    if (runningRef.current) return;
    const hit = matchPatientByFirstName(text);
    if (hit) onReconcile(hit.record_id);
  }

  function onAssistantUtterance(text: string) {
    // Indirect references ("the first one") are resolved by the assistant, which
    // confirms with "Running the reconciliation for <name> now". Act on that.
    if (runningRef.current || !/running the reconciliation/i.test(text)) return;
    const hit = matchPatientByFirstName(text);
    if (hit) onReconcile(hit.record_id);
  }

  function toggleVoice() {
    if (voiceRef.current) {
      voiceRef.current.stop();
      return;
    }
    setVoiceState("connecting");
    voiceRef.current = startVoice(
      {
        onUserUtterance,
        onAssistantUtterance,
        onCallStart: () => setVoiceState("live"),
        onCallEnd: () => {
          voiceRef.current = null;
          setVoiceState("off");
        },
        onLog: addLog,
      },
      patientsRef.current.map((p) => p.full_name),
    );
  }

  const steps = [
    { label: "Match identity", done: !!matchEvidence },
    { label: "Detect conflicts", done: !!conflicts },
    { label: "Adjudicate", done: !!actions },
    { label: "Execute actions", done: !!reconciled },
    { label: "Review", done: !!review },
  ];
  const activeIndex = steps.findIndex((s) => !s.done);
  const started = running || !!meta;

  return (
    <div className="min-h-screen">
      <header className="border-b border-[#e8e4d9]">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-8">
          <div className="flex items-baseline gap-3">
            <span className="display text-[22px] font-medium tracking-tight text-[#211f19]">Concord</span>
          </div>
          <div className="flex items-center gap-5">
            <HeaderStatus
              running={running}
              patientName={patients.find((p) => p.record_id === selectedId)?.full_name}
              finishedAt={finishedAt}
              durationMs={durationMs}
            />
            <button
              onClick={toggleVoice}
              disabled={!VAPI_PUBLIC_KEY || voiceState === "connecting"}
              title={VAPI_PUBLIC_KEY ? undefined : "Set NEXT_PUBLIC_VAPI_PUBLIC_KEY in frontend/.env.local"}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                voiceState === "live"
                  ? "bg-[#211f19] text-[#faf9f5] hover:bg-black"
                  : "border border-[#d8d3c6] text-[#44413a] hover:bg-[#f1efe7] disabled:cursor-not-allowed disabled:opacity-50"
              }`}
            >
              <IconMic />
              {voiceState === "off" ? "Voice" : voiceState === "connecting" ? "Connecting" : "End call"}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-12 px-8 py-10 lg:grid-cols-[290px_1fr]">
        {/* Roster */}
        <aside>
          <h2 className="mb-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[#8a8578]">
            Patient roster
          </h2>
          {loadError && (
            <p className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs leading-relaxed text-red-800">
              The backend on :8000 is not responding. {loadError}
            </p>
          )}
          <div className="space-y-0.5">
            {patients.map((p) => {
              const sel = p.record_id === selectedId;
              return (
                <button
                  key={p.record_id}
                  onClick={() => setSelectedId(p.record_id)}
                  disabled={running}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition disabled:opacity-60 ${
                    sel ? "bg-[#eeebe0]" : "hover:bg-[#f1efe7]"
                  }`}
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                      sel ? "bg-[#211f19] text-[#faf9f5]" : "bg-[#e8e4d9] text-[#6f6b60]"
                    }`}
                  >
                    {initials(p.full_name)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13.5px] font-medium text-[#211f19]">{p.full_name}</span>
                    <span className="mono block text-[11px] text-[#8a8578]">
                      {p.record_id} <span className="tnum">{p.record_date}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <button
            onClick={() => onReconcile()}
            disabled={!selectedId || running}
            className="mt-5 w-full rounded-lg bg-[#211f19] py-2.5 text-[13.5px] font-medium text-[#faf9f5] transition hover:bg-black disabled:cursor-not-allowed disabled:bg-[#e8e4d9] disabled:text-[#a8a399]"
          >
            {running ? "Running" : "Run reconciliation"}
          </button>

          {log.length > 0 && (
            <div className="mt-8">
              <h2 className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[#8a8578]">
                Audit trail
              </h2>
              <ol className="space-y-1.5 border-l border-[#e8e4d9] pl-3">
                {log.map((e, i) => (
                  <li key={i} className="text-[11.5px] leading-relaxed">
                    <span className="mono tnum text-[#b3ad9e]">
                      {e.at.toLocaleTimeString("en-GB", { hour12: false })}
                    </span>{" "}
                    <span className="text-[#6f6b60]">{e.text}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </aside>

        {/* Worksheet */}
        <main className="min-w-0">
          {!started && (
            <div className="pt-6">
              <p className="display max-w-md text-[28px] font-medium leading-snug tracking-tight text-[#211f19]">
                One patient, three sources, no shared identifier.
              </p>
              <p className="mt-4 max-w-md text-[14px] leading-relaxed text-[#6f6b60]">
                Select a patient and run reconciliation. Concord pulls their fragmented records
                from the clinic, lab and pharmacy, matches identity across them, and resolves
                every contradiction it finds. Two model calls per run, no human input.
              </p>
              <ol className="mono mt-8 space-y-1 text-[11.5px] text-[#a8a399]">
                {steps.map((s, i) => (
                  <li key={s.label}>
                    <span className="tnum">0{i + 1}</span>&nbsp;&nbsp;{s.label}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {started && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pb-2">
              {steps.map((s, i) => {
                const active = running && i === activeIndex;
                return (
                  <span key={s.label} className="flex items-center gap-1.5 text-[12px]">
                    {s.done ? <IconCheck className="text-teal-700" /> : active ? <Spinner /> : null}
                    <span className={s.done ? "text-[#211f19]" : active ? "text-[#44413a]" : "text-[#c9c4b4]"}>
                      {s.label}
                    </span>
                  </span>
                );
              })}
            </div>
          )}

          {error && (
            <div className="mt-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
          )}

          {matchEvidence && (
            <Section
              title="Identity resolution"
              note={`${matchEvidence.filter((e) => e.decision === "confirmed").length} of ${matchEvidence.length} candidates confirmed`}
            >
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-[#8a8578]">
                    <th className="pb-2 pr-4 font-medium">Record</th>
                    <th className="pb-2 pr-4 font-medium">Source</th>
                    <th className="pb-2 pr-4 font-medium">Name</th>
                    <th className="pb-2 pr-4 text-right font-medium">Score</th>
                    <th className="pb-2 pr-4 font-medium">Decision</th>
                    <th className="hidden pb-2 font-medium md:table-cell">Basis</th>
                  </tr>
                </thead>
                <tbody>
                  {matchEvidence.map((e) => {
                    const rejected = e.decision === "rejected";
                    return (
                      <tr key={e.record_id} className={`border-t border-[#eceae0] ${rejected ? "text-[#a8a399]" : "text-[#211f19]"}`}>
                        <td className="mono py-2 pr-4 text-xs">{e.record_id}</td>
                        <td className="py-2 pr-4 capitalize">{e.source_type}</td>
                        <td className="py-2 pr-4">{e.full_name}</td>
                        <td className="mono tnum py-2 pr-4 text-right text-xs">
                          {e.similarity != null ? e.similarity.toFixed(3) : ""}
                        </td>
                        <td className={`py-2 pr-4 text-xs font-medium ${rejected ? "text-red-800/60" : "text-teal-800"}`}>
                          {e.decision === "confirmed" ? "Confirmed" : rejected ? "Rejected" : "Uncertain"}
                        </td>
                        <td className="hidden py-2 text-xs text-[#8a8578] md:table-cell">{e.reason}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Section>
          )}

          {conflicts && (
            <Section title="Findings" note={conflicts.length === 0 ? "none" : `${conflicts.length} contradiction${conflicts.length === 1 ? "" : "s"}`}>
              {conflicts.length === 0 ? (
                <p className="text-sm text-[#6f6b60]">No contradictions across the matched records.</p>
              ) : (
                <div className="space-y-7">
                  {conflicts.map((c, i) => {
                    const ref = `C${i + 1}`;
                    const action = actionsByRef[ref];
                    const rev = reviewsByRef[ref];
                    return (
                      <div key={ref} className="grid grid-cols-[3rem_1fr] gap-x-4">
                        <span className="flex flex-col items-end pt-0.5 text-right">
                          <span
                            className={`display tnum text-[22px] font-medium leading-none ${
                              action ? SEVERITY_INK[action.severity] : "text-[#d8d3c6]"
                            }`}
                          >
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          {action && (
                            <span className={`mt-1 text-[9px] uppercase tracking-[0.16em] ${SEVERITY_INK[action.severity]}`}>
                              {action.severity}
                            </span>
                          )}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-[15px] font-medium capitalize text-[#211f19]">
                              {c.conflict_type.replace(/_/g, " ")}
                            </h3>
                            {!action && (
                              <span className="flex items-center gap-1.5 text-xs text-[#8a8578]">
                                <Spinner /> adjudicating
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-[13.5px] leading-relaxed text-[#44413a]">{c.description}</p>
                          {action && (
                            <div className="mt-3 rounded-md bg-[#f3f1e8] p-3.5">
                              <p className="text-[13px]">
                                <span className="text-[#8a8578]">Trusted</span>{" "}
                                <span className="font-medium text-[#211f19]">
                                  {String(action.payload?.trusted_value ?? "")}
                                </span>
                                <span className="px-2 text-[#d8d3c6]">/</span>
                                <span className="text-teal-800">{action.action.replace(/_/g, " ")}</span>
                                {rev && (
                                  <>
                                    <span className="px-2 text-[#d8d3c6]">/</span>
                                    <span className="text-[#8a8578]">
                                      {rev.confidence} confidence{rev.escalate ? ", escalated" : ""}
                                    </span>
                                  </>
                                )}
                              </p>
                              <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#6f6b60]">{action.detail}</p>
                              {(() => {
                                const cites = (action.payload?.guidelines ?? []) as {
                                  id: string;
                                  title: string;
                                  source: string;
                                }[];
                                if (!cites.length) return null;
                                return (
                                  <p className="mt-2 border-t border-[#e6e2d6] pt-2 text-[11.5px] leading-relaxed text-[#8a8578]">
                                    Grounded in{" "}
                                    {cites.map((g, gi) => (
                                      <span key={g.id}>
                                        {gi > 0 && "; "}
                                        <span className="mono">{g.id}</span> {g.title}, {g.source}
                                      </span>
                                    ))}
                                  </p>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>
          )}

          {reconciled && (
            <Section title="Reconciled record" note={`merged from ${reconciled.source_record_ids.join(", ")}`}>
              <div className="rounded-lg border border-[#e8e4d9] bg-white p-6 shadow-[0_1px_3px_rgba(33,31,25,0.05)]">
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#eceae0] pb-4">
                  <p className="display text-[19px] font-medium text-[#211f19]">{reconciled.identity.full_name}</p>
                  <p className="mono text-[11px] text-[#8a8578]">
                    DOB <span className="tnum">{reconciled.identity.date_of_birth ?? "n/a"}</span>
                    &nbsp;&nbsp;NIC {reconciled.identity.nic ?? "n/a"}
                    &nbsp;&nbsp;{reconciled.identity.phone ?? ""}
                  </p>
                </div>

                <div className="mt-4 grid gap-8 md:grid-cols-[1.2fr_1fr]">
                  <div>
                    <h4 className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[#8a8578]">
                      Medications
                    </h4>
                    <table className="w-full text-[13px]">
                      <tbody>
                        {reconciled.medications.map((m, i) => (
                          <tr key={i} className="border-t border-[#f0ede4] first:border-0">
                            <td className="py-1.5 pr-3 text-[#211f19]">{m.name}</td>
                            <td className="mono tnum py-1.5 pr-3 text-xs text-[#6f6b60]">{m.dose ?? ""}</td>
                            <td className="py-1.5 text-xs text-[#8a8578]">{m.frequency ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="space-y-5">
                    <div>
                      <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[#8a8578]">
                        Allergies
                      </h4>
                      <p className={`text-[13.5px] ${reconciled.allergies.length ? "font-medium text-red-800" : "text-[#a8a399]"}`}>
                        {reconciled.allergies.length ? reconciled.allergies.join(", ") : "None recorded"}
                      </p>
                    </div>
                    <div>
                      <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[#8a8578]">
                        Diagnoses
                      </h4>
                      <p className="text-[13.5px] leading-relaxed text-[#44413a]">
                        {reconciled.diagnoses.length ? reconciled.diagnoses.join("; ") : "None recorded"}
                      </p>
                    </div>
                  </div>
                </div>

                {reconciled.applied_changes.length > 0 && (
                  <div className="mt-5 border-t border-[#eceae0] pt-3.5">
                    <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[#8a8578]">
                      Changes applied by the agent
                    </h4>
                    <ul className="space-y-1">
                      {reconciled.applied_changes.map((ch, i) => (
                        <li key={i} className="text-[12.5px] leading-relaxed text-[#6f6b60]">
                          {ch}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </Section>
          )}

          {review && (
            <div className="fade-up mt-10 border-t border-[#e8e4d9] pt-6">
              <div className="flex items-start gap-3.5">
                <span
                  className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white ${
                    review.escalate_to_human ? "bg-amber-600" : "bg-teal-700"
                  }`}
                >
                  {review.escalate_to_human ? <IconAlert /> : <IconCheck className="text-white" />}
                </span>
                <div>
                  <p className="display text-[19px] font-medium text-[#211f19]">
                    {review.escalate_to_human ? "Escalated for clinician review" : "Completed autonomously"}
                  </p>
                  <p className="mt-1 max-w-xl text-[13.5px] leading-relaxed text-[#6f6b60]">{review.summary}</p>
                  {meta && (
                    <p className="mono tnum mt-3 text-[11.5px] text-[#a8a399]">
                      {meta.llm_calls} model call{meta.llm_calls === 1 ? "" : "s"} &middot; {meta.cluster_size}{" "}
                      records merged &middot; {meta.conflicts_found} conflicts &middot; {meta.actions_taken} actions
                      {durationMs != null && <> &middot; {(durationMs / 1000).toFixed(1)}s</>}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function HeaderStatus({
  running,
  patientName,
  finishedAt,
  durationMs,
}: {
  running: boolean;
  patientName?: string;
  finishedAt: Date | null;
  durationMs: number | null;
}) {
  // Information, not state words: nothing when idle, plain text while working,
  // a quiet readout of the last run once finished.
  if (running)
    return (
      <span className="flex items-center gap-2 text-xs text-[#6f6b60]">
        <Spinner /> Reconciling {patientName ?? ""}
      </span>
    );
  if (finishedAt)
    return (
      <span className="mono tnum text-[11px] text-[#a8a399]">
        Last run {finishedAt.toLocaleTimeString("en-GB", { hour12: false })}
        {durationMs != null && <>, {(durationMs / 1000).toFixed(1)}s</>}
      </span>
    );
  return null;
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="fade-up mt-9 first:mt-0">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 border-b border-[#e8e4d9] pb-2">
        <h2 className="display text-[17px] font-medium tracking-tight text-[#211f19]">{title}</h2>
        {note && <span className="mono text-[11px] text-[#a8a399]">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-[#d8d3c6] border-t-teal-700" />;
}

function IconCheck({ className }: { className?: string }) {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path d="M3 8.5l3.2 3.2L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconAlert() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 4.5v4M8 11.5v.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconMic() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="6" y="1.5" width="4" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 7.5a4.5 4.5 0 009 0M8 12v2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
