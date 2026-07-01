export interface Contact {
  name: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  website: string;
}

export interface Experience {
  company: string;
  title: string;
  location: string;
  start_date: string;
  end_date: string;
  bullets: string[];
}

export interface Education {
  institution: string;
  degree: string;
  field: string;
  start_date: string;
  end_date: string;
  details: string;
}

export interface Project {
  name: string;
  description: string;
  bullets: string[];
}

export interface ResumeModel {
  contact: Contact;
  summary: string;
  skills: string[];
  experience: Experience[];
  education: Education[];
  projects: Project[];
  certifications: string[];
}

export interface JDModel {
  job_title: string;
  company: string;
  seniority: string;
  hard_skills: string[];
  soft_skills: string[];
  keywords: string[];
  responsibilities: string[];
  qualifications: string[];
}

export interface FactsLedger {
  employers: string[];
  titles: string[];
  dates: string[];
  institutions: string[];
  degrees: string[];
  certifications: string[];
  numbers: string[];
}

export interface GapItem {
  keyword: string;
  status: "covered" | "partial" | "missing";
  suggestion: string;
}

export interface Score {
  keyword_coverage: number;
  fit_score: number;
  overall: number;
  rationale: string;
  gaps: GapItem[];
}

export interface ChangeLogEntry {
  section: string;
  change: string;
  reason: string;
}

export interface FabricationFlag {
  category: string;
  value: string;
  detail: string;
}

export interface TailorResult {
  tailored_resume: ResumeModel;
  changelog: ChangeLogEntry[];
  covered_keywords: string[];
  fabrication_flags: FabricationFlag[];
  score_before: Score;
  score_after: Score;
}

export interface ResumeUploadResponse {
  resume: ResumeModel;
  ledger: FactsLedger;
}

export interface MasterResume {
  resume: ResumeModel;
  ledger: FactsLedger | null;
  label: string;
  updated_at: string;
}

export interface ApplicationOut {
  id: number;
  job_title: string;
  company: string;
  overall_score: number;
  status: string;
  notes: string;
  created_at: string;
}

export interface ApplicationDetail {
  id: number;
  job_title: string;
  company: string;
  jd_text: string;
  tailored_resume: ResumeModel | null;
  cover_letter: string;
  overall_score: number;
  status: string;
  notes: string;
  created_at: string;
}
