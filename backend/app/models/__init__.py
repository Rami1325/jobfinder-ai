"""Pydantic schemas shared across the app."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


# --------------------------------------------------------------------------- #
# Resume
# --------------------------------------------------------------------------- #
class Contact(BaseModel):
    name: str = ""
    email: str = ""
    phone: str = ""
    location: str = ""
    linkedin: str = ""
    website: str = ""


class Experience(BaseModel):
    company: str = ""
    title: str = ""
    location: str = ""
    start_date: str = ""
    end_date: str = ""
    bullets: list[str] = Field(default_factory=list)


class Education(BaseModel):
    institution: str = ""
    degree: str = ""
    field: str = ""
    start_date: str = ""
    end_date: str = ""
    details: str = ""


class Project(BaseModel):
    name: str = ""
    description: str = ""
    bullets: list[str] = Field(default_factory=list)


class ResumeModel(BaseModel):
    contact: Contact = Field(default_factory=Contact)
    summary: str = ""
    skills: list[str] = Field(default_factory=list)
    experience: list[Experience] = Field(default_factory=list)
    education: list[Education] = Field(default_factory=list)
    projects: list[Project] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Job description
# --------------------------------------------------------------------------- #
class JDModel(BaseModel):
    job_title: str = ""
    company: str = ""
    seniority: str = ""
    # "he" | "en" — set deterministically by jd_analyzer (regex on the Hebrew
    # Unicode block, never the LLM). Defaults "en" for back-compat.
    language: str = "en"
    hard_skills: list[str] = Field(default_factory=list)
    soft_skills: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    responsibilities: list[str] = Field(default_factory=list)
    qualifications: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Facts ledger (anti-fabrication)
# --------------------------------------------------------------------------- #
class FactsLedger(BaseModel):
    employers: list[str] = Field(default_factory=list)
    titles: list[str] = Field(default_factory=list)
    dates: list[str] = Field(default_factory=list)
    institutions: list[str] = Field(default_factory=list)
    degrees: list[str] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)
    numbers: list[str] = Field(default_factory=list)


class FabricationFlag(BaseModel):
    category: str  # employer | title | date | credential | number
    value: str
    detail: str = ""


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #
class GapItem(BaseModel):
    keyword: str
    status: str  # covered | partial | missing
    suggestion: str = ""


class Score(BaseModel):
    keyword_coverage: float = 0.0  # 0-100
    fit_score: float = 0.0  # 0-100 (LLM holistic)
    overall: float = 0.0  # 0-100 combined
    rationale: str = ""
    gaps: list[GapItem] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Tailoring
# --------------------------------------------------------------------------- #
class ChangeLogEntry(BaseModel):
    section: str
    change: str
    reason: str = ""


class TailorResult(BaseModel):
    tailored_resume: ResumeModel
    changelog: list[ChangeLogEntry] = Field(default_factory=list)
    covered_keywords: list[str] = Field(default_factory=list)
    fabrication_flags: list[FabricationFlag] = Field(default_factory=list)
    score_before: Score = Field(default_factory=Score)
    score_after: Score = Field(default_factory=Score)


# --------------------------------------------------------------------------- #
# API request/response bodies
# --------------------------------------------------------------------------- #
class JDAnalyzeRequest(BaseModel):
    jd_text: str


class TailorRequest(BaseModel):
    resume: ResumeModel
    jd: JDModel


class CoverLetterRequest(BaseModel):
    resume: ResumeModel
    jd: JDModel
    tone: str = "professional"


class CoverLetterResponse(BaseModel):
    cover_letter: str


class RenderRequest(BaseModel):
    resume: ResumeModel
    fmt: str = "docx"  # docx | pdf


class ResumeUploadResponse(BaseModel):
    resume: ResumeModel
    ledger: FactsLedger


# --------------------------------------------------------------------------- #
# Master résumé (persisted, reused across features)
# --------------------------------------------------------------------------- #
class MasterResumeIn(BaseModel):
    resume: ResumeModel
    ledger: Optional[FactsLedger] = None
    label: str = "My résumé"


class MasterResumeOut(BaseModel):
    resume: ResumeModel
    ledger: Optional[FactsLedger] = None
    label: str = "My résumé"
    updated_at: str = ""


# --------------------------------------------------------------------------- #
# Application tracker
# --------------------------------------------------------------------------- #
class ApplicationCreate(BaseModel):
    job_title: str = ""
    company: str = ""
    jd_text: str = ""
    tailored_resume: Optional[ResumeModel] = None
    cover_letter: str = ""
    overall_score: float = 0.0
    status: str = "saved"  # saved | applied | interview | offer | rejected
    job_url: str = ""


class ApplicationUpdate(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None
    interviewed: Optional[bool] = None


class ApplicationOut(BaseModel):
    id: int
    job_title: str
    company: str
    overall_score: float
    status: str
    notes: str = ""
    job_url: str = ""
    interviewed: bool = False
    created_at: str


class ApplicationDetail(BaseModel):
    id: int
    job_title: str
    company: str
    jd_text: str = ""
    tailored_resume: Optional[ResumeModel] = None
    cover_letter: str = ""
    overall_score: float
    status: str
    notes: str = ""
    job_url: str = ""
    interviewed: bool = False
    created_at: str


# --------------------------------------------------------------------------- #
# Interview prep
# --------------------------------------------------------------------------- #
class InterviewQuestion(BaseModel):
    question: str
    category: str = ""  # behavioral | technical | role-specific | culture
    rationale: str = ""


class InterviewQuestionsRequest(BaseModel):
    resume: ResumeModel
    jd: JDModel


class InterviewQuestionsResult(BaseModel):
    questions: list[InterviewQuestion] = Field(default_factory=list)


class InterviewAnswerRequest(BaseModel):
    resume: ResumeModel
    jd: JDModel
    question: str


class InterviewAnswerResult(BaseModel):
    answer: str = ""
    tips: list[str] = Field(default_factory=list)


class InterviewFeedbackRequest(BaseModel):
    resume: ResumeModel
    question: str
    answer: str


class InterviewFeedbackResult(BaseModel):
    score: float = 0.0
    strengths: list[str] = Field(default_factory=list)
    improvements: list[str] = Field(default_factory=list)
    revised_answer: str = ""


# --------------------------------------------------------------------------- #
# Job discovery / matching
# --------------------------------------------------------------------------- #
class JobMatchRequest(BaseModel):
    resume: ResumeModel
    listings: list[str] = Field(default_factory=list)  # pasted JD texts


class JobMatch(BaseModel):
    title: str = ""
    company: str = ""
    overall: float = 0.0
    keyword_coverage: float = 0.0
    fit_score: float = 0.0
    top_gaps: list[str] = Field(default_factory=list)
    jd_text: str = ""
    url: str = ""  # set for scraped listings; empty for pasted ones
    location: str = ""
    posted_at: str = ""  # ISO date(-time) from the source; empty when unknown
    source: str = "linkedin"  # which job board this came from (see PROVIDERS registry)


class JobMatchResult(BaseModel):
    matches: list[JobMatch] = Field(default_factory=list)


class SearchContext(BaseModel):
    """What/where to search. Blank fields mean 'derive from résumé'."""

    job_title: str = ""
    location: str = ""
    work_mode: str = "any"  # any | onsite | remote | hybrid (LinkedIn-only filter)
    limit: int = 10  # jobs to fetch + score (1-25), shared across all sources
    # Which job boards to search. Validated against the provider registry in
    # job_search._resolve_context: unknown names are ignored, and an empty /
    # all-unknown list falls back to every registered provider — so old clients
    # that never send `sources` keep working, and new boards join automatically.
    sources: list[str] = Field(default_factory=list)


class SearchContextRequest(BaseModel):
    resume: ResumeModel


class JobSearchRequest(BaseModel):
    resume: ResumeModel
    customize: Optional[SearchContext] = None  # None => fully automatic


class JobSearchResult(BaseModel):
    context: SearchContext = Field(default_factory=SearchContext)  # what was actually searched
    matches: list[JobMatch] = Field(default_factory=list)
    skipped: int = 0  # listings found but not fetchable/scorable
    # Provider name -> user-facing error for boards that failed while others
    # succeeded (e.g. {"drushim": "Couldn't reach Drushim's job search..."}).
    # Empty when every selected source worked. If ALL sources fail the search
    # raises instead, so a 200 always carries at least one match.
    source_errors: dict[str, str] = Field(default_factory=dict)


class JobSearchHitOut(BaseModel):
    """A persisted job-search history row (see app.db.models.JobSearchHit)."""

    id: int
    title: str = ""
    company: str = ""
    location: str = ""
    url: str = ""
    overall: float = 0.0
    keyword_coverage: float = 0.0
    fit_score: float = 0.0
    top_gaps: list[str] = Field(default_factory=list)
    jd_text: str = ""
    posted_at: str = ""  # ISO date the job was posted; empty when unknown
    source: str = "linkedin"  # which job board surfaced this hit
    searched_at: str = ""
    app_status: str = ""  # tracker status if this job was saved/applied ("", saved, applied, interview, offer, rejected)


class JobSearchHistory(BaseModel):
    hits: list[JobSearchHitOut] = Field(default_factory=list)


class JobFetchRequest(BaseModel):
    url: str


class ComeetCompanyOut(BaseModel):
    """One company in the Comeet registry (token deliberately not exposed)."""

    slug: str
    name: str = ""
    careers_url: str = ""


class ComeetCompanyList(BaseModel):
    companies: list[ComeetCompanyOut] = Field(default_factory=list)


class AddComeetCompanyRequest(BaseModel):
    url: str  # a public Comeet careers-page URL: https://www.comeet.com/jobs/<company>/<code>


class JobFetchResponse(BaseModel):
    text: str = ""


# --------------------------------------------------------------------------- #
# Standalone tools
# --------------------------------------------------------------------------- #
class ATSScanRequest(BaseModel):
    resume: ResumeModel
    jd_text: str = ""


class ATSIssue(BaseModel):
    label: str
    severity: str = "good"  # good | warn | bad
    detail: str = ""


class ATSScanResult(BaseModel):
    score: float = 0.0
    keyword_coverage: float = 0.0
    issues: list[ATSIssue] = Field(default_factory=list)
    gaps: list[GapItem] = Field(default_factory=list)


class LinkedInRequest(BaseModel):
    resume: ResumeModel


class LinkedInResult(BaseModel):
    headline: str = ""
    about: str = ""
    experience_bullets: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)


class FollowUpRequest(BaseModel):
    company: str = ""
    role: str = ""
    stage: str = "after applying"
    context: str = ""


class FollowUpResult(BaseModel):
    subject: str = ""
    body: str = ""
