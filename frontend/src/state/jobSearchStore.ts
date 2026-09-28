// Module-level store for the LinkedIn job search so an in-flight search
// survives route changes: JobsPage unmounts when the user navigates away, but
// the request promise and its outcome live here, not in component state.
import { isConnectionDropped, searchJobs, searchJobsStream, type SearchProgressEvent } from "../api/client";
import { apiErrorMessage } from "../lib/apiError";
import { invalidateData } from "../lib/dataCache";
import type { JobMatch, JobSearchResult, ResumeModel, SearchContext, SearchMode } from "../types";

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
  cancelled: boolean; // user hit Cancel — liveMatches kept as partial results
  // The stream ended with no result and no error frame (Phase 30 / C3): the
  // connection dropped, and the server may still finish the search and write its
  // jobs to History. JobsPage says so in its own words (search.connectionDropped).
  // It is not an `error`: nothing says the search failed, and it has used its use.
  dropped: boolean;
  // The mode the CURRENT search ran in (2026-09-28): its results lead with the
  // proposal writer when it is "freelance", whatever the switch says since.
  mode: SearchMode;
};

let state: JobSearchState = {
  searching: false,
  result: null,
  error: "",
  startedAt: null,
  progress: null,
  liveMatches: [],
  cancelled: false,
  dropped: false,
  mode: "jobs",
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
let controller: AbortController | null = null;

/** Client-side abort (PLAN 12.5a): stops the SSE stream, keeps the jobs
 * scored so far as partial results. The backend request dies with the
 * connection; the seq bump makes every in-flight callback a no-op. */
export function cancelJobSearch(): void {
  if (!state.searching) return;
  seq++;
  controller?.abort();
  controller = null;
  set({ searching: false, progress: null, cancelled: true });
}

export function startJobSearch(resume: ResumeModel, customize: SearchContext | null, mode: SearchMode = "jobs"): void {
  const id = ++seq;
  controller = new AbortController();
  set({
    searching: true,
    error: "",
    result: null,
    startedAt: Date.now(),
    progress: null,
    liveMatches: [],
    cancelled: false,
    dropped: false,
    mode,
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
    controller.signal,
    mode,
  )
    .catch((e: unknown) => {
      // Older backends have no /jobs/search/stream — fall back to the plain
      // search (the progress card then shows its elapsed-time stages).
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 404 || status === 405) return searchJobs(resume, customize, mode);
      throw e;
    })
    .then((r) => {
      // The sorted result is authoritative — the streamed cards yield to it.
      if (id === seq) set({ searching: false, result: r, progress: null, liveMatches: [] });
    })
    .catch((e: unknown) => {
      if (id !== seq) return;
      // liveMatches is intentionally left as-is: on an interrupted search the
      // page shows the jobs scored so far alongside the error.
      if (isConnectionDropped(e)) {
        // A finished search writes its jobs to History on the server's own
        // worker, with nobody reading the stream, so History is read fresh.
        invalidateData("history");
        set({ searching: false, progress: null, dropped: true });
        return;
      }
      set({
        searching: false,
        progress: null,
        error: apiErrorMessage(e, "Something went wrong."),
      });
    });
}
