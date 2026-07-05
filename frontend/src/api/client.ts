import axios from "axios";
import type {
  AlertRunResult,
  AlertSettings,
  ApplicationDetail,
  ApplicationOut,
  ATSScanResult,
  FactsLedger,
  FeedbackOut,
  FollowUpResult,
  FreeScanResult,
  InterviewAnswerResult,
  InterviewFeedbackResult,
  InterviewQuestionsResult,
  JDModel,
  JobMatchResult,
  JobSearchHistory,
  JobSearchResult,
  LinkedInResult,
  MasterResume,
  ResumeModel,
  ResumeUploadResponse,
  SearchContext,
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

export async function searchContext(resume: ResumeModel): Promise<SearchContext> {
  const { data } = await api.post<SearchContext>("/jobs/search-context", { resume });
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

export async function followUp(payload: {
  company: string;
  role: string;
  stage: string;
  context: string;
}): Promise<FollowUpResult> {
  const { data } = await api.post<FollowUpResult>("/tools/follow-up", payload);
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
