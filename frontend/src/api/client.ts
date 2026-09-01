import axios from "axios";
import { ACCESS_CODE_KEY, UNAUTHORIZED_EVENT } from "../lib/accessCode";
import { cachedFetch, clearDataCache, invalidateData } from "../lib/dataCache";
import { resetMasterCache } from "../hooks/useMasterResume";
import type {
  AlertRunResult,
  AlertSettings,
  ApplicationDetail,
  ApplicationOut,
  ATSScanResult,
  CompanyBriefResult,
  ChatTurn,
  CoverageResult,
  FitCheckResult,
  FactsLedger,
  FeedbackOut,
  FollowUpResult,
  FreeScanResult,
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
  ResumeHealthResult,
  ResumeModel,
  ResumeUploadResponse,
  ResumeVersion,
  ScreeningAnswerResult,
  SearchContext,
  StaleApplication,
  TailorResult,
  ATSXrayResult,
} from "../types";

// In dev, requests go through the Vite proxy at /api -> http://localhost:8000.
// In production (Vercel), set VITE_API_BASE_URL to the deployed backend URL
// (e.g. https://jobfinder-api.onrender.com) so the frontend calls it directly.
const api = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL || "/api" });

api.interceptors.request.use((config) => {
  const code = localStorage.getItem(ACCESS_CODE_KEY);
  if (code) config.headers["X-App-Key"] = code;
  return config;
});

api.interceptors.response.use(undefined, (error) => {
  if (error?.response?.status === 401) {
    clearDataCache(); // a different code may sign in next — never leak across users
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  return Promise.reject(error);
});

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

export async function coverLetter(
  resume: ResumeModel,
  jd: JDModel,
  tone = "professional",
): Promise<string> {
  const { data } = await api.post<{ cover_letter: string }>("/cover-letter", {
    resume,
    jd,
    tone,
  });
  return data.cover_letter;
}

/** "Rami Bar - AppsFlyer" from whatever parts exist; falls back to "resume". */
export function resumeFilename(candidateName: string, company: string): string {
  const clean = (s: string) => s.replace(/[<>:"/\\|?*]+/g, "").replace(/\s+/g, " ").trim();
  const parts = [clean(candidateName), clean(company)].filter(Boolean);
  return parts.join(" - ") || "resume";
}

/** Visual templates the backend renderers support (see app/render/templates.py).
 * Order is the picker's display order. `split` and `panel` are two-column PDF
 * designs — their .docx falls back to the closest single-column sibling
 * (see `isPdfOnlyTemplate` in components/TemplatePicker). */
export const RESUME_TEMPLATES = [
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
  template: ResumeTemplate = "classic",
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
// and the 401 gate event working. A 404/405 means an older backend without
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
    headers: { "Content-Type": "application/json", ...(code ? { "X-App-Key": code } : {}) },
    body: JSON.stringify({ resume, customize: customize ?? null }),
    signal,
  });
  if (resp.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  const isSse = (resp.headers.get("content-type") || "").includes("text/event-stream");
  if (!resp.ok || !isSse || !resp.body) {
    let detail: unknown;
    try {
      detail = ((await resp.json()) as { detail?: unknown })?.detail;
    } catch {
      /* non-JSON body */
    }
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
    const { done, value } = await reader.read();
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
    throw { response: { status: out.error.status ?? 502, data: { detail: out.error.detail } } };
  }
  if (!out.result) {
    // Stream ended without a terminal frame (connection dropped mid-search).
    throw { response: { status: 0, data: { detail: "" } } };
  }
  invalidateData("history"); // the backend records every search into history
  return out.result;
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
 * effective résumé after per-bullet accept/reject; null keeps the kit's full
 * tailored résumé. */
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

/** Free public CV-vs-JD scan — no access code, nothing stored server-side. */
export async function freeScan(file: File, jdText: string): Promise<FreeScanResult> {
  const form = new FormData();
  form.append("file", file);
  form.append("jd_text", jdText);
  const { data } = await api.post<FreeScanResult>("/public/scan", form);
  return data;
}

/** Deterministic format/content scan, plus keyword coverage when an ANALYSED
 * JD is supplied. It takes `jd`, never `jd_text`: the route is uncapped, so a
 * route that accepted job-ad text would have to reach the model to use it.
 * Analyse the posting once with `analyzeJD` (capped) and scan against it. */
export async function atsScan(resume: ResumeModel, jd?: JDModel | null): Promise<ATSScanResult> {
  const { data } = await api.post<ATSScanResult>("/tools/ats-scan", { resume, jd: jd ?? null });
  return data;
}

/** Render the résumé and read it back with our own parser — deterministic, uncapped. */
export async function atsXray(
  resume: ResumeModel,
  template: ResumeTemplate = "classic",
  fmt: "pdf" | "docx" = "pdf",
  signal?: AbortSignal,
): Promise<ATSXrayResult> {
  const { data } = await api.post<ATSXrayResult>("/tools/ats-xray", { resume, template, fmt }, { signal });
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
  template: ResumeTemplate = "classic",
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
  template: ResumeTemplate = "classic",
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

/** Read a posting and score the résumé against it, before any tailoring.
 * COSTS ONE AI CREDIT — reading a posting is a model call, and there is no
 * version of this that is free. Returns the analysed JD so tailoring afterwards
 * does not pay to read the same posting again. */
export async function checkFit(resume: ResumeModel, jdText: string): Promise<FitCheckResult> {
  const { data } = await api.post<FitCheckResult>("/jobs/fit", { resume, jd_text: jdText });
  return data;
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

/** Who this device's access code belongs to — the Settings Account section.
 * Deliberately un-cached: it is one small row read once per page visit, and
 * the alternative (a cache entry) would go stale against an admin rename with
 * nothing to invalidate it. */
export async function getMe(): Promise<Me> {
  const { data } = await api.get<Me>("/profile/me");
  return data;
}

/** Privacy wipe (PLAN 7.5): deletes everything the current user stored —
 * résumés, applications, history, alerts, usage, feedback, kits. The invite
 * code keeps working. Returns per-table deleted-row counts. */
export async function deleteMyData(): Promise<Record<string, number>> {
  const { data } = await api.delete<Record<string, number>>("/profile/data");
  clearDataCache();
  return data;
}

/** Close the account (PLAN 23.5): the same wipe, and then the access code
 * stops resolving — every later request 401s into the AccessGate.
 *
 * Clears BOTH caches, and that is not belt-and-braces: `clearDataCache` only
 * empties the `dataCache` Map, while `useMasterResume` keeps the master in a
 * plain module-level binding that nothing else can reach — which is exactly
 * why `resetMasterCache` exists. Skipping it leaves nine pages still painting
 * the résumé of an account that no longer exists.
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

export async function resumeHealth(resume: ResumeModel): Promise<ResumeHealthResult> {
  const { data } = await api.post<ResumeHealthResult>("/tools/resume-health", { resume });
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

/** Restore points for the master résumé (PLAN 20.8/N1) — metadata only; the
 * full résumé comes from `getResumeVersion`. Not cached: after a save the list
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
