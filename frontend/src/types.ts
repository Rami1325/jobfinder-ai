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

// Israeli-résumé sections (optional: older saved résumés predate them).
export interface MilitaryService {
  unit: string;
  role: string;
  rank: string;
  start_date: string;
  end_date: string;
  bullets: string[];
}

export interface LanguageSkill {
  language: string;
  level: string;
}

export interface ResumeModel {
  contact: Contact;
  summary: string;
  skills: string[];
  experience: Experience[];
  education: Education[];
  projects: Project[];
  certifications: string[];
  military_service?: MilitaryService[];
  languages?: LanguageSkill[];
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
  military?: string[];
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
  job_url: string;
  interviewed: boolean;
  excitement: number; // 0 = unrated, 1-5 stars
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
  job_url: string;
  interviewed: boolean;
  excitement: number;
  created_at: string;
}

// Interview prep
export interface InterviewQuestion {
  question: string;
  category: string;
  rationale: string;
}
export interface InterviewQuestionsResult {
  questions: InterviewQuestion[];
}
export interface InterviewAnswerResult {
  answer: string;
  tips: string[];
}
export interface InterviewFeedbackResult {
  score: number;
  strengths: string[];
  improvements: string[];
  revised_answer: string;
}

// Job match
export interface JobMatch {
  title: string;
  company: string;
  overall: number;
  keyword_coverage: number;
  fit_score: number;
  top_gaps: string[];
  jd_text: string;
  url: string; // set for scraped listings; empty for pasted ones
  location: string;
  posted_at: string; // ISO date from the LinkedIn search card; empty when unknown
  source?: string; // provider id ("linkedin", "drushim", …); absent on older backends
}
export interface JobMatchResult {
  matches: JobMatch[];
}
export interface SearchContext {
  job_title: string;
  location: string;
  work_mode: string; // any | onsite | remote | hybrid
  limit: number;
  sources?: string[]; // provider ids to search ("linkedin", "drushim", …); absent on older backends
}
export interface JobSearchResult {
  context: SearchContext;
  matches: JobMatch[];
  skipped: number;
  source_errors?: Record<string, string>; // provider id → error when a source failed; absent on older backends
}
export interface JobSearchHit {
  id: number;
  title: string;
  company: string;
  location: string;
  url: string;
  overall: number;
  keyword_coverage: number;
  fit_score: number;
  top_gaps: string[];
  jd_text: string;
  posted_at: string; // ISO date the job was posted; empty when unknown
  source?: string; // provider id ("linkedin", "drushim", …); absent on older backends
  searched_at: string;
  app_status: string; // tracker status if saved/applied: "", saved, applied, interview, offer, rejected
}
export interface JobSearchHistory {
  hits: JobSearchHit[];
}

// Tools
export interface ATSIssue {
  label: string;
  severity: "good" | "warn" | "bad";
  detail: string;
}
export interface ATSScanResult {
  score: number;
  keyword_coverage: number;
  issues: ATSIssue[];
  gaps: GapItem[];
}
export interface LinkedInResult {
  headline: string;
  about: string;
  experience_bullets: string[];
  skills: string[];
}
export interface FollowUpResult {
  subject: string;
  body: string;
}
