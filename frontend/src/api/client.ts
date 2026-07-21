import axios from "axios";
import type {
  AlertRunResult,
  AlertSettings,
  ApplicationDetail,
  ApplicationOut,
  ATSScanResult,
  CompanyBriefResult,
  FactsLedger,
  FeedbackOut,
  FollowUpResult,
  FreeScanResult,
  InterviewAnswerResult,
  InterviewFeedbackResult,
  InterviewQuestionsResult,
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
  OutreachResult,
  RecruiterScreenResult,
  ResumeHealthResult,
  ResumeModel,
  ResumeUploadResponse,
  ScreeningAnswerResult,
  SearchContext,
  StaleApplication,
  TailorResult,
} from "../types";

// In dev, requests go through the Vite proxy at /api -> http://localhost:8000.
// In production (Vercel), set VITE_API_BASE_URL to the deployed backend URL
// (e.g. https://jobfinder-api.onrender.com) so the frontend calls it directly.
const api = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL || "/api" });

// Deployed instances are gated by an access code (backend APP_ACCESS_CODE).
// The code is remembered per device; a 401 pops the AccessGate overlay.
export const ACCESS_CODE_KEY = "jobfinder.accessCode";
export const UNAUTHORIZED_EVENT = "jobfinder:unauthorized";

api.interceptors.request.use((config) => {
  const code = localStorage.getItem(ACCESS_CODE_KEY);
  if (code) config.headers["X-App-Key"] = code;
  return config;
});

api.interceptors.response.use(undefined, (error) => {
  if (error?.response?.status === 401) {
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

/** Visual templates the backend renderers support (see app/render/templates.py). */
export const RESUME_TEMPLATES = ["classic", "modern", "compact"] as const;
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
  a.click();
  URL.revokeObjectURL(url);
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
): Promise<JobSearchResult> {
  const code = localStorage.getItem(ACCESS_CODE_KEY);
  const resp = await fetch(`${api.defaults.baseURL}/jobs/search/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(code ? { "X-App-Key": code } : {}) },
    body: JSON.stringify({ resume, customize: customize ?? null }),
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
  return data;
}

export async function getJobAlert(): Promise<AlertSettings> {
  const { data } = await api.get<AlertSettings>("/jobs/alerts");
  return data;
}

export async function updateJobAlert(payload: {
  enabled: boolean;
  email: string;
  context?: SearchContext | null;
  nudge_emails?: boolean;
}): Promise<AlertSettings> {
  const { data } = await api.put<AlertSettings>("/jobs/alerts", payload);
  return data;
}

export async function runJobAlert(): Promise<AlertRunResult> {
  const { data } = await api.post<AlertRunResult>("/jobs/alerts/run");
  return data;
}

export async function getJobHistory(): Promise<JobSearchHistory> {
  const { data } = await api.get<JobSearchHistory>("/jobs/history");
  return data;
}

export async function deleteJobHistoryItem(id: number): Promise<void> {
  await api.delete(`/jobs/history/${id}`);
}

export async function clearJobHistory(): Promise<void> {
  await api.delete("/jobs/history");
}

/** Free public CV-vs-JD scan — no access code, nothing stored server-side. */
export async function freeScan(file: File, jdText: string): Promise<FreeScanResult> {
  const form = new FormData();
  form.append("file", file);
  form.append("jd_text", jdText);
  const { data } = await api.post<FreeScanResult>("/public/scan", form);
  return data;
}

export async function atsScan(resume: ResumeModel, jdText = ""): Promise<ATSScanResult> {
  const { data } = await api.post<ATSScanResult>("/tools/ats-scan", { resume, jd_text: jdText });
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

/** Privacy wipe (PLAN 7.5): deletes everything the current user stored —
 * résumés, applications, history, alerts, usage, feedback, kits. The invite
 * code keeps working. Returns per-table deleted-row counts. */
export async function deleteMyData(): Promise<Record<string, number>> {
  const { data } = await api.delete<Record<string, number>>("/profile/data");
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
  const { data } = await api.get<MasterResume | null>("/profile/resume", {
    params: lang ? { lang } : undefined,
  });
  return data ?? null;
}

/** Every saved master (at most one per language), newest first. */
export async function listMasterResumes(): Promise<MasterResume[]> {
  const { data } = await api.get<{ resumes: MasterResume[] }>("/profile/resumes");
  return data.resumes ?? [];
}

export async function saveMasterResume(payload: {
  resume: ResumeModel;
  ledger?: FactsLedger | null;
  label?: string;
}): Promise<MasterResume> {
  const { data } = await api.put<MasterResume>("/profile/resume", payload);
  return data;
}

export async function listApplications(): Promise<ApplicationOut[]> {
  const { data } = await api.get<ApplicationOut[]>("/applications");
  return data;
}

export async function getStaleApplications(): Promise<StaleApplication[]> {
  const { data } = await api.get<{ items: StaleApplication[] }>("/applications/nudges");
  return data.items;
}

export async function getApplication(id: number): Promise<ApplicationDetail> {
  const { data } = await api.get<ApplicationDetail>(`/applications/${id}`);
  return data;
}

export async function saveApplication(payload: {
  job_title: string;
  company: string;
  jd_text: string;
  tailored_resume: ResumeModel;
  cover_letter: string;
  overall_score: number;
  job_url?: string;
  status?: string;
}): Promise<ApplicationOut> {
  const { data } = await api.post<ApplicationOut>("/applications", payload);
  return data;
}

export async function updateApplication(
  id: number,
  patch: { status?: string; notes?: string; interviewed?: boolean; excitement?: number },
): Promise<ApplicationOut> {
  const { data } = await api.patch<ApplicationOut>(`/applications/${id}`, patch);
  return data;
}

export async function deleteApplication(id: number): Promise<void> {
  await api.delete(`/applications/${id}`);
}
