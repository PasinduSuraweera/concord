import type { Patient, ReconciliationResult } from "./types";

// The FastAPI backend. Override with NEXT_PUBLIC_API_URL if it runs elsewhere.
export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

export async function getPatients(): Promise<Patient[]> {
  const res = await fetch(`${API_BASE}/patients`);
  if (!res.ok) throw new Error(`GET /patients failed (${res.status})`);
  return res.json();
}

export async function reconcile(recordId: string): Promise<ReconciliationResult> {
  const res = await fetch(`${API_BASE}/reconcile/${recordId}`);
  if (!res.ok) throw new Error(`GET /reconcile failed (${res.status})`);
  return res.json();
}
