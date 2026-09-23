import axios from "axios";
import { ACCESS_CODE_KEY, UNAUTHORIZED_EVENT, UNVERIFIED_EVENT } from "../lib/accessCode";
import { cachedFetch, clearDataCache, invalidateData } from "../lib/dataCache";
import { resetMasterCache } from "../hooks/useMasterResume";
import { noteDraftOwner } from "../lib/draft";
import { inclusionFrom, noteMonthlyLimit, noteUsesHeaders, setUsage, usageIfSameUser } from "../lib/usesStore";
import { tabAccount } from "../lib/accountWatch";
import { isTailorStage, type TailorStage } from "../lib/tailorStages";
import type {
  AlertRunResult,
  AlertSettings,
  ApplicationDetail,
  ApplicationDraft,
  ApplicationOut,
  AuthMe,
  ResendResult,
  VerifyEmailResult,
  CompanyBriefResult,
  ChatTurn,
  CoverageResult,
  CoverLetterResponse,
  FitCheckResult,
  FactsLedger,
  FeedbackOut,
  FollowUpResult,
  FreeScanResult,
  InboxDisconnectResult,
  InboxEvent,
  InboxStatus,
  InboxSyncResult,
  InterviewAnswerResult,
  InterviewChatResult,
  InterviewFeedbackResult,
  InterviewQuestionsResult,
  InterviewScorecardResult,
  JDModel,
  JobMatch,
  JobMatchResult,
  JobSearchHistory,
  JobSearchResult,
  KitBatchResult,
  KitDetail,
  KitJobIn,
  KitOut,
  KitProcessResult,
  LinkedInResult,
  MasterResume,
  Me,
  DeleteAccountResult,
  OutreachResult,
  PageCountResult,
  RecruiterScreenResult,
  ResumeModel,
  ResumePrefs,
  ResumeUploadResponse,
  ResumeVersion,
  ReviewResult,
  ReviewRewriteResult,
  ScreeningAnswerResult,
  SearchContext,
  StaleApplication,
  TailorResult,
  ATSXrayResult,
  UsagePassOut,
  PageImagesResult,
} from "../types";

// In dev, requests go through the Vite proxy at /api -> http://localhost:8000.
// In production (Vercel), set VITE_API_BASE_URL to the deployed backend URL
// (e.g. https://jobfinder-api.onrender.com) so the frontend calls it directly.
//
// The account cookie needs no code here: /api is same-origin in both places
// (the Vite proxy, the Vercel rewrite), so the browser attaches it to every
// request by itself. Pointing VITE_API_BASE_URL at another origin would
// silently stop that, and would need `withCredentials` and a SameSite=None
// cookie.
//
// CSRF_HEADER rides on EVERY request, the SSE fetch included. The backend
// refuses a POST/PUT/PATCH/DELETE without it (403 `csrf`) unless the request
// carries an invite code. The cookie is attached automatically, so without a
// check a page on another site could post a form that spends it. A custom
// header is the check because a cross-origin page cannot add one without a
// CORS preflight this origin never grants. Sending it on GETs as well costs
// nothing, and no call site has to know which methods need it.
const CSRF_HEADER = { "X-Requested-With": "jobfinder" } as const;

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api",
  headers: CSRF_HEADER,
});

api.interceptors.request.use((config) => {
  const code = localStorage.getItem(ACCESS_CODE_KEY);
  if (code) config.headers["X-App-Key"] = code;
  return config;
});

/**
 * What a rejected request means for the whole app, as opposed to the page that
 * made it. Shared by the axios path and the SSE fetch, so the two cannot drift
 * (the SSE path used to skip `clearDataCache` on a 401).
 *
 * 401: nobody the server recognises. The data cache goes, because a different
 * account may sign in next, and AccessGate sends the visitor to /login. A 401
 * on a request that CARRIED an invite code also proves that code dead, so it
 * is forgotten here. The code outranks the account cookie on every protected
 * route, so a stale one left in storage would 401 the account that signs in
 * next, and that 401 would send it straight back to /login, for ever.
 *
 * Every 401 counts, /auth/* included. The only /auth/* routes that can return
 * one are protected ones (changing a password, reading the extension key), and
 * on Settings a 401 there means the session died, so the redirect is right. On
 * an auth page AccessGate ignores the event, so the login form cannot bounce
 * itself.
 *
 * 403 `email_unverified`: an account that has not confirmed its address, sent
 * to /verify. NOT for /auth/* URLs. Those routes answer an unverified account
 * themselves, and the verify page is what calls them.
 *
 * 429 `monthly_limit` (Phase 30): the uses store takes the numbers the refusal
 * carries, from either path. Nothing redirects; the page that made the call
 * says so through `apiErrorMessage`.
 */
function onRejected(
  status: number | undefined,
  url: string,
  detail: unknown,
  sentCode: boolean,
): void {
  if (status === 401) {
    clearDataCache();
    if (sentCode) localStorage.removeItem(ACCESS_CODE_KEY);
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    return;
  }
  const code = (detail as { code?: unknown } | null | undefined)?.code;
  if (status === 429 && code === "monthly_limit") noteMonthlyLimit(detail);
  const path = url.startsWith("/") ? url.slice(1) : url;
  if (status === 403 && code === "email_unverified" && !path.startsWith("auth/")) {
    window.dispatchEvent(new Event(UNVERIFIED_EVENT));
  }
}

// Both sides read the monthly-uses headers (Phase 30 / C3). A counted call's
// response carries X-Uses-Remaining, and X-Uses-Pass for an interview or
// screening pass; an ERROR response can carry them too, because a failed call's
// refund restores the count on the response that reports the failure.
api.interceptors.response.use(
  (response) => {
    noteUsesHeaders(response.headers);
    return response;
  },
  (error) => {
    noteUsesHeaders(error?.response?.headers);
    onRejected(
      error?.response?.status,
      error?.config?.url ?? "",
      error?.response?.data?.detail,
      Boolean(error?.config?.headers?.["X-App-Key"]),
    );
    return Promise.reject(error);
  },
);

export async function uploadResume(file: File): Promise<ResumeUploadResponse> {
  const form = new FormData();
  form.append("file", file);
  const { data } = await api.post<ResumeUploadResponse>("/resume/upload", form);
  return data;
}

export async function analyzeJD(jdText: string): Promise<JDModel> {
  const { data } = await api.post<JDModel>("/jd/analyze", { jd_text: jdText });
  return data;
}

export async function tailor(resume: ResumeModel, jd: JDModel): Promise<TailorResult> {
  const { data } = await api.post<TailorResult>("/tailor", { resume, jd });
  return data;
}

/** Feedback loop (§26): phrases the user rejected in the per-bullet review are
 * stored server-side and fed to future tailors as an avoid-list. Best-effort —
 * callers fire-and-forget. */
export async function recordRejectedPhrases(rejected: string[]): Promise<void> {
  if (rejected.length === 0) return;
  await api.post("/profile/writing-prefs", { rejected });
}

/** The letter, and the 24-hour pass it rode (Phase 30 / B5): the first letter for
 * a posting uses 1, and changes to it within the pass are included. The pass is
 * per posting, so it comes back on this response, never in /auth/me; a card that
 * remounted reads it back with `coverLetterPass`. */
export async function coverLetter(
  resume: ResumeModel,
  jd: JDModel,
  tone = "professional",
): Promise<CoverLetterResponse> {
  const { data } = await api.post<CoverLetterResponse>("/cover-letter", {
    resume,
    jd,
    tone,
  });
  return data;
}

/** This posting's cover-letter pass as the next letter would ride it, read and
 * never taken (P30-RELOAD-PASS): 0/0 when none is open. The server hashes the JD
 * with the key the letter was charged under, so the body is the JD and nothing
 * else — the route forbids any other field (check-mirrors 36). */
export async function coverLetterPass(jd: JDModel): Promise<UsagePassOut> {
  const { data } = await api.post<UsagePassOut>("/cover-letter/pass", { jd });
  return data;
}

/** "Rami Bar - AppsFlyer" from whatever parts exist; falls back to "resume". */
export function resumeFilename(candidateName: string, company: string): string {
  const clean = (s: string) => s.replace(/[<>:"/\\|?*]+/g, "").replace(/\s+/g, " ").trim();
  const parts = [clean(candidateName), clean(company)].filter(Boolean);
  return parts.join(" - ") || "resume";
}

/** Visual templates the backend renderers support (see app/render/templates.py).
 * Order is the picker's display order, and `standard` leads it because it is
 * `DEFAULT_TEMPLATE` — an id the backend falls back to for any name it does not
 * know, so every one of these defaults has to name it. `split` and `panel` are two-column PDF
 * designs — their .docx falls back to the closest single-column sibling
 * (see `isPdfOnlyTemplate` in components/TemplatePicker). */
export const RESUME_TEMPLATES = [
  "standard",
  "classic",
  "modern",
  "split",
  "panel",
  "timeline",
  "executive",
  "ivy",
  "ledger",
  "student",
  "compact",
  "minimal",
] as const;
export type ResumeTemplate = (typeof RESUME_TEMPLATES)[number];

export async function downloadResume(
  resume: ResumeModel,
  fmt: "docx" | "pdf",
  filename?: string,
  template: ResumeTemplate = "standard",
): Promise<void> {
  const resp = await api.post("/render", { resume, fmt, template }, { responseType: "blob" });
  const url = URL.createObjectURL(resp.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename || "resume"}.${fmt}`;
  // In the document and revoked late, both on purpose. A detached anchor's
  // download click is ignored outside Chrome, and revoking in the same tick can
  // cancel a download that hasn't started reading the blob — neither shows up
  // in Chrome, which is where this was written.
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function interviewQuestions(
  resume: ResumeModel,
  jd: JDModel,
): Promise<InterviewQuestionsResult> {
  const { data } = await api.post<InterviewQuestionsResult>("/interview/questions", { resume, jd });
  return data;
}

export async function interviewAnswer(
  resume: ResumeModel,
  jd: JDModel,
  question: string,
): Promise<InterviewAnswerResult> {
  const { data } = await api.post<InterviewAnswerResult>("/interview/answer", { resume, jd, question });
  return data;
}

export async function interviewFeedback(
  resume: ResumeModel,
  question: string,
  answer: string,
): Promise<InterviewFeedbackResult> {
  const { data } = await api.post<InterviewFeedbackResult>("/interview/feedback", {
    resume,
    question,
    answer,
  });
  return data;
}

export async function interviewChat(
  resume: ResumeModel,
  jdText: string,
  transcript: ChatTurn[],
): Promise<InterviewChatResult> {
  const { data } = await api.post<InterviewChatResult>("/interview/chat", {
    resume,
    jd_text: jdText,
    transcript,
  });
  return data;
}

export async function interviewScorecard(
  resume: ResumeModel,
  jdText: string,
  transcript: ChatTurn[],
): Promise<InterviewScorecardResult> {
  const { data } = await api.post<InterviewScorecardResult>("/interview/scorecard", {
    resume,
    jd_text: jdText,
    transcript,
  });
  return data;
}

export async function recruiterScreen(
  resume: ResumeModel,
  jdText: string,
): Promise<RecruiterScreenResult> {
  const { data } = await api.post<RecruiterScreenResult>("/interview/recruiter-screen", {
    resume,
    jd_text: jdText,
  });
  return data;
}

export async function matchJobs(resume: ResumeModel, listings: string[]): Promise<JobMatchResult> {
  const { data } = await api.post<JobMatchResult>("/jobs/match", { resume, listings });
  return data;
}

export async function fetchJob(url: string): Promise<string> {
  const { data } = await api.post<{ text: string }>("/jobs/fetch", { url });
  return data.text;
}

export async function searchJobs(
  resume: ResumeModel,
  customize?: SearchContext | null,
): Promise<JobSearchResult> {
  const { data } = await api.post<JobSearchResult>("/jobs/search", {
    resume,
    customize: customize ?? null,
  });
  invalidateData("history"); // the backend records every search into history
  return data;
}

// One progress frame from the SSE search stream (mirrors the backend's
// job_search progress events): which board is being queried, then which job
// is being fetched + scored.
export interface SearchProgressEvent {
  stage: "boards" | "scoring";
  index: number;
  total: number;
  source?: string; // boards stage: provider id being queried
  title?: string; // scoring stage: the job being scored
  company?: string;
}

// Same search as searchJobs, but over the SSE endpoint so the UI gets real
// per-board / per-job progress. Newer backends also emit one `match` frame per
// scored job (a JobMatch, unordered) — dispatched to onMatch so results can
// stream in before the terminal `result`; older backends simply never send
// them. axios can't consume SSE, so this uses fetch and re-throws failures in
// the axios error shape ({response: {status, data}}) to keep apiErrorMessage
// working, and sends the failure through `onRejected` exactly as the axios path
// does, so a dead session or an unverified account redirects from here too. A 404/405 means an older backend without
// the endpoint — callers fall back to searchJobs.
export async function searchJobsStream(
  resume: ResumeModel,
  customize: SearchContext | null,
  onProgress: (e: SearchProgressEvent) => void,
  onMatch?: (m: JobMatch) => void,
  signal?: AbortSignal,
): Promise<JobSearchResult> {
  const code = localStorage.getItem(ACCESS_CODE_KEY);
  const resp = await fetch(`${api.defaults.baseURL}/jobs/search/stream`, {
    method: "POST",
    // The same headers the axios instance sends. This POST is a spend, and
    // without CSRF_HEADER a session-authenticated search is a 403 `csrf`.
    headers: {
      "Content-Type": "application/json",
      ...CSRF_HEADER,
      ...(code ? { "X-App-Key": code } : {}),
    },
    body: JSON.stringify({ resume, customize: customize ?? null }),
    signal,
  });
  // The use was reserved before the stream opened, so its count rides these
  // headers like any other counted call's (Phase 30 / B4.2).
  noteUsesHeaders(resp.headers);
  const isSse = (resp.headers.get("content-type") || "").includes("text/event-stream");
  if (!resp.ok || !isSse || !resp.body) {
    let detail: unknown;
    try {
      detail = ((await resp.json()) as { detail?: unknown })?.detail;
    } catch {
      /* non-JSON body */
    }
    onRejected(resp.status, "/jobs/search/stream", detail, Boolean(code));
    throw { response: { status: resp.status, data: { detail } } };
  }

  // Minimal SSE parse: our server sends single-line `event:`/`data:` pairs
  // separated by blank lines, plus ignorable `:` keep-alive comments.
  const out: {
    result: JobSearchResult | null;
    error: { detail?: unknown; status?: number } | null;
  } = { result: null, error: null };
  let event = "";
  let data = "";
  const dispatch = () => {
    if (data) {
      if (event === "progress") onProgress(JSON.parse(data) as SearchProgressEvent);
      else if (event === "match") onMatch?.(JSON.parse(data) as JobMatch);
      else if (event === "result") out.result = JSON.parse(data) as JobSearchResult;
      else if (event === "error") out.error = JSON.parse(data);
    }
    event = "";
    data = "";
  };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (e) {
      // The user's Cancel aborts the read, and that is theirs to report. Any
      // other failed read is the connection going away mid-search.
      if (signal?.aborted) throw e;
      throw connectionDropped();
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) data += line.slice("data: ".length);
      else if (line === "") dispatch();
    }
  }
  if (out.error) {
    // The server refunds a failed search on its worker, outside this request,
    // where no header can carry the count back, so /auth/me is asked again
    // (Phase 30 / C3). Through refreshUses for this tab's own account, never
    // getAuthMe: that re-stamps the resume draft's owner from whatever the
    // answer says, and an answer for an expired session or another account
    // signed in from another tab would claim this tab's unsaved edits. No
    // account known (the guard failed open) means nothing is refreshed.
    const account = tabAccount();
    if (account !== null) void refreshUses(account);
    throw { response: { status: out.error.status ?? 502, data: { detail: out.error.detail } } };
  }
  if (!out.result) {
    // Stream ended without a terminal frame (connection dropped mid-search).
    throw connectionDropped();
  }
  invalidateData("history"); // the backend records every search into history
  return out.result;
}

/**
 * The tailor, streamed (PLAN 31.3/2): `onStage` hears each pipeline stage as the
 * server STARTS it, and the promise resolves to the same TailorResult `tailor`
 * returns. The charge is /tailor's, decided before the stream opens, so a
 * monthly or daily refusal is a plain HTTP error here, carrying the uses
 * headers; a failure after that rides the stream as an error frame whose
 * status and detail are what a plain response would carry (a size refusal's
 * 413 included), so `apiErrorMessage` reads either one. The parse is
 * `searchJobsStream`'s, the same server framing.
 */
export async function tailorStream(
  resume: ResumeModel,
  jd: JDModel,
  onStage: (stage: TailorStage) => void,
  signal?: AbortSignal,
): Promise<TailorResult> {
  const code = localStorage.getItem(ACCESS_CODE_KEY);
  const resp = await fetch(`${api.defaults.baseURL}/tailor/stream`, {
    method: "POST",
    // The axios instance's headers: a session-authenticated spend without
    // CSRF_HEADER is a 403 `csrf`.
    headers: {
      "Content-Type": "application/json",
      ...CSRF_HEADER,
      ...(code ? { "X-App-Key": code } : {}),
    },
    body: JSON.stringify({ resume, jd }),
    signal,
  });
  noteUsesHeaders(resp.headers);
  const isSse = (resp.headers.get("content-type") || "").includes("text/event-stream");
  if (!resp.ok || !isSse || !resp.body) {
    let detail: unknown;
    try {
      detail = ((await resp.json()) as { detail?: unknown })?.detail;
    } catch {
      /* non-JSON body */
    }
    onRejected(resp.status, "/tailor/stream", detail, Boolean(code));
    throw { response: { status: resp.status, data: { detail } } };
  }

  const out: {
    result: TailorResult | null;
    error: { detail?: unknown; status?: number } | null;
  } = { result: null, error: null };
  let event = "";
  let data = "";
  const dispatch = () => {
    if (data) {
      if (event === "progress") {
        const stage = (JSON.parse(data) as { stage?: unknown }).stage;
        if (isTailorStage(stage)) onStage(stage);
      } else if (event === "result") out.result = JSON.parse(data) as TailorResult;
      else if (event === "error") out.error = JSON.parse(data);
    }
    event = "";
    data = "";
  };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (signal?.aborted) throw e;
      throw connectionDropped();
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) data += line.slice("data: ".length);
      else if (line === "") dispatch();
    }
  }
  if (out.error) {
    // The server gave the use (or the ride) back on its worker, where no header
    // can carry the count, so this tab's own account asks again: the search
    // stream's rule, through refreshUses, never getAuthMe.
    const account = tabAccount();
    if (account !== null) void refreshUses(account);
    throw { response: { status: out.error.status ?? 502, data: { detail: out.error.detail } } };
  }
  if (!out.result) throw connectionDropped();
  return out.result;
}

const DROPPED = "connection_dropped";

/** A search stream that ended with no result and no error frame: the connection
 * dropped. The server may still finish, write the jobs to History and keep the
 * use, so a caller says that instead of reporting a failure. It keeps the axios
 * error shape (status 0), so `apiErrorMessage` still reads it anywhere else. */
function connectionDropped() {
  return { response: { status: 0, data: { detail: "" } }, dropped: DROPPED };
}

/** Whether a `searchJobsStream` failure is a dropped connection rather than an
 * answer from the server (and never a user's Cancel, which is an abort). */
export function isConnectionDropped(e: unknown): boolean {
  return (e as { dropped?: unknown } | null | undefined)?.dropped === DROPPED;
}

export async function searchContext(resume: ResumeModel): Promise<SearchContext> {
  const { data } = await api.post<SearchContext>("/jobs/search-context", { resume });
  return data;
}

/** Saved "Customize search" picks (server-side, per user) — null when none saved. */
export async function getSearchPrefs(): Promise<SearchContext | null> {
  const { data } = await api.get<{ context: SearchContext | null }>("/jobs/search-prefs");
  return data.context ?? null;
}

/** Persist the customize picks (or clear them with null) for the next visit. */
export async function updateSearchPrefs(context: SearchContext | null): Promise<void> {
  await api.put("/jobs/search-prefs", { context });
}

// Batch auto-tailor kits (PLAN 8.1): enqueue high-fit jobs, then drain the
// queue one tailor per request — each processNextKit call is a single
// pipeline run, so the client loop is what keeps a serverless backend busy.
export async function createKitBatch(jobs: KitJobIn[]): Promise<KitBatchResult> {
  const { data } = await api.post<KitBatchResult>("/kits/batch", { jobs });
  return data;
}

export async function processNextKit(): Promise<KitProcessResult> {
  const { data } = await api.post<KitProcessResult>("/kits/process-next");
  return data;
}

export async function listKits(): Promise<KitOut[]> {
  const { data } = await api.get<{ kits: KitOut[] }>("/kits");
  return data.kits;
}

export async function getKit(id: number): Promise<KitDetail> {
  const { data } = await api.get<KitDetail>(`/kits/${id}`);
  return data;
}

export async function deleteKit(id: number): Promise<void> {
  await api.delete(`/kits/${id}`);
}

/** Approve a reviewed kit into the tracker (PLAN 8.2). `resume` is the
 * effective resume after per-bullet accept/reject; null keeps the kit's full
 * tailored resume. */
export async function approveKit(
  id: number,
  resume: ResumeModel | null,
  coverLetter: string,
): Promise<KitOut> {
  const { data } = await api.post<KitOut>(`/kits/${id}/approve`, {
    resume,
    cover_letter: coverLetter,
  });
  invalidateData("applications", "nudges"); // approve writes a tracker row
  return data;
}

/** Store the letter the review page just generated on the kit, so a reload of
 * /kits/:id shows it again. It reaches no model and costs nothing. */
export async function saveKitCoverLetter(id: number, coverLetter: string): Promise<void> {
  await api.put(`/kits/${id}/cover-letter`, { cover_letter: coverLetter });
}

export async function rejectKit(id: number, reason: string): Promise<KitOut> {
  const { data } = await api.post<KitOut>(`/kits/${id}/reject`, { reason });
  return data;
}

/** True auto-submit (PLAN 8.4): send an approved, guard-clean Comeet kit's
 * application through Comeet's public apply API. The backend enforces every
 * guardrail; this really applies to the job. */
export async function submitKit(id: number): Promise<KitOut> {
  const { data } = await api.post<KitOut>(`/kits/${id}/submit`);
  invalidateData("applications", "nudges"); // submit flips the tracker app to applied
  return data;
}

export async function getJobAlert(): Promise<AlertSettings> {
  return cachedFetch("alert", async () => {
    const { data } = await api.get<AlertSettings>("/jobs/alerts");
    return data;
  });
}

export async function updateJobAlert(payload: {
  enabled: boolean;
  email: string;
  context?: SearchContext | null;
  nudge_emails?: boolean;
  // Omitting this leaves the server's stored bar alone (see AlertSettingsIn) —
  // only send it when the user actually picked a value.
  min_score?: number;
}): Promise<AlertSettings> {
  const { data } = await api.put<AlertSettings>("/jobs/alerts", payload);
  invalidateData("alert");
  return data;
}

export async function runJobAlert(): Promise<AlertRunResult> {
  const { data } = await api.post<AlertRunResult>("/jobs/alerts/run");
  invalidateData("alert", "history"); // the run stamps bookkeeping + records hits
  return data;
}

export async function getJobHistory(): Promise<JobSearchHistory> {
  return cachedFetch("history", async () => {
    const { data } = await api.get<JobSearchHistory>("/jobs/history");
    return data;
  });
}

export async function deleteJobHistoryItem(id: number): Promise<void> {
  await api.delete(`/jobs/history/${id}`);
  invalidateData("history");
}

export async function clearJobHistory(): Promise<void> {
  await api.delete("/jobs/history");
  invalidateData("history");
}

/** The CV scan (Phase 30 / A2): an app tool behind the sign-in, like every other
 * feature. Deterministic, nothing stored server-side. It uses 1 of the month's
 * uses and has its own daily cap; a file the server refuses or cannot read gives
 * the use back. It was the public, anonymous `/public/scan` until Phase 30. */
export async function scanResume(file: File, jdText: string): Promise<FreeScanResult> {
  const form = new FormData();
  form.append("file", file);
  form.append("jd_text", jdText);
  const { data } = await api.post<FreeScanResult>("/tools/scan", form);
  return data;
}

/** Render the resume and read it back with our own parser — deterministic, uncapped. */
export async function atsXray(
  resume: ResumeModel,
  template: ResumeTemplate = "standard",
  fmt: "pdf" | "docx" = "pdf",
  signal?: AbortSignal,
): Promise<ATSXrayResult> {
  const { data } = await api.post<ATSXrayResult>("/tools/ats-xray", { resume, template, fmt }, { signal });
  return data;
}

/** The real PDF as page pictures, for a phone, which cannot draw a PDF inside
 * the page (PLAN 31.2/4). Deterministic and free, like the render it draws. */
export async function renderPages(
  resume: ResumeModel,
  template: ResumeTemplate = "standard",
  signal?: AbortSignal,
): Promise<PageImagesResult> {
  const { data } = await api.post<PageImagesResult>("/render/pages", { resume, template }, { signal });
  return data;
}

/** The rendered file itself, as a Blob, WITHOUT triggering a download.
 *
 * Deliberately not folded into `downloadResume`: that one carries two
 * documented cross-browser workarounds on the anchor-and-revoke path, and it is
 * the shipped download. This is the same POST to the same route, so a preview
 * built from it is the file the Download button produces — the claim the UI
 * makes about it stays true by construction.
 *
 * The media type is set explicitly rather than trusted from the response: a
 * blob with the wrong type renders as a download prompt instead of a page. */
export async function renderResumeBlob(
  resume: ResumeModel,
  fmt: "docx" | "pdf",
  template: ResumeTemplate = "standard",
  signal?: AbortSignal,
): Promise<Blob> {
  const resp = await api.post("/render", { resume, fmt, template }, { responseType: "blob", signal });
  return new Blob([resp.data as BlobPart], {
    type:
      fmt === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

/** Live page measurement. Deterministic and uncapped — but it is a real
 * reportlab build (~15 ms), so callers debounce and pass an AbortSignal. */
export async function pageCount(
  resume: ResumeModel,
  template: ResumeTemplate = "standard",
  signal?: AbortSignal,
): Promise<PageCountResult> {
  const { data } = await api.post<PageCountResult>("/tools/page-count", { resume, template }, { signal });
  return data;
}

/** Live keyword coverage. Deterministic, uncapped, ~0.15 ms of Python — the one
 * number on the review surface that can honestly move as the user accepts and
 * declines edits. Takes an ANALYSED jd, never raw text. */
export async function coverageOf(
  resume: ResumeModel,
  jd: JDModel,
  signal?: AbortSignal,
): Promise<CoverageResult> {
  const { data } = await api.post<CoverageResult>("/tools/coverage", { resume, jd }, { signal });
  return data;
}

/** Every deterministic review check, run against the document as it stands.
 *
 * Uncapped and free — the route carries no `Depends`, reaches no model and no
 * network — which is what makes it safe to re-run on every edit exactly as
 * `coverageOf` is. It takes an ANALYSED `jd` or `null`, never raw job-ad text:
 * an uncapped route that accepted job-ad text would have to reach the model to
 * use it, which is the `/tools/ats-scan` mistake this repo has already paid
 * for once. Pass `null` and the JD-gated checks simply do not fire — they come
 * back in `skipped`, not in `passed`, because unknown is never clean.
 *
 * The `AbortSignal` is not optional in practice: `useReview` debounces at
 * 400 ms and aborts the in-flight request on every keystroke, the way
 * `useCoverage` does over `coverageOf`. Without it a fast typist stacks
 * requests and the LAST response to arrive wins, which is not the last one
 * asked for — findings for a resume two edits ago, painted as current.
 *
 * DELIBERATELY NOT in `lib/dataCache.ts`, and neither is `reviewRewrites`.
 * That cache exists for SERVER state several pages read and a mutating wrapper
 * invalidates (the master resume, kits, history): a short string key, a 30 s
 * fresh window. This is the opposite in all three respects — the input is an
 * in-memory `ResumeModel` recomputed per keystroke, so there is no honest key
 * short of hashing the whole document; a 30 s window would paint findings for
 * a resume the user has already edited away, which is the one thing this panel
 * must never do; and no mutation exists to invalidate it, because the edits
 * that change the answer never touch the server. Debounce plus abort is the
 * right mechanism here, and it already exists. */
export async function reviewResume(
  resume: ResumeModel,
  jd: JDModel | null,
  signal?: AbortSignal,
): Promise<ReviewResult> {
  const { data } = await api.post<ReviewResult>(
    "/tools/review",
    { resume, jd: jd ?? null },
    { signal },
  );
  return data;
}

/** Model rewordings for the rewritable findings — the ONE part of the review
 * that spends. USES 1 of the month's uses and is capped, which is why it sits
 * behind a button instead of riding the debounce: everything else on this
 * surface is free, and a review that quietly billed per keystroke would be the
 * uncapped-route defect wearing the other hat.
 *
 * `paths` picks which bullets to ask about; an empty array means "choose the
 * rewritable findings server-side". The response is guard-checked after the
 * call (a `before` that matches no bullet, a number in `after` that is not in
 * `before`, a banned phrase) and says how many it refused — see
 * `ReviewRewriteResult.dropped`. Not cached, for `reviewResume`'s reasons plus
 * a sharper one: a cache hit would offer a rewrite for a bullet the user has
 * since rewritten, and "Use this" would then write stale text onto the paper. */
export async function reviewRewrites(
  resume: ResumeModel,
  paths: string[] = [],
): Promise<ReviewRewriteResult> {
  const { data } = await api.post<ReviewRewriteResult>("/tools/review/rewrites", {
    resume,
    paths,
  });
  return data;
}

/** Read a posting and score the resume against it, before any tailoring.
 * USES 1 of the month's uses: reading a posting is a model call, and there is
 * no version of this that is free. That use also covers tailoring the same
 * analysed job for 24 hours (`tailor_included_until`, Phase 30 / B4.4), and the
 * JD comes back so the tailor does not pay to read the same posting again. */
export async function checkFit(resume: ResumeModel, jdText: string): Promise<FitCheckResult> {
  const { data } = await api.post<FitCheckResult>("/jobs/fit", { resume, jd_text: jdText });
  // The included tailor's end becomes a deadline on THIS device's clock, taken
  // on arrival from the server's relative seconds (`inclusionFrom`, the cover
  // letter's rule), so everything downstream that compares it with Date.now()
  // is comparing like with like. The server's absolute instant, read against a
  // phone clock running ahead, ended the tailor early, and at 0 uses left that
  // disabled a Tailor the ride still covered. A backend that predates the field
  // keeps its instant.
  if (typeof data.tailor_expires_in_s !== "number") return data;
  const ride = inclusionFrom({ calls_left: 1, expires_in_s: data.tailor_expires_in_s });
  return { ...data, tailor_included_until: ride ? ride.until : "" };
}

export async function linkedinOptimize(resume: ResumeModel): Promise<LinkedInResult> {
  const { data } = await api.post<LinkedInResult>("/tools/linkedin", { resume });
  return data;
}

/** Friends-beta feedback — `page` is the pathname the user was on. */
export async function sendFeedback(page: string, text: string): Promise<FeedbackOut> {
  const { data } = await api.post<FeedbackOut>("/feedback", { page, text });
  return data;
}

/** Who the current request belongs to (GET /profile/me). Deliberately
 * un-cached: it is one small row read once per page visit, and the alternative
 * (a cache entry) would go stale against an admin rename with nothing to
 * invalidate it. The app shell and Settings read `getAuthMe` instead, which
 * carries the same three fields plus how the request was recognised. */
export async function getMe(): Promise<Me> {
  const { data } = await api.get<Me>("/profile/me");
  return data;
}

/** What a tailored resume may leave out (GET /profile/resume-prefs). Off for
 * every account until the user turns it on in Settings.
 *
 * Un-cached, for getMe's reason: Settings reads it once per visit. A response
 * without the flag is REFUSED rather than read as "off". For a switch the user
 * turned on, showing it off is a false statement about their own setting, so
 * the Settings card says it could not load instead. */
export async function getResumePrefs(): Promise<ResumePrefs> {
  const { data } = await api.get<Partial<ResumePrefs> | null>("/profile/resume-prefs");
  const hide = data?.hide_arabic_in_israel;
  if (typeof hide !== "boolean") throw new Error("resume-prefs response carries no hide_arabic_in_israel");
  return { hide_arabic_in_israel: hide };
}

/** Save the preferences and return what the server STORED. A response without
 * the flag is read back rather than trusted, `rotateExtensionKey`'s rule: the
 * switch must show what is stored, not what was asked for. */
export async function updateResumePrefs(prefs: ResumePrefs): Promise<ResumePrefs> {
  const { data } = await api.put<Partial<ResumePrefs> | null>("/profile/resume-prefs", prefs);
  const hide = data?.hide_arabic_in_israel;
  return typeof hide === "boolean" ? { hide_arabic_in_israel: hide } : getResumePrefs();
}

// ---- accounts: the /auth routes -------------------------------------------- //

/** POST /profile/onboarded (PLAN 31.1/11): record that this ACCOUNT finished or
 * skipped the first-run questions, so no other device asks again. Free, no
 * model, idempotent; callers treat a failure as harmless (the device's own
 * record still keeps the modal from reopening here). */
export async function markOnboarded(): Promise<void> {
  await api.post("/profile/onboarded");
}

/** Who this browser is, and whether that account may use the app. Always 200.
 *
 * Un-cached, for getMe's reason and a sharper one: every auth page and the app
 * shell's guard ask this on the way in, and a cached "signed out" would outlive
 * the login that just changed it.
 *
 * A stored invite code the server did NOT recognise is forgotten here. On this
 * route an unknown code falls through to the cookie instead of returning 401,
 * so the response interceptor never sees it fail. Left in storage, it would
 * 401 the first protected call of whichever account signs in next. "dev" is
 * the gate being off locally, where every request is the admin and a code
 * means nothing either way. */
export async function getAuthMe(): Promise<AuthMe> {
  const { data } = await api.get<AuthMe>("/auth/me");
  if (data.method !== "invite_code" && data.method !== "dev" && localStorage.getItem(ACCESS_CODE_KEY))
    localStorage.removeItem(ACCESS_CODE_KEY);
  // The resume draft remembers which account wrote it, and is offered to no
  // one else (lib/draft.ts). Every answer updates it, signed out included.
  noteDraftOwner(data.user?.id ?? null);
  // This month's uses go to the uses store (lib/usesStore.ts), from every
  // answer, a signed-out one included (which leaves the count unknown).
  // AppLayout's guard is the first, and it answers before the shell renders.
  setUsage(data.usage ?? null);
  return data;
}

/** Re-read this month's uses for the account `expectedId`: what the Chrome
 * extension, another tab or another device spent, whose X-Uses headers never
 * reach this page (P30-EXT-LIMIT). AppLayout calls it when the tab is shown
 * again, throttled.
 *
 * It writes the uses store and NOTHING else, which is why it is not getAuthMe.
 * getAuthMe re-stamps the resume draft's owner from every answer (lib/draft.ts):
 * on a tab whose session expired while it was hidden, that would stamp the
 * user's unsaved edits with no owner, so they are never offered back after the
 * next sign-in; with another account signed in from another tab, it would stamp
 * this tab's resume with that account's id and offer it to them as their own.
 * It also never forgets a stored code and never redirects: a session that ended
 * is AccessGate's, through the next protected call's 401.
 *
 * The store is written only when the answer is this same account signed in
 * (`usageIfSameUser`); otherwise, and on any error, it keeps what it has. */
export async function refreshUses(expectedId: number): Promise<void> {
  try {
    const { data } = await api.get<AuthMe>("/auth/me");
    const usage = usageIfSameUser(expectedId, data);
    if (usage !== undefined) setUsage(usage);
  } catch {
    /* the count on screen stays what it was; the server still decides every call */
  }
}

/** The /auth/me answer for a page that needs all of it mid-session (Settings'
 * identity lines and account controls), with refreshUses' discipline: the uses
 * store is written only when the answer is `expectedId` signed in, and the
 * resume draft's owner is NEVER re-stamped. getAuthMe is for the guard and the
 * sign-in pages, which decide who this tab is; a page reached mid-session only
 * reads. Rejects on a failed request; the caller treats that as "not known". */
export async function readAuthMe(expectedId: number | null): Promise<AuthMe> {
  const { data } = await api.get<AuthMe>("/auth/me");
  const usage = typeof expectedId === "number" ? usageIfSameUser(expectedId, data) : undefined;
  if (usage !== undefined) setUsage(usage);
  return data;
}

/** POST /auth/password, /auth/logout-others and /auth/reset: whether the
 * extension key was replaced too, and the new key when the server returns it.
 * Read through `readKeyRotation` (lib/authResults.ts), never directly. */
export interface KeyRotationFields {
  extension_key_rotated?: boolean;
  key?: string;
}

/** Everything a successful sign-in must forget from before it.
 *
 * The stored invite code goes. It outranks the account cookie on every
 * protected route, so a stale one would 401 the account that just signed in,
 * and that 401 would send it straight back to /login. Both caches go too, for
 * `deleteAccount`'s reason: a different person may be signing in on this
 * device, and nine pages read the master resume from a module binding that
 * `clearDataCache` cannot reach. */
function adoptSession(): void {
  localStorage.removeItem(ACCESS_CODE_KEY);
  clearDataCache();
  resetMasterCache();
}

/** Creates the account and signs this browser in UNVERIFIED: every feature
 * route refuses it until the emailed code or link confirms the address. */
export async function signup(payload: {
  name: string;
  email: string;
  password: string;
  locale: string;
}): Promise<AuthMe> {
  const { data } = await api.post<AuthMe>("/auth/signup", payload);
  adoptSession();
  return data;
}

/** A wrong password and an unknown address fail identically (400
 * `invalid_credentials`): the server never says which one it was. */
export async function login(payload: { email: string; password: string }): Promise<AuthMe> {
  const { data } = await api.post<AuthMe>("/auth/login", payload);
  adoptSession();
  return data;
}

/** Continue with Google (Phase 30 F1): the URL of Google's account chooser. The
 * caller sends the whole document there. Google comes back through the server's
 * callback, which signs this browser in and goes to `next`, or goes to
 * `/<page>?google=<code>` when it refused.
 *
 * What a sign-in must forget is forgotten HERE, before the document leaves: the
 * way back is a redirect, so no code of ours runs then to do it. */
export async function startGoogleSignIn(payload: {
  next: string;
  locale: string;
  page: "login" | "signup";
}): Promise<string> {
  const { data } = await api.post<{ url?: string }>("/auth/google/start", payload);
  if (!data?.url) throw new Error("the Google sign-in start returned no URL");
  adoptSession();
  return data.url;
}

/** Ends this browser's session on the server. Callers ignore a failure,
 * because forgetting this device still has to happen (see `signOut`). */
export async function logout(): Promise<void> {
  await api.post("/auth/logout");
}

/** Either a 6-digit `code` or the email link's `token`. Both confirm only from a
 * signed-in session of the account being confirmed (FIXB B1), on any device,
 * and the link never creates one: `signed_in` says this browser held it. */
export async function verifyEmail(payload: {
  code?: string;
  token?: string;
}): Promise<VerifyEmailResult> {
  const { data } = await api.post<VerifyEmailResult>("/auth/verify", payload);
  if (data.signed_in) adoptSession();
  return data;
}

export async function resendVerification(): Promise<ResendResult> {
  const { data } = await api.post<ResendResult>("/auth/resend");
  return data;
}

/** Fix a typo in an address that is not verified yet. A new code goes to the
 * new address, and every code sent to the old one stops working. */
export async function changeEmail(email: string): Promise<AuthMe> {
  const { data } = await api.post<AuthMe>("/auth/change-email", { email });
  return data;
}

/** Resolves for any address, known or not: the server never says whether an
 * account exists for it. */
export async function forgotPassword(email: string): Promise<void> {
  await api.post("/auth/forgot", { email });
}

/** Sets a new password from an emailed link and signs this browser in. Every
 * other session on the account ends, and the extension key is replaced. */
export async function resetPassword(token: string, password: string): Promise<AuthMe & KeyRotationFields> {
  const { data } = await api.post<AuthMe & KeyRotationFields>("/auth/reset", { token, password });
  adoptSession();
  return data;
}

/** Changing the password ends every OTHER session on the account. */
export async function changePassword(payload: {
  current_password?: string;
  new_password: string;
}): Promise<KeyRotationFields> {
  const { data } = await api.post<KeyRotationFields>("/auth/password", payload);
  return data ?? {};
}

export async function logoutOtherDevices(): Promise<KeyRotationFields> {
  const { data } = await api.post<KeyRotationFields>("/auth/logout-others");
  return data ?? {};
}

/** The key the Chrome extension signs in with. For an invite-code account it IS
 * the invite code. */
export async function getExtensionKey(): Promise<string> {
  const { data } = await api.get<{ key: string }>("/auth/extension-key");
  return data.key;
}

/** Replace the extension key. The old key stops working at once. The response
 * should carry the new key, and it is read back if it does not, so the page is
 * never left showing a key that has just been switched off. */
export async function rotateExtensionKey(): Promise<string> {
  const { data } = await api.post<{ key?: string }>("/auth/extension-key/rotate");
  return data?.key || (await getExtensionKey());
}

/** Privacy wipe (PLAN 7.5): deletes everything the current user stored —
 * resumes, applications, history, alerts, usage, feedback, kits. The account
 * keeps working: this browser stays signed in and an invite code stays valid.
 * Returns per-table deleted-row counts. */
export async function deleteMyData(): Promise<Record<string, number>> {
  const { data } = await api.delete<Record<string, number>>("/profile/data");
  clearDataCache();
  return data;
}

/** Close the account (PLAN 23.5): the same wipe, and then the account stops
 * resolving. Its sessions end, an invite code dies, and every later request
 * 401s into the login redirect.
 *
 * Clears BOTH caches, and that is not belt-and-braces: `clearDataCache` only
 * empties the `dataCache` Map, while `useMasterResume` keeps the master in a
 * plain module-level binding that nothing else can reach — which is exactly
 * why `resetMasterCache` exists. Skipping it leaves nine pages still painting
 * the resume of an account that no longer exists.
 *
 * (This import makes api/client ↔ hooks/useMasterResume a cycle. It is safe
 * because both sides only ever call across it at runtime, never at module
 * evaluation, and `resetMasterCache` is a hoisted function declaration.)
 */
export async function deleteAccount(): Promise<DeleteAccountResult> {
  const { data } = await api.delete<DeleteAccountResult>("/profile/account");
  clearDataCache();
  resetMasterCache();
  return data;
}

export async function followUp(payload: {
  company: string;
  role: string;
  stage: string;
  context: string;
}): Promise<FollowUpResult> {
  const { data } = await api.post<FollowUpResult>("/tools/follow-up", payload);
  return data;
}

export async function outreach(payload: {
  resume: ResumeModel;
  jd_text?: string;
  company?: string;
  job_title?: string;
  contact_name?: string;
  contact_role?: string;
}): Promise<OutreachResult> {
  const { data } = await api.post<OutreachResult>("/outreach", payload);
  return data;
}

export async function screeningAnswer(payload: {
  resume: ResumeModel;
  jd_text?: string;
  question: string;
}): Promise<ScreeningAnswerResult> {
  const { data } = await api.post<ScreeningAnswerResult>("/tools/screening-answer", payload);
  return data;
}

export async function companyBrief(payload: {
  resume: ResumeModel;
  company?: string;
  url?: string;
  page_text?: string;
  jd_text?: string;
  job_title?: string;
}): Promise<CompanyBriefResult> {
  const { data } = await api.post<CompanyBriefResult>("/tools/company-brief", payload);
  return data;
}

/** Most recently updated master, or the `lang` one ("en"/"he") when asked. */
export async function getMasterResume(lang?: "en" | "he"): Promise<MasterResume | null> {
  return cachedFetch(`master:${lang ?? "latest"}`, async () => {
    const { data } = await api.get<MasterResume | null>("/profile/resume", {
      params: lang ? { lang } : undefined,
    });
    return data ?? null;
  });
}

/** Every saved master (at most one per language), newest first. */
export async function listMasterResumes(): Promise<MasterResume[]> {
  return cachedFetch("masters", async () => {
    const { data } = await api.get<{ resumes: MasterResume[] }>("/profile/resumes");
    return data.resumes ?? [];
  });
}

/** Restore points for the master resume (PLAN 20.8/N1) — metadata only; the
 * full resume comes from `getResumeVersion`. Not cached: after a save the list
 * has changed by definition, and it's only fetched when the picker opens. */
export async function listResumeVersions(lang?: "en" | "he"): Promise<ResumeVersion[]> {
  const { data } = await api.get<{ versions: ResumeVersion[] }>("/profile/resume/versions", {
    params: lang ? { lang } : undefined,
  });
  return data.versions;
}

export async function getResumeVersion(id: number): Promise<MasterResume> {
  const { data } = await api.get<MasterResume>(`/profile/resume/versions/${id}`);
  return data;
}

/** Make a version current again. The replaced state is snapshotted server-side,
 * so this is itself undoable. */
export async function restoreResumeVersion(id: number): Promise<MasterResume> {
  const { data } = await api.post<MasterResume>(`/profile/resume/versions/${id}/restore`);
  invalidateData("master", "masters");
  return data;
}

export async function saveMasterResume(payload: {
  resume: ResumeModel;
  ledger?: FactsLedger | null;
  label?: string;
}): Promise<MasterResume> {
  const { data } = await api.put<MasterResume>("/profile/resume", payload);
  invalidateData("master", "masters");
  return data;
}

export async function listApplications(): Promise<ApplicationOut[]> {
  return cachedFetch("applications", async () => {
    const { data } = await api.get<ApplicationOut[]>("/applications");
    return data;
  });
}

export async function getStaleApplications(): Promise<StaleApplication[]> {
  return cachedFetch("nudges", async () => {
    const { data } = await api.get<{ items: StaleApplication[] }>("/applications/nudges");
    return data.items;
  });
}

export async function getApplication(id: number): Promise<ApplicationDetail> {
  const { data } = await api.get<ApplicationDetail>(`/applications/${id}`);
  return data;
}

export async function saveApplication(payload: {
  job_title: string;
  company: string;
  jd_text: string;
  // Both optional, matching ApplicationCreate (tailored_resume: Optional = None,
  // cover_letter: str = ""). A job saved straight from search results has
  // neither by definition — that is what "save it and come back later" MEANS —
  // and the wrapper used to over-constrain the schema it wraps.
  tailored_resume?: ResumeModel;
  cover_letter?: string;
  overall_score: number;
  job_url?: string;
  status?: string;
  /** What was sent — feeds the tracker's "what actually converts" report. */
  template?: ResumeTemplate;
  voice_score?: number;
  fabrication_flag_count?: number;
}): Promise<ApplicationOut> {
  const { data } = await api.post<ApplicationOut>("/applications", payload);
  invalidateData("applications", "nudges");
  return data;
}

/** Keep the tailored draft on its job's tracker row (PLAN 31.3/4). The tailor
 * page calls this after a pause in the user's changes; it reaches no model and
 * spends nothing. A 404 means the row was deleted meanwhile. */
export async function saveApplicationDraft(id: number, draft: ApplicationDraft): Promise<ApplicationOut> {
  const { data } = await api.put<ApplicationOut>(`/applications/${id}/draft`, draft);
  invalidateData("applications", "nudges");
  return data;
}

export async function updateApplication(
  id: number,
  patch: { status?: string; notes?: string; interviewed?: boolean; excitement?: number },
): Promise<ApplicationOut> {
  const { data } = await api.patch<ApplicationOut>(`/applications/${id}`, patch);
  invalidateData("applications", "nudges");
  return data;
}

export async function deleteApplication(id: number): Promise<void> {
  await api.delete(`/applications/${id}`);
  invalidateData("applications", "nudges");
}

// ---- Gmail sync: the /inbox routes ----------------------------------------- //
//
// EVERY write below invalidates "applications" and "nudges", including the
// ones that look like they touch no tracker row. A sync creates and moves rows;
// an undo deletes one or moves it back; resolving adds or links one; a purging
// disconnect removes the emails a card's badge is drawn from. The tracker reads
// both lists through `cachedFetch`, so a write that skipped this would leave
// the board painting rows the server has already changed, for up to 30 s after
// the change the user just watched happen. One rule for all of them is cheaper
// than deciding per route which invalidation is safe to skip.
//
// Nothing here is cached either. The status and the event lists change on a
// cron the page cannot see, and a 30 s-old "3 to review" is a count nobody
// believes after resolving two of them.

/** Whether this account can use Gmail sync, and how its connection is doing. */
export async function getInboxStatus(): Promise<InboxStatus> {
  const { data } = await api.get<InboxStatus>("/inbox/status");
  return data;
}

/** The Google consent URL for connecting Gmail. The caller sends the whole
 * document there (`location.assign`), and Google sends it back to
 * `/tracker?inbox=connected` or `/settings?inbox=<error code>`. */
export async function startInboxGoogle(backfillDays?: number): Promise<string> {
  const { data } = await api.post<{ url: string }>(
    "/inbox/google/start",
    backfillDays ? { backfill_days: backfillDays } : {},
  );
  invalidateData("applications", "nudges");
  return data.url;
}

/** Connect the canned demo mailbox (only exists where the server enables it),
 * importing `backfillDays` of its sample history. */
export async function connectFakeInbox(backfillDays?: number): Promise<InboxStatus> {
  const { data } = await api.post<InboxStatus>(
    "/inbox/fake/connect",
    backfillDays ? { backfill_days: backfillDays } : {},
  );
  invalidateData("applications", "nudges");
  return data;
}

/** One sync run. It stops at its own time budget, so an import of past mail
 * can take several runs: `has_more` says whether another one would read more. */
export async function syncInbox(): Promise<InboxSyncResult> {
  const { data } = await api.post<InboxSyncResult>("/inbox/sync");
  invalidateData("applications", "nudges");
  return data;
}

/** `review`: emails waiting for the user to say where they belong. `recent`:
 * what emails changed on the board, newest first: a card created, a status
 * moved, an interviewed flag set. Every one of those is undoable. */
export async function listInboxEvents(view: "review" | "recent", limit = 50): Promise<InboxEvent[]> {
  const { data } = await api.get<InboxEvent[]>("/inbox/events", { params: { view, limit } });
  return data;
}

// The three event actions answer with the event as it now stands. A REFUSAL is
// a 409 carrying `{"code": "inbox_..."}` (`inbox_changed_since`: the card was
// moved by hand after the email, so undoing would overwrite the user;
// `inbox_not_review`: already filed) or a 404 (`inbox_not_found`,
// `inbox_application_not_found`). components/inbox/shared.tsx translates them.

/** Put a card back the way this email found it. An email that CREATED a card
 * nobody has touched since deletes that card. */
export async function undoInboxEvent(id: number): Promise<InboxEvent> {
  const { data } = await api.post<InboxEvent>(`/inbox/events/${id}/undo`);
  invalidateData("applications", "nudges");
  return data;
}

/** Leave a needs-review email off the board for good. */
export async function dismissInboxEvent(id: number): Promise<InboxEvent> {
  const { data } = await api.post<InboxEvent>(`/inbox/events/${id}/dismiss`);
  invalidateData("applications", "nudges");
  return data;
}

/** File a needs-review email: onto an application the user picked, or as a new
 * card. */
export async function resolveInboxEvent(
  id: number,
  target: { application_id: number } | { create: true },
): Promise<InboxEvent> {
  const { data } = await api.post<InboxEvent>(`/inbox/events/${id}/resolve`, target);
  invalidateData("applications", "nudges");
  return data;
}

/** Answers with the whole status, so the caller can adopt the server's copy. */
export async function updateInboxSettings(patch: {
  auto_sync?: boolean;
  backfill_days?: number;
}): Promise<InboxStatus> {
  const { data } = await api.patch<InboxStatus>("/inbox/settings", patch);
  invalidateData("applications", "nudges");
  return data;
}

/** Remove the connection and its stored Google grant. `purge` also deletes the
 * emails already detected; tracker cards stay either way. */
export async function disconnectInbox(purge: boolean): Promise<InboxDisconnectResult> {
  const { data } = await api.delete<InboxDisconnectResult>("/inbox/connection", { params: { purge } });
  invalidateData("applications", "nudges");
  return data;
}
