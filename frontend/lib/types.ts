// Types mirroring the backend's API payloads (the SSE event data + bundle).

export type Patient = {
  record_id: string;
  full_name: string;
  source_name: string;
  record_date: string;
};

export type Severity = "low" | "moderate" | "high" | "critical";
export type Confidence = "low" | "medium" | "high";

export type MatchEvidence = {
  record_id: string;
  source_type: string;
  full_name: string;
  similarity: number | null;
  decision: "confirmed" | "rejected" | "uncertain";
  reason: string;
};

export type ConflictParty = {
  record_id: string;
  source_type: string;
  source_name: string;
  record_date: string;
  value: string;
};

export type Conflict = {
  conflict_type: string;
  description: string;
  parties: ConflictParty[];
  detail: Record<string, unknown>;
};

export type ExecutedAction = {
  conflict_ref: string;
  conflict_type: string;
  action: string;
  severity: Severity;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
};

export type Medication = { name: string; dose: string | null; frequency: string | null };

export type ReconciledRecord = {
  patient_record_id: string;
  identity: {
    full_name: string;
    date_of_birth: string | null;
    nic: string | null;
    phone: string | null;
    gender: string | null;
  };
  diagnoses: string[];
  medications: Medication[];
  allergies: string[];
  source_record_ids: string[];
  applied_changes: string[];
};

export type ActionReview = {
  conflict_ref: string;
  confidence: Confidence;
  escalate: boolean;
  note: string;
};

export type ReviewResult = {
  reviews: ActionReview[];
  escalate_to_human: boolean;
  summary: string;
};

export type ReconciliationMeta = {
  llm_calls: number;
  cluster_size: number;
  conflicts_found: number;
  actions_taken: number;
  escalated: boolean;
};

export type ReconciliationResult = {
  entry_record_id: string;
  match_evidence: MatchEvidence[];
  cluster: Record<string, unknown>[];
  conflicts: Conflict[];
  actions: ExecutedAction[];
  reconciled_record: ReconciledRecord;
  review: ReviewResult;
  meta: ReconciliationMeta;
};

// SSE event payloads.
export type MatchedEvent = { entry_record_id: string; match_evidence: MatchEvidence[]; cluster: Record<string, unknown>[] };
export type DetectedEvent = { conflicts: Conflict[] };
export type ExecutedEvent = { actions: ExecutedAction[]; reconciled_record: ReconciledRecord };
export type ReviewedEvent = { review: ReviewResult };
