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


class MilitaryService(BaseModel):
    """IDF/military service entry — standard on Israeli résumés.

    unit/role/rank/dates are protected facts: the ledger records them and the
    fabrication guard flags any tailored value not present in the original.
    """

    unit: str = ""
    role: str = ""
    rank: str = ""
    start_date: str = ""
    end_date: str = ""
    bullets: list[str] = Field(default_factory=list)


class LanguageSkill(BaseModel):
    language: str = ""
    level: str = ""  # e.g. native / fluent / professional / basic — as written


class ResumeModel(BaseModel):
    contact: Contact = Field(default_factory=Contact)
    summary: str = ""
    skills: list[str] = Field(default_factory=list)
    experience: list[Experience] = Field(default_factory=list)
    education: list[Education] = Field(default_factory=list)
    projects: list[Project] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)
    military_service: list[MilitaryService] = Field(default_factory=list)
    languages: list[LanguageSkill] = Field(default_factory=list)


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
    # Military unit / role / rank strings (dates go into `dates`). Protected:
    # invented military claims are a serious credibility problem in Israel.
    military: list[str] = Field(default_factory=list)


class FabricationFlag(BaseModel):
    category: str  # employer | title | date | institution | degree | credential | number | military
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
    # Visual template (see app/render/templates.py). Unknown names fall back
    # to the default, so old clients keep today's output.
    template: str = "classic"  # classic | modern | compact


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
    language: str = "en"  # detected server-side from the résumé text ("en" | "he")
    updated_at: str = ""


class MasterResumeList(BaseModel):
    """All saved masters (at most one per language), most recently updated first."""

    resumes: list[MasterResumeOut] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Job alerts
# --------------------------------------------------------------------------- #
class AlertSettingsIn(BaseModel):
    enabled: bool = False
    email: str = ""
    context: Optional["SearchContext"] = None  # None = derive from the résumé
    nudge_emails: bool = False  # PLAN 11.4: email follow-up reminders too


class AlertSettingsOut(BaseModel):
    enabled: bool = False
    email: str = ""
    context: Optional["SearchContext"] = None
    last_run_at: str = ""
    last_new_count: int = 0
    last_error: str = ""
    smtp_configured: bool = False  # False => runs won't email; UI explains
    nudge_emails: bool = False


class AlertRunResult(BaseModel):
    ran: bool = False
    total: int = 0  # jobs the search returned
    new_count: int = 0  # of those, never seen in history before
    emailed: bool = False
    error: str = ""


class AlertCronResult(BaseModel):
    """One cron tick across all users (PLAN 7.3)."""

    users: int = 0  # enabled alerts found
    results: list[AlertRunResult] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Batch auto-tailor kits (PLAN 8.1): high-fit search results → queued tailor
# runs → reviewable application kits (PLAN 8.2 consumes KitDetail).
# --------------------------------------------------------------------------- #
class KitJobIn(BaseModel):
    """One high-fit job the client selected for batch tailoring — the shape
    mirrors JobMatch, carried by the client because that's where the fresh
    search results (incl. full jd_text) live."""

    title: str = ""
    company: str = ""
    location: str = ""
    url: str = ""
    source: str = "linkedin"
    logo_url: str = ""
    posted_at: str = ""
    jd_text: str = ""
    overall: float = 0.0  # the search's fit score — why this job qualified


class KitBatchRequest(BaseModel):
    jobs: list[KitJobIn] = Field(default_factory=list)


class KitOut(BaseModel):
    id: int
    status: str = "queued"  # queued | running | done | failed | approved | rejected | submitted
    job_title: str = ""
    company: str = ""
    location: str = ""
    url: str = ""
    source: str = "linkedin"
    logo_url: str = ""
    posted_at: str = ""
    search_overall: float = 0.0
    # Tailor outcome (meaningful only once processed):
    score_before: float = 0.0  # overall before tailoring
    score_after: float = 0.0
    flag_count: int = 0  # fabrication flags; > 0 => never auto-approvable
    base_language: str = ""  # which master résumé slot was tailored ("en"|"he")
    error: str = ""
    # Review outcome (PLAN 8.2):
    reject_reason: str = ""
    application_id: Optional[int] = None  # tracker row created on approve
    # Auto-submit outcome (PLAN 8.4):
    submit_note: str = ""  # the company's follow-up questionnaire URL, if any
    submitted_at: str = ""
    created_at: str = ""
    processed_at: str = ""


class KitDetail(KitOut):
    """Full kit for the 8.2 review UI: the raw JD text (match-report keyword
    counting), the analyzed JD, the master résumé the tailor ran on (the diff
    baseline), and the complete TailorResult."""

    jd_text: str = ""
    jd: Optional[JDModel] = None
    base_resume: Optional[ResumeModel] = None
    result: Optional[TailorResult] = None


class KitList(BaseModel):
    kits: list[KitOut] = Field(default_factory=list)


class KitBatchResult(BaseModel):
    queued: list[KitOut] = Field(default_factory=list)  # created + requeued this call
    skipped_existing: int = 0  # already queued/running/done for the same URL


class KitProcessResult(BaseModel):
    kit: Optional[KitOut] = None  # None => queue was empty
    remaining: int = 0  # kits still queued after this one


class KitApproveRequest(BaseModel):
    """Approve a reviewed kit (PLAN 8.2) into the tracker as ready-to-send.

    `resume` is the effective résumé after the reviewer's per-bullet
    accept/reject decisions (client-computed, same as the Tailor page's diff);
    omitted => the kit's full tailored résumé. `cover_letter` is whatever the
    reviewer generated/edited; optional."""

    resume: Optional[ResumeModel] = None
    cover_letter: str = ""


class KitRejectRequest(BaseModel):
    reason: str = ""  # why the kit wasn't good enough — feeds threshold tuning


# --------------------------------------------------------------------------- #
# Friends beta (PLAN 7): users, feedback, delete-my-data
# --------------------------------------------------------------------------- #
class UserCreate(BaseModel):
    name: str
    email: str = ""


class UserUpdate(BaseModel):
    is_active: Optional[bool] = None
    name: Optional[str] = None
    email: Optional[str] = None


class UserOut(BaseModel):
    id: int
    name: str = ""
    email: str = ""
    invite_code: str = ""  # admin-only responses; this is what a friend types in
    is_admin: bool = False
    is_active: bool = True
    created_at: str = ""


class UserList(BaseModel):
    users: list[UserOut] = Field(default_factory=list)


class FeedbackIn(BaseModel):
    page: str = ""
    text: str


class FeedbackOut(BaseModel):
    id: int
    user_name: str = ""
    page: str = ""
    text: str = ""
    created_at: str = ""


class FeedbackList(BaseModel):
    feedback: list[FeedbackOut] = Field(default_factory=list)


class DeleteMyDataResult(BaseModel):
    """Row counts wiped by DELETE /profile/data (PLAN 7.5)."""

    resumes: int = 0
    applications: int = 0
    history: int = 0
    alerts: int = 0
    usage: int = 0
    feedback: int = 0
    kits: int = 0


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
    excitement: Optional[int] = Field(default=None, ge=0, le=5)  # 0 clears the rating


class ApplicationOut(BaseModel):
    id: int
    job_title: str
    company: str
    overall_score: float
    status: str
    notes: str = ""
    job_url: str = ""
    interviewed: bool = False
    excitement: int = 0  # 0 = unrated, 1-5 stars
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
    excitement: int = 0
    created_at: str


class StaleApplication(BaseModel):
    """An 'applied' application with no status change for a while — a nudge to
    follow up (GET /applications/nudges)."""

    id: int
    job_title: str = ""
    company: str = ""
    status: str = ""
    days_stale: int = 0
    job_url: str = ""


class StaleApplicationList(BaseModel):
    items: list[StaleApplication] = Field(default_factory=list)


class NudgeRunResult(BaseModel):
    """One user's stale-nudge tick (PLAN 11.4)."""

    ran: bool = False
    stale: int = 0  # applications currently past the staleness cutoff
    new_stale: int = 0  # of those, newly crossed since the last nudge email
    emailed: bool = False
    error: str = ""


class NudgeCronResult(BaseModel):
    """One nudge cron tick across all opted-in users (PLAN 11.4)."""

    users: int = 0
    results: list[NudgeRunResult] = Field(default_factory=list)


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


# Multi-turn mock interview (PLAN 11.3). Stateless backend: the client store
# holds the session and sends the whole transcript with every turn.
class ChatTurn(BaseModel):
    role: str = "interviewer"  # "interviewer" | "candidate"
    text: str = ""


class InterviewChatRequest(BaseModel):
    resume: ResumeModel
    jd_text: str = ""
    transcript: list[ChatTurn] = Field(default_factory=list)


class InterviewChatResult(BaseModel):
    message: str = ""  # the interviewer's next message
    done: bool = False  # the interviewer has covered its arc — offer the scorecard


class QuestionFeedback(BaseModel):
    question: str = ""
    feedback: str = ""


class InterviewScorecardResult(BaseModel):
    overall: float = 0.0
    summary: str = ""
    strengths: list[str] = Field(default_factory=list)
    improvements: list[str] = Field(default_factory=list)
    question_feedback: list[QuestionFeedback] = Field(default_factory=list)


# Recruiter phone-screen prep — the first ~15-min, mostly non-technical call.
class RecruiterScreenRequest(BaseModel):
    resume: ResumeModel
    jd_text: str = ""


class RecruiterPrepItem(BaseModel):
    question: str = ""
    talking_point: str = ""  # grounded direction, not a full script


class RecruiterScreenResult(BaseModel):
    pitch: str = ""  # "walk me through your background" opener
    items: list[RecruiterPrepItem] = Field(default_factory=list)
    salary_note: str = ""  # range-framing guidance, never a fabricated number


# --------------------------------------------------------------------------- #
# Job discovery / matching
# --------------------------------------------------------------------------- #
class JobMatchRequest(BaseModel):
    resume: ResumeModel
    listings: list[str] = Field(default_factory=list)  # pasted JD texts


class AlsoOn(BaseModel):
    """The same posting on another board (PLAN 15.1 cross-board dedupe)."""

    source: str = ""
    url: str = ""


class SalaryInfo(BaseModel):
    """A salary figure LITERALLY present in the posting text (PLAN 15.2).
    Deterministic extraction only — never an LLM estimate. `raw` is the
    verbatim snippet the UI shows."""

    min: float = 0.0
    max: float = 0.0
    currency: str = ""  # ILS | USD | EUR | ""
    period: str = ""  # hour | month | year | "" (not stated)
    raw: str = ""


class JobMatch(BaseModel):
    title: str = ""
    company: str = ""
    overall: float = 0.0
    keyword_coverage: float = 0.0
    fit_score: float = 0.0
    top_matched: list[str] = Field(default_factory=list)  # strongest covered JD keywords
    top_gaps: list[str] = Field(default_factory=list)
    jd_text: str = ""
    url: str = ""  # set for scraped listings; empty for pasted ones
    location: str = ""
    posted_at: str = ""  # ISO date(-time) from the source; empty when unknown
    source: str = "linkedin"  # which job board this came from (see PROVIDERS registry)
    logo_url: str = ""  # company logo from the board; empty when it has none
    also_on: list[AlsoOn] = Field(default_factory=list)  # this posting on other boards
    salary: Optional[SalaryInfo] = None  # only when literally stated in the posting
    # Posted before the search's max_age_days window but kept because the title
    # matches the searched keywords (PLAN 15.6). The UI shows an "Older" badge.
    stale: bool = False


class JobMatchResult(BaseModel):
    matches: list[JobMatch] = Field(default_factory=list)


class SearchContext(BaseModel):
    """What/where to search. Blank fields mean 'derive from résumé'."""

    job_title: str = ""
    # Extra search keywords: when non-empty this is the canonical list of
    # titles/keywords (each queried separately per board, results merged) and
    # job_title mirrors the first entry so old clients keep working.
    job_titles: list[str] = Field(default_factory=list)
    location: str = ""
    work_mode: str = "any"  # any | onsite | remote | hybrid (LinkedIn-only filter)
    limit: int = 10  # jobs to fetch + score (1-25), shared across all sources
    # Which job boards to search. Validated against the provider registry in
    # job_search._resolve_context: unknown names are ignored, and an empty /
    # all-unknown list falls back to every registered provider — so old clients
    # that never send `sources` keep working, and new boards join automatically.
    sources: list[str] = Field(default_factory=list)
    # Only surface postings at most this many days old (0 = any age). LinkedIn
    # applies it server-side (f_TPR); every board is also filtered in the
    # fan-out against JobHit.posted_at, keeping hits with no known date.
    max_age_days: int = 30
    # Worldwide-remote opt-in: when work_mode is "remote" or "any", ALSO search
    # remote roles in high-earning markets (US/UK/EU — see
    # job_search.WORLDWIDE_REMOTE_LOCATIONS) on the boards with global reach
    # (LinkedIn). Worldwide queries are always remote-only (with "any" the local
    # location keeps "any"). Local Israeli boards are never queried with those
    # locations, and the flag is inert for "onsite"/"hybrid".
    include_worldwide: bool = False


class SearchPrefs(BaseModel):
    """The user's saved 'Customize search' picks (GET/PUT /jobs/search-prefs) —
    prefill for the Jobs page so a returning user doesn't re-enter everything.
    context=None means nothing saved (or cleared)."""

    context: Optional[SearchContext] = None


class SearchContextRequest(BaseModel):
    resume: ResumeModel


class JobSearchRequest(BaseModel):
    resume: ResumeModel
    customize: Optional[SearchContext] = None  # None => fully automatic


class JobSearchResult(BaseModel):
    context: SearchContext = Field(default_factory=SearchContext)  # what was actually searched
    matches: list[JobMatch] = Field(default_factory=list)
    skipped: int = 0  # listings found but not fetchable/scorable
    # Provider name -> user-facing error for boards that FAILED (blocked,
    # unreachable, misconfigured) while others succeeded. Boards that answered
    # fine but had zero matching jobs land in `source_empty` instead — the UI
    # must not present an empty query as an outage. If ALL sources fail the
    # search raises instead, so a 200 always carries at least one match.
    source_errors: dict[str, str] = Field(default_factory=dict)
    source_empty: dict[str, str] = Field(default_factory=dict)


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
    top_matched: list[str] = Field(default_factory=list)  # strongest covered JD keywords
    top_gaps: list[str] = Field(default_factory=list)
    jd_text: str = ""
    posted_at: str = ""  # ISO date the job was posted; empty when unknown
    source: str = "linkedin"  # which job board surfaced this hit
    logo_url: str = ""  # company logo from the board; empty when it has none
    also_on: list[AlsoOn] = Field(default_factory=list)  # this posting on other boards
    salary: Optional[SalaryInfo] = None  # extracted on read from the stored jd_text
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


class GreenhouseCompanyOut(BaseModel):
    """One company in the Greenhouse registry (PLAN 9.3)."""

    slug: str
    name: str = ""
    board_url: str = ""


class GreenhouseCompanyList(BaseModel):
    companies: list[GreenhouseCompanyOut] = Field(default_factory=list)


class AddGreenhouseCompanyRequest(BaseModel):
    board: str  # a board slug ("wizinc") or careers URL (job-boards.greenhouse.io/<slug>)


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


# --------------------------------------------------------------------------- #
# Free public CV-vs-JD scan (no signup, deterministic only — PLAN 6)
# --------------------------------------------------------------------------- #
class FreeScanCheck(BaseModel):
    id: str  # email | phone | length | numbers — stable ids the UI translates
    severity: str = "good"  # good | warn
    value: str = ""  # supporting figure for the UI string (word count, ...)


class FreeScanResult(BaseModel):
    coverage: float = 0.0  # deterministic keyword coverage, 0-100
    keywords: list[GapItem] = Field(default_factory=list)  # covered | partial | missing
    checks: list[FreeScanCheck] = Field(default_factory=list)
    jd_language: str = "en"  # "he" | "en", detected deterministically
    resume_language: str = "en"


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


# --------------------------------------------------------------------------- #
# Outreach Studio — recruiter / hiring-manager / referral messages that bypass
# the ATS. Grounded only in real résumé facts (no fabrication guard needed —
# it's not a résumé — but the prompt enforces the same honesty rule).
# --------------------------------------------------------------------------- #
class OutreachRequest(BaseModel):
    resume: ResumeModel
    jd_text: str = ""
    company: str = ""
    job_title: str = ""
    contact_name: str = ""
    contact_role: str = "recruiter"  # recruiter | hiring manager | connection


class OutreachResult(BaseModel):
    connection_note: str = ""  # LinkedIn connection request, ≤300 chars
    inmail_subject: str = ""
    inmail_body: str = ""  # longer InMail / cold email
    referral_message: str = ""  # ask a 1st-degree contact for a referral


# --------------------------------------------------------------------------- #
# Screening-question answerer — honest, résumé-grounded answers to application
# free-text questions ("Why us?", "Describe a time…").
# --------------------------------------------------------------------------- #
class ScreeningRequest(BaseModel):
    resume: ResumeModel
    jd_text: str = ""
    question: str = ""


class ScreeningAnswerResult(BaseModel):
    answer: str = ""
    tips: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Company Research Brief — "what to know before you apply/interview here",
# grounded in a fetched company page (never model memory alone; the UI labels
# everything "verify these"). Key people come only from the provided text, and
# emails only from the deterministic extractor — the LLM never guesses one.
# --------------------------------------------------------------------------- #
class CompanyBriefRequest(BaseModel):
    resume: ResumeModel
    company: str = ""
    url: str = ""  # company about/careers/team page to fetch (optional)
    page_text: str = ""  # pasted page text (alternative to url)
    jd_text: str = ""  # optional target JD for context
    job_title: str = ""  # optional target role for the reach-out message


class BriefPerson(BaseModel):
    name: str = ""
    role: str = ""  # e.g. "Co-founder", "VP Engineering", "Talent Acquisition"
    evidence: str = ""  # short quote from the page text where this person appears
    linkedin_search: str = ""  # deterministic people-search deep link (server-built)
    email: str = ""  # only when it appears verbatim in the page text


class BriefTarget(BaseModel):
    """A likely decision-maker title for the target role (PLAN 11.7), with a
    LinkedIn deep link — the company's People tab filtered by the title when
    the page linked the company's LinkedIn, else a people search. Built from a
    deterministic role→titles table, never the LLM."""

    title: str = ""  # e.g. "CTO", "Head of AI", "Recruiter"
    url: str = ""


class CompanyBriefResult(BaseModel):
    company: str = ""
    overview: str = ""  # 2-3 plain sentences on what they do
    products: list[str] = Field(default_factory=list)
    culture: list[str] = Field(default_factory=list)
    interview_style: list[str] = Field(default_factory=list)
    talking_points: list[str] = Field(default_factory=list)  # résumé ↔ company fit
    people: list[BriefPerson] = Field(default_factory=list)  # founders/managers/recruiters
    targets: list[BriefTarget] = Field(default_factory=list)  # role-aware hiring-chain links (PLAN 11.7)
    company_people_url: str = ""  # the company's LinkedIn People tab, when the page linked it
    hiring_emails: list[str] = Field(default_factory=list)  # careers@/jobs@/hr@ found on the page
    outreach_subject: str = ""
    outreach_message: str = ""  # short reach-out to the top person (résumé-grounded)
    grounded: bool = False  # True when a company page was actually fetched/pasted


# --------------------------------------------------------------------------- #
# Standalone résumé health-check — JD-independent quality grade of the master
# résumé. Deterministic writing checks (stable ids the UI translates) compute
# the score; the LLM contributes critique text only, never the number.
# --------------------------------------------------------------------------- #
class HealthCheck(BaseModel):
    id: str  # stable id the UI translates (health.checks.<id>)
    severity: str = "good"  # good | warn | bad
    count: int = 0  # numeric payload for the UI copy (meaning varies by id)
    total: int = 0
    examples: list[str] = Field(default_factory=list)  # offending snippets, verbatim


class BulletRewrite(BaseModel):
    before: str = ""  # a real bullet, verbatim
    after: str = ""  # same facts, stronger wording — never new claims


class ResumeHealthRequest(BaseModel):
    resume: ResumeModel


class ResumeHealthResult(BaseModel):
    score: float = 0.0  # deterministic, derived from the checks
    checks: list[HealthCheck] = Field(default_factory=list)
    strengths: list[str] = Field(default_factory=list)  # LLM critique
    improvements: list[str] = Field(default_factory=list)  # LLM critique
    rewrites: list[BulletRewrite] = Field(default_factory=list)
