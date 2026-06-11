// Types mirroring the backend's API payloads. Expanded in step 14b for the
// full streaming reveal; for now we model the picker + a result summary.

export type Patient = {
  record_id: string;
  full_name: string;
  source_name: string;
  record_date: string;
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
  meta: ReconciliationMeta;
};
