import axios from "axios";
import type {
  ApplicationDetail,
  ApplicationOut,
  FactsLedger,
  JDModel,
  MasterResume,
  ResumeModel,
  ResumeUploadResponse,
  TailorResult,
} from "../types";

// In dev, requests go through the Vite proxy at /api -> http://localhost:8000.
// In production (Vercel), set VITE_API_BASE_URL to the deployed backend URL
// (e.g. https://jobfinder-api.onrender.com) so the frontend calls it directly.
const api = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL || "/api" });

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

export async function downloadResume(resume: ResumeModel, fmt: "docx" | "pdf"): Promise<void> {
  const resp = await api.post("/render", { resume, fmt }, { responseType: "blob" });
  const url = URL.createObjectURL(resp.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `resume.${fmt}`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function getMasterResume(): Promise<MasterResume | null> {
  const { data } = await api.get<MasterResume | null>("/profile/resume");
  return data ?? null;
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
}): Promise<ApplicationOut> {
  const { data } = await api.post<ApplicationOut>("/applications", payload);
  return data;
}

export async function updateApplication(
  id: number,
  patch: { status?: string; notes?: string },
): Promise<ApplicationOut> {
  const { data } = await api.patch<ApplicationOut>(`/applications/${id}`, patch);
  return data;
}

export async function deleteApplication(id: number): Promise<void> {
  await api.delete(`/applications/${id}`);
}
