// Module-level store for the LinkedIn job search so an in-flight search
// survives route changes: JobsPage unmounts when the user navigates away, but
// the request promise and its outcome live here, not in component state.
import { searchJobs, searchJobsStream, type SearchProgressEvent } from "../api/client";
import { apiErrorMessage } from "../lib/apiError";
import type { JobMatch, JobSearchResult, ResumeModel, SearchContext } from "../types";

export type JobSearchState = {
  searching: boolean;
  result: JobSearchResult | null;
  error: string;
  startedAt: number | null; // Date.now() when the in-flight search began
  progress: SearchProgressEvent | null; // latest SSE frame; null on the fallback path
  // Per-job `match` SSE frames, kept sorted by overall desc so cards stream in
  // ranked. Cleared when the authoritative `result` lands; kept on error so
  // the page can show the jobs scored before the search was interrupted.
  liveMatches: JobMatch[];
};

let state: JobSearchState = {
  searching: false,
  result: null,
  error: "",
  startedAt: null,
  progress: null,
  liveMatches: [],
};
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
  set({
    searching: true,
    error: "",
    result: null,
    startedAt: Date.now(),
    progress: null,
    liveMatches: [],
  });
  searchJobsStream(
    resume,
    customize,
    (p) => {
      if (id === seq) set({ progress: p });
    },
    (m) => {
      // Stable insert by score, descending: a new match lands after existing
      // equal-scored ones, so cards already on screen never swap on a tie.
      if (id !== seq) return;
      const next = [...state.liveMatches];
      const at = next.findIndex((x) => x.overall < m.overall);
      next.splice(at === -1 ? next.length : at, 0, m);
      set({ liveMatches: next });
    },
  )
    .catch((e: unknown) => {
      // Older backends have no /jobs/search/stream — fall back to the plain
      // search (the progress card then shows its elapsed-time stages).
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 404 || status === 405) return searchJobs(resume, customize);
      throw e;
    })
    .then((r) => {
      // The sorted result is authoritative — the streamed cards yield to it.
      if (id === seq) set({ searching: false, result: r, progress: null, liveMatches: [] });
    })
    .catch((e: unknown) => {
      // liveMatches is intentionally left as-is: on an interrupted search the
      // page shows the jobs scored so far alongside the error.
      if (id === seq)
        set({
          searching: false,
          progress: null,
          error: apiErrorMessage(e, "Something went wrong."),
        });
    });
}
