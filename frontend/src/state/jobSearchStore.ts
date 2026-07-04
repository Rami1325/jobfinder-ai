// Module-level store for the LinkedIn job search so an in-flight search
// survives route changes: JobsPage unmounts when the user navigates away, but
// the request promise and its outcome live here, not in component state.
import { searchJobs } from "../api/client";
import type { JobSearchResult, ResumeModel, SearchContext } from "../types";

export type JobSearchState = {
  searching: boolean;
  result: JobSearchResult | null;
  error: string;
  startedAt: number | null; // Date.now() when the in-flight search began
};

let state: JobSearchState = { searching: false, result: null, error: "", startedAt: null };
const listeners = new Set<() => void>();

function set(patch: Partial<JobSearchState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getJobSearchState(): JobSearchState {
  return state;
}

export function subscribeJobSearch(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let seq = 0; // a restarted search must not be overwritten by a stale response

export function startJobSearch(resume: ResumeModel, customize: SearchContext | null): void {
  const id = ++seq;
  set({ searching: true, error: "", result: null, startedAt: Date.now() });
  searchJobs(resume, customize)
    .then((r) => {
      if (id === seq) set({ searching: false, result: r });
    })
    .catch((e: any) => {
      if (id === seq)
        set({
          searching: false,
          error: e?.response?.data?.detail || "Something went wrong.",
        });
    });
}
