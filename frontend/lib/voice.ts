import Vapi from "@vapi-ai/web";

// Browser-orchestrated voice control. Vapi handles the conversation (STT, the
// assistant's small talk model, TTS); THIS page stays the orchestrator: it
// watches the transcript for a patient name, runs the normal reconciliation
// through the backend, then hands the result back for the assistant to speak.
// Vapi's cloud never needs to reach our localhost backend.

export const VAPI_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY ?? "";

export type VoiceHandlers = {
  onUserUtterance: (text: string) => void;
  onAssistantUtterance: (text: string) => void;
  onCallStart: () => void;
  onCallEnd: () => void;
  onLog: (text: string) => void;
};

export type VoiceSession = {
  stop: () => void;
  reportResult: (summary: string) => void;
};

const ASSISTANT_INSTRUCTIONS = `You are the voice interface of Concord, an autonomous
clinical-record reconciliation agent used by clinicians in Sri Lanka. Keep every reply
to one or two short sentences.

The clinician can identify a patient three ways: by name, indirectly ("the first
one"), or by their record id (e.g. "NWK-1042" or just "ten forty-two"). Names may
be misheard, so if they give a record id, prefer it.

When you know which patient they mean, respond with a short confirmation that
includes BOTH their full name and their record id, and says you are running it now,
for example: "Running the reconciliation for [Patient Name], [Record ID], now." Always
include the record id when you have it. Then wait. If you cannot tell which patient
they mean, ask them to confirm the name or read out the NWK number, and do NOT name
a specific patient in that clarifying question.

The application runs the actual reconciliation and will send you a system message
with the full result data; when it arrives, first summarise it aloud in two or
three sentences: how many contradictions, the most serious finding, and whether it
completed autonomously or needs a clinician. Then offer to go deeper ("Want the
details?").

After that, answer follow-up questions in as much detail as asked, strictly from
the result data: quote exact doses, dates, sources, confidence levels and guideline
ids when relevant. If asked about something not present in the data, say it is not
in the record. Never use the phrase "running the reconciliation" in summaries or
answers, only in the confirmation sentence. Do not give medical advice beyond what
the result data contains.`;

export function startVoice(handlers: VoiceHandlers, patientNames: string[]): VoiceSession {
  const vapi = new Vapi(VAPI_PUBLIC_KEY);

  vapi.on("call-start", handlers.onCallStart);
  vapi.on("call-end", handlers.onCallEnd);
  vapi.on("error", (e: unknown) => {
    handlers.onLog(`Voice error: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
    handlers.onCallEnd();
  });

  let lastAssistantHandled = "";

  vapi.on(
    "message",
    (m: {
      type?: string;
      transcriptType?: string;
      role?: string;
      transcript?: string;
      messages?: { role?: string; message?: string; content?: string }[];
    }) => {
      if (m?.type === "transcript" && m.transcriptType === "final" && m.transcript) {
        handlers.onLog(`${m.role === "user" ? "Clinician" : "Concord"}: "${m.transcript}"`);
        if (m.role === "user") handlers.onUserUtterance(m.transcript);
        return;
      }

      if (m?.type === "conversation-update" && Array.isArray(m.messages)) {
        const assistantMsgs = m.messages.filter((x) => x.role === "assistant" || x.role === "bot");
        const last = assistantMsgs[assistantMsgs.length - 1];
        const text = last?.message ?? last?.content ?? "";
        if (text && text !== lastAssistantHandled) {
          lastAssistantHandled = text;
          handlers.onAssistantUtterance(text);
        }
      }
    },
  );
  
  const nameKeywords = [...new Set(patientNames.flatMap((n) => n.split(/\s+/)))].map(
    (token) => `${token}:3`,
  );

  vapi.start({
    name: "Concord",
    firstMessage: "Concord here. Which patient should I reconcile?",
    transcriber: { provider: "deepgram", model: "nova-3-medical", language: "en", keywords: nameKeywords },
    voice: { provider: "vapi", voiceId: "Elliot" },
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `${ASSISTANT_INSTRUCTIONS}\n\nPatients on the roster: ${patientNames.join(", ")}.`,
        },
      ],
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
  };
}
