// Module-level store for batch auto-tailor (PLAN 8.1) so an in-flight batch
// survives route changes: the client drives the queue — POST /kits/batch, then
// POST /kits/process-next in a loop, one tailor pipeline run per request (the
// serverless-safe pattern) — and that loop must not die when JobsPage unmounts.
import { createKitBatch, deleteKit, listKits, processNextKit } from "../api/client";
import { apiErrorMessage } from "../lib/apiError";
import type { KitJobIn, KitOut } from "../types";

export type BatchSummary = {
  done: number; // kits processed in the finished batch
  flagged: number; // of those, fabrication-guard-flagged (never auto-approvable)
  failed: number;
  skipped: number; // jobs that already had a kit
};

export type KitsState = {
  batching: boolean;
  total: number; // kits queued for this batch (grows if another tab enqueues more)
  done: number; // processed so far in this batch
  lastKit: KitOut | null; // most recently processed kit (for the progress line)
  lastBatch: BatchSummary | null; // set when a batch finishes; null while idle/running
  error: string;
  kits: KitOut[] | null; // the Kits tab list; null = never loaded
  kitsLoading: boolean;
  kitsError: string;
};

let state: KitsState = {
  batching: false,
  total: 0,
  done: 0,
  lastKit: null,
  lastBatch: null,
  error: "",
  kits: null,
  kitsLoading: false,
  kitsError: "",
};
const listeners = new Set<() => void>();

function set(patch: Partial<KitsState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getKitsState(): KitsState {
  return state;
}

export function subscribeKits(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let seq = 0; // a restarted batch must not be overwritten by a stale loop

/** Drain the user's kit queue one process-next call at a time. Failed kits
 * come back with status "failed" (HTTP 200), so one bad job can't stop the
 * loop — only a transport-level error does. */
async function drain(id: number, summary: BatchSummary): Promise<void> {
  for (;;) {
    const r = await processNextKit();
    if (id !== seq) return; // a newer batch took over
    if (!r.kit) break;
    summary.done += 1;
    if (r.kit.status === "failed") summary.failed += 1;
    else if (r.kit.flag_count > 0) summary.flagged += 1;
    set({
      done: summary.done,
      lastKit: r.kit,
      // Another session may have queued more than we did — keep the bar honest.
      total: Math.max(state.total, summary.done + r.remaining),
    });
    if (r.remaining === 0) break;
  }
}

/** Enqueue `jobs` (already threshold-filtered by the caller) and process the
 * queue to completion. Resolves to the batch summary, or null when a newer
 * batch superseded this one or it failed (state.error is set then). */
export async function startKitBatch(jobs: KitJobIn[]): Promise<BatchSummary | null> {
  const id = ++seq;
  set({ batching: true, error: "", lastBatch: null, done: 0, total: 0, lastKit: null });
  const summary: BatchSummary = { done: 0, flagged: 0, failed: 0, skipped: 0 };
  try {
    const b = await createKitBatch(jobs);
    if (id !== seq) return null;
    summary.skipped = b.skipped_existing;
    set({ total: b.queued.length });
    // Even when everything was skipped, drain — an earlier interrupted batch
    // may have left queued kits behind, and this run picks them up.
    await drain(id, summary);
    if (id !== seq) return null;
    set({ batching: false, lastBatch: summary });
    void loadKits(true); // refresh the Kits tab in the background
    return summary;
  } catch (e: unknown) {
    if (id === seq) set({ batching: false, error: apiErrorMessage(e, "Something went wrong.") });
    return null;
  }
}

/** Resume processing kits left queued by an interrupted batch (page reload,
 * network drop) without enqueueing anything new. */
export async function resumeKitQueue(): Promise<BatchSummary | null> {
  const id = ++seq;
  set({ batching: true, error: "", lastBatch: null, done: 0, lastKit: null });
  const summary: BatchSummary = { done: 0, flagged: 0, failed: 0, skipped: 0 };
  set({ total: state.kits?.filter((k) => k.status === "queued").length ?? 0 });
  try {
    await drain(id, summary);
    if (id !== seq) return null;
    set({ batching: false, lastBatch: summary });
    void loadKits(true);
    return summary;
  } catch (e: unknown) {
    if (id === seq) set({ batching: false, error: apiErrorMessage(e, "Something went wrong.") });
    return null;
  }
}

export async function loadKits(force = false): Promise<void> {
  if (state.kitsLoading || (state.kits !== null && !force)) return;
  set({ kitsLoading: true, kitsError: "" });
  try {
    set({ kits: await listKits(), kitsLoading: false });
  } catch (e: unknown) {
    set({ kitsLoading: false, kitsError: apiErrorMessage(e, "Something went wrong.") });
  }
}

export async function removeKit(id: number): Promise<boolean> {
  try {
    await deleteKit(id);
    set({ kits: state.kits?.filter((k) => k.id !== id) ?? null });
    return true;
  } catch {
    return false;
  }
}
