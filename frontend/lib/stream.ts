import { API_BASE } from "./api";
import type {
  DetectedEvent,
  ExecutedEvent,
  MatchedEvent,
  ReconciliationResult,
  ReviewedEvent,
} from "./types";

export type StreamHandlers = {
  onMatched?: (d: MatchedEvent) => void;
  onDetected?: (d: DetectedEvent) => void;
  onExecuted?: (d: ExecutedEvent) => void;
  onReviewed?: (d: ReviewedEvent) => void;
  onDone?: (d: ReconciliationResult) => void;
  onError?: (message: string) => void;
};

/**
 * Open the reconcile SSE stream and dispatch each stage to the handlers.
 * Returns a function that closes the stream. We track `finished` so the normal
 * connection close after the "done" event isn't reported as an error.
 */
export function streamReconcile(recordId: string, handlers: StreamHandlers): () => void {
  const es = new EventSource(`${API_BASE}/reconcile/${recordId}/stream`);
  let finished = false;

  const on = <T>(name: string, cb?: (d: T) => void) => {
    if (cb) es.addEventListener(name, (ev) => cb(JSON.parse((ev as MessageEvent).data)));
  };

  on("matched", handlers.onMatched);
  on("detected", handlers.onDetected);
  on("executed", handlers.onExecuted);
  on("reviewed", handlers.onReviewed);

  es.addEventListener("done", (ev) => {
    finished = true;
    handlers.onDone?.(JSON.parse((ev as MessageEvent).data));
    es.close();
  });

  es.onerror = () => {
    if (!finished) handlers.onError?.("Connection to the agent stream failed.");
    es.close();
  };

  return () => {
    finished = true;
    es.close();
  };
}
