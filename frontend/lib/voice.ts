import Vapi from "@vapi-ai/web";

// Voice is a CONVERSATION layer over a reconciliation the clinician has already
// run. It never identifies a patient or starts a run from speech (that was
// unreliable with mis-transcribed Sinhala names); the clinician picks the patient
// and runs the reconciliation themselves, then talks to the assistant about the
// result. Vapi handles STT, the assistant's small-talk model, and TTS; this page
// feeds it the current result and it answers questions strictly from that data.

export const VAPI_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY ?? "";

export type VoiceHandlers = {
  onCallStart: () => void;
  onCallEnd: () => void;
  onLog: (text: string) => void;
};

export type VoiceSession = {
  stop: () => void;
  reportResult: (summary: string) => void;
  reportNoResult: () => void;
};

const ASSISTANT_INSTRUCTIONS = `You are the voice interface of Concord, an autonomous
clinical-record reconciliation agent used by clinicians in Sri Lanka. Keep every reply
to one or two short sentences.

You do NOT choose patients or start reconciliations. The clinician selects a patient
and runs the reconciliation in the app; your job is to talk them through the result.

The application sends you a system message with the full result data once a run has
finished. When it arrives, first summarise it aloud in two or three sentences: how many
contradictions, the most serious finding, and whether it completed autonomously or needs
a clinician. Then offer to go deeper ("Want the details?").

After that, answer follow-up questions in as much detail as asked, strictly from the
result data: quote exact doses, dates, sources, confidence levels and guideline ids when
relevant. If asked about something not present in the data, say it is not in the record.

If the clinician asks about a result before any run has finished, tell them to select a
patient and run the reconciliation first, then you can talk them through it. Do not give
medical advice beyond what the result data contains.`;

export function startVoice(handlers: VoiceHandlers): VoiceSession {
  const vapi = new Vapi(VAPI_PUBLIC_KEY);

  vapi.on("call-start", handlers.onCallStart);
  vapi.on("call-end", handlers.onCallEnd);
  vapi.on("error", (e: unknown) => {
    handlers.onLog(`Voice error: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
    handlers.onCallEnd();
  });

  // Transcript is logged for the audit trail; we no longer parse it for a patient.
  vapi.on(
    "message",
    (m: { type?: string; transcriptType?: string; role?: string; transcript?: string }) => {
      if (m?.type === "transcript" && m.transcriptType === "final" && m.transcript) {
        handlers.onLog(`${m.role === "user" ? "Clinician" : "Concord"}: "${m.transcript}"`);
      }
    },
  );

  vapi.start({
    name: "Concord",
    firstMessage: "Concord here. Run a reconciliation and I'll talk you through the result.",
    transcriber: { provider: "deepgram", model: "nova-3-medical", language: "en" },
    voice: { provider: "vapi", voiceId: "Elliot" },
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: ASSISTANT_INSTRUCTIONS }],
    },
  });

  return {
    stop: () => vapi.stop(),
    reportResult: (resultDetail: string) => {
      vapi.send({
        type: "add-message",
        message: {
          role: "system",
          content:
            "Reconciliation finished. Full result data follows. Summarise it aloud in 2-3 " +
            "sentences now, then answer follow-up questions in detail from this data only.\n\n" +
            resultDetail,
        },
      });
    },
    reportNoResult: () => {
      vapi.send({
        type: "add-message",
        message: {
          role: "system",
          content:
            "No reconciliation has been run yet. If the clinician asks about a result, tell " +
            "them to select a patient and run the reconciliation first.",
        },
      });
    },
  };
}
