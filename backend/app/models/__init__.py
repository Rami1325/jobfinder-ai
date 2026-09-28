"""Pydantic schemas shared across the app."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


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
    """IDF/military service entry — standard on Israeli resumes.

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


class SkillGroup(BaseModel):
    """One labelled cluster of skills — "AI & LLMs", "Backend & Data".

    Real CVs group their skills; a flat list of 138 tokens is a wall nobody
    reads. The grouping used to be destroyed on import because the model had
    nowhere to put it.

    ADDITIVE AND OPTIONAL. `ResumeModel.skill_groups` defaults to empty, and
    while it is empty every consumer behaves exactly as it did before it
    existed — so no stored resume, saved kit or tracker row changes meaning.
    """

    label: str = ""
    items: list[str] = Field(default_factory=list)


class ResumeModel(BaseModel):
    contact: Contact = Field(default_factory=Contact)
    # The target-title line under the name ("Backend Engineer"). Recruiters and
    # ATS both match on title, so tailoring sets this to the JD's title when the
    # candidate's real background supports it. It is a CLAIM, so the fabrication
    # guard checks it for rank inflation.
    headline: str = ""
    summary: str = ""
    # THE FLAT SKILL SURFACE, and the only one anything downstream reads: the
    # scorer's keyword coverage, the ATS scan, the ATS x-ray, resume health and
    # the length budget all go through `skills`. It therefore stays populated as
    # the flat union of every group's items even when `skill_groups` carries the
    # presentation — see `_sync_skill_groups`, which enforces exactly that.
    skills: list[str] = Field(default_factory=list)
    # The same skills, as the source CV grouped them. Presentation only: both
    # renderers read it, nothing that scores or guards does. Empty = the
    # pre-existing flat behaviour, unchanged.
    skill_groups: list[SkillGroup] = Field(default_factory=list)
    experience: list[Experience] = Field(default_factory=list)
    education: list[Education] = Field(default_factory=list)
    projects: list[Project] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)
    military_service: list[MilitaryService] = Field(default_factory=list)
    languages: list[LanguageSkill] = Field(default_factory=list)

    @model_validator(mode="after")
    def _sync_skill_groups(self) -> "ResumeModel":
        """Guarantee `skills` ⊇ every grouped item, on every construction path.

        The grouping is presentation; `skills` is what gets SCORED. A model
        (or a hand-written payload) that returns groups and an empty — or
        partial — `skills` list would otherwise silently drop those skills out
        of keyword coverage and the ATS scan, which is the one regression this
        feature is not allowed to cause. Enforcing it here rather than at each
        call site means an LLM response, a stored JSON row and a smoke fixture
        all get the same guarantee.

        It only ever ADDS. Removing a skill is a deliberate act (the length
        budget's last-resort trim), and that caller drops the item from its
        group too, so the two stay consistent in both directions.
        """
        if not self.skill_groups:
            return self
        seen = {s.strip().casefold() for s in self.skills if s.strip()}
        for group in self.skill_groups:
            for item in group.items:
                key = item.strip().casefold()
                if key and key not in seen:
                    seen.add(key)
                    self.skills.append(item.strip())
        return self


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
    # "IL" | "other" | "" — whether the job is in Israel, set deterministically
    # by jd_analyzer (`job_market.israel_market`, never the LLM) and by the kit
    # path from the stored location. "" is UNKNOWN: every JD stored before this
    # field existed reads as unknown, never as "not Israel". Read by the opt-in
    # "leave Arabic off tailored resumes for jobs in Israel" preference.
    market: str = ""
    hard_skills: list[str] = Field(default_factory=list)  # mandatory/required skills
    # Humanization spec stage 2: nice-to-have skills and the business outcomes
    # the role exists to drive — parsed separately from hard requirements so
    # the planner and tailor never treat a "bonus" skill as a must-have gap.
    preferred_skills: list[str] = Field(default_factory=list)
    business_outcomes: list[str] = Field(default_factory=list)
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
    # The headline the candidate wrote for themselves, kept apart from `titles`
    # (which are employment records). Tailoring is free to reword a headline —
    # only a rank it never carried is a fabrication.
    headlines: list[str] = Field(default_factory=list)


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


class VoiceIssue(BaseModel):
    # banned_phrase | repeated_verb | repeated_phrase | outcome_clause |
    # jd_echo | uniform_bullets
    category: str
    value: str  # the offending phrase/verb
    location: str = ""  # e.g. "summary", "experience: Acme Corp"
    detail: str = ""


class VoiceReport(BaseModel):
    """Deterministic 'does this read like a human wrote it' audit of a resume.

    Produced by app/core/voice_audit.py after every tailor. `issues` are what
    remains AFTER the humanizer pass (if it ran); `fixed` are issues the pass
    removed. 100 = no AI tells detected."""

    human_voice_score: float = 100.0  # 0-100
    # % of the resume's 5-word phrases that appear verbatim in the JD's prose
    # (humanization spec stage 9: high overlap = the CV copies the employer's
    # wording instead of describing real experience).
    jd_copy_pct: float = 0.0
    issues: list[VoiceIssue] = Field(default_factory=list)
    fixed: list[VoiceIssue] = Field(default_factory=list)
    revised: bool = False  # a humanizer LLM pass ran and was accepted


class CVPlan(BaseModel):
    """Positioning strategy decided BEFORE tailoring (humanization spec stage 4):
    one coherent professional story, not a keyword collection. Fed into the
    TAILOR prompt and surfaced to the user."""

    positioning: str = ""  # one-line professional identity for THIS role
    lead_strengths: list[str] = Field(default_factory=list)
    emphasize: list[str] = Field(default_factory=list)  # experience/projects to lead with
    downplay: list[str] = Field(default_factory=list)  # content to trim or move down
    conservative_notes: list[str] = Field(default_factory=list)  # claims needing careful wording
    # Project curation. A master resume carries every project the candidate has
    # ever shipped; one job needs a handful. The planner names which ones, in
    # priority order, and the length budget reuses those names when it has to
    # drop more. Empty lists = no opinion, fall back to keyword overlap.
    select_projects: list[str] = Field(default_factory=list)  # keep, most relevant first
    drop_projects: list[str] = Field(default_factory=list)  # irrelevant to THIS role


class LengthReport(BaseModel):
    """What the page budget had to do to fit the resume (app/core/length_budget.py).

    Surfaced so the trimming is visible rather than silent — a dropped project
    is a decision the candidate may want to overrule."""

    pages_before: int = 1
    pages_after: int = 1
    max_pages: int = 2
    hard_max_pages: int = 3
    trimmed: bool = False
    dropped_projects: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)  # human-readable trim actions



class TailorResult(BaseModel):
    tailored_resume: ResumeModel
    changelog: list[ChangeLogEntry] = Field(default_factory=list)
    covered_keywords: list[str] = Field(default_factory=list)
    fabrication_flags: list[FabricationFlag] = Field(default_factory=list)
    score_before: Score = Field(default_factory=Score)
    score_after: Score = Field(default_factory=Score)
    voice_report: VoiceReport = Field(default_factory=VoiceReport)
    plan: CVPlan | None = None
    length_report: LengthReport = Field(default_factory=LengthReport)


# --------------------------------------------------------------------------- #
# API request/response bodies
# --------------------------------------------------------------------------- #
class WritingPrefsIn(BaseModel):
    """Feedback-loop signals (humanization spec §26): phrases the user rejected
    in the per-bullet review. Learned ONLY from explicit user decisions —
    never from unapproved generated output."""

    rejected: list[str] = Field(default_factory=list)


class WritingPrefsOut(BaseModel):
    avoid: list[str] = Field(default_factory=list)


class ResumePrefs(BaseModel):
    """GET/PUT /profile/resume-prefs. OFF by default for every user.

    `hide_arabic_in_israel`: leave Arabic off TAILORED resumes for jobs in
    Israel, unless the job asks for it. The master resume is never touched.
    Sensitive (it implies ethnicity), so the privacy wipe clears it."""

    hide_arabic_in_israel: bool = False


class JDAnalyzeRequest(BaseModel):
    jd_text: str
    # Optional hint for the market stamp (a job board's location field), used
    # only by `job_market.israel_market` — never sent to the model.
    location: str = ""


class TailorRequest(BaseModel):
    resume: ResumeModel
    jd: JDModel


class CoverLetterRequest(BaseModel):
    resume: ResumeModel
    jd: JDModel
    # A closed set the UI builds, never typed by the user: four tones, each
    # optionally followed by one of two fixed requests, the longest 48
    # characters ("enthusiastic, make it more specific to this role"). So a
    # longer one is a shape error, refused as a 422 before the cover-letter pass
    # (P30-PASS-SIZE); it went into the prompt unmeasured before.
    tone: str = Field(default="professional", max_length=200)


class CoverLetterResponse(BaseModel):
    """A cover letter, and the session pass it rode (Phase 30 / B5, OD-2 b).

    The first letter for a posting uses 1 and opens a 24-hour pass keyed by that
    analysed JD; changes to it (any tone) ride the pass, up to 10 calls in all.
    The pass belongs to ONE posting, so it travels on this response and never on
    /auth/me or the X-Uses-Pass header, which list the feature-keyed passes; a
    page that remounted reads it back from POST /cover-letter/pass
    (P30-RELOAD-PASS)."""

    cover_letter: str
    # ISO UTC end of this posting's pass; "" for a caller with no monthly limit.
    # Kept for a tab loaded before `expires_in_s` existed; the client reads that.
    included_until: str = ""
    # calls left on the pass after this one (max_calls - calls); 0 when exempt
    changes_left: int = 0
    # Seconds until the pass ends, read as the response is built; 0 when exempt.
    # Relative, never a timestamp: a phone whose clock runs ahead would read
    # `included_until` as over and, at 0 uses left, disable a covered change.
    expires_in_s: int = 0


class CoverLetterPassRequest(BaseModel):
    """Body of `POST /cover-letter/pass` (P30-RELOAD-PASS): the analysed JD whose
    cover-letter pass a remounted page reads back. The server hashes it with the
    same `quota.jd_ref` the letter was charged under, so there is one key and one
    answer. `extra="forbid"`: the route is uncapped and reaches no model, so it
    may never take job-ad text (the `/tools/ats-scan` cautionary tale)."""

    model_config = {"extra": "forbid"}

    jd: JDModel


# The rate a freelancer types beside a gig ("₪250 an hour", "$40-60/hr"):
# a short line, bounded at the schema (llm-boundary.md, the short fields).
PROPOSAL_RATE_MAX = 100


class ProposalRequest(BaseModel):
    """Body of `POST /proposal` (2026-09-28): a short bid for one gig.

    `jd` is the analysed posting, the key of the cover-letter pass this rides
    (`quota.jd_ref`), so a letter and a proposal for one posting share one use.
    Omitted, the route reads `gig_text` first (the Tools page's pasted gig; the
    daily `jd_analyze` count, never a monthly use) and hands the reading back,
    so the next call rides the pass. `gig_text` is the posting's own words, the
    user's paste: measured as kind "gig" and refused whole, never clipped.
    `rate` is used verbatim or not at all; `tone` is one of the page's two
    adjustments. `extra="forbid"`: a field this route does not know is a 422,
    never quietly dropped."""

    model_config = {"extra": "forbid"}

    resume: ResumeModel
    jd: Optional[JDModel] = None
    gig_text: str = ""
    rate: str = Field(default="", max_length=PROPOSAL_RATE_MAX)
    tone: str = Field(default="", max_length=200)


class ProposalResponse(BaseModel):
    """A proposal, and what the floor under the prompt found in it
    (`core/proposal_terms.py`), and the cover-letter pass it rode (the letter's
    three fields, read the same way). `jd` is the posting as read, for the next
    call to send back. `placeholders` are the [brackets] left for the user to
    fill, `replaced` what the floor took out (a rate, a timeline, a start date
    the user did not give), and `unverified` the numbers neither the resume, the
    gig nor the rate carries. None of them is a claim that the text is right."""

    proposal: str
    jd: JDModel
    language: str = "en"
    placeholders: list[str] = Field(default_factory=list)
    replaced: list[str] = Field(default_factory=list)
    unverified: list[str] = Field(default_factory=list)
    included_until: str = ""
    changes_left: int = 0
    expires_in_s: int = 0


class RenderRequest(BaseModel):
    resume: ResumeModel
    fmt: str = "docx"  # docx | pdf
    # Visual template (see app/render/templates.py). "" falls back to the
    # default, like every other render call — and unlike the literal "classic"
    # this carried until 2026-09-06, which was the id that HAPPENED to be the
    # default when it was written. It stopped being one when `standard` took
    # over, so a client that omitted the field silently kept downloading the old
    # template while the preview beside it drew the new one. A default that
    # NAMES a template is a second declaration of `DEFAULT_TEMPLATE`; the six
    # other request models that carry this field all say "" for that reason.
    template: str = ""


class ResumeUploadResponse(BaseModel):
    resume: ResumeModel
    ledger: FactsLedger


# --------------------------------------------------------------------------- #
# Master resume (persisted, reused across features)
# --------------------------------------------------------------------------- #
class MasterResumeIn(BaseModel):
    resume: ResumeModel
    ledger: Optional[FactsLedger] = None
    label: str = "My resume"
    # PLAN 31.6/1, what an autosave needs from the server. Each is optional, and
    # a save without them behaves exactly as before, so a tab left open across
    # the deploy keeps working.
    # The language slot this document was loaded from. When the resume now
    # reads as the OTHER language, the save is refused (409, kind `resume_slot`)
    # instead of landing on the other resume.
    slot: Optional[Literal["en", "he"]] = None
    # The `updated_at` this document was loaded or last saved at, "" for "no
    # saved resume in this slot". Anything newer on the server is a save from
    # another tab or device, refused (409, kind `resume_stale`) rather than
    # overwritten.
    base_updated_at: Optional[str] = Field(default=None, max_length=64)
    # A save the user did not ask for: its restore points are coalesced.
    autosave: bool = False


class MasterResumeOut(BaseModel):
    resume: ResumeModel
    ledger: Optional[FactsLedger] = None
    label: str = "My resume"
    language: str = "en"  # detected server-side from the resume text ("en" | "he")
    updated_at: str = ""


class MasterResumeList(BaseModel):
    """All saved masters (at most one per language), most recently updated first."""

    resumes: list[MasterResumeOut] = Field(default_factory=list)


class ResumeVersionOut(BaseModel):
    """One restore point (PLAN 20.8 / N1) — METADATA ONLY.

    Deliberately without `resume`: the list view shows a dozen of these and a
    master resume is ~48 kB of JSON, so shipping the content would make the
    picker heavier than everything it is offered next to. `GET
    /profile/resume/versions/{id}` returns the full thing when one is opened.
    """

    id: int
    label: str = ""
    language: str = "en"
    # When this content stopped being current — what the UI labels the point with.
    created_at: str = ""
    # Enough to tell two restore points apart without opening either.
    headline: str = ""
    experience_count: int = 0
    project_count: int = 0


class ResumeVersionList(BaseModel):
    versions: list[ResumeVersionOut] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Job alerts
# --------------------------------------------------------------------------- #
class AlertSettingsIn(BaseModel):
    enabled: bool = False
    email: str = ""
    context: Optional["SearchContext"] = None  # None = derive from the resume
    nudge_emails: bool = False  # PLAN 11.4: email follow-up reminders too
    # Minimum ROUNDED fit (0-100) a new posting needs to reach the inbox; 0
    # emails everything. Optional, and None means LEAVE UNCHANGED rather than
    # "reset to the default" — every other field on this model is a full
    # replace, but a tab left open across a deploy PUTs the old field set, and
    # for this one field the failure that causes is the exact complaint the bar
    # exists to fix: a user who chose 90 silently drops back to 75 and starts
    # getting mail again. A new client always sends it, including 0.
    min_score: Optional[int] = None


class AlertSettingsOut(BaseModel):
    enabled: bool = False
    email: str = ""
    context: Optional["SearchContext"] = None
    last_run_at: str = ""
    last_new_count: int = 0
    last_error: str = ""
    smtp_configured: bool = False  # False => runs won't email; UI explains
    nudge_emails: bool = False
    min_score: int = 0  # the fit bar in force; 0 = email every new posting
    # Of last_new_count, how many cleared the bar. None = the last run predates
    # the bar and never measured it — which is NOT the same as 0 ("it measured,
    # and none cleared"). The card renders its pre-bar line for None.
    last_above_min: Optional[int] = None
    # Phase 30 / B6.5: "monthly_limit" while the owner's monthly uses are spent,
    # so the morning emails stop until the 1st; "" otherwise. Worked out from the
    # pool when the card is read, never from the last morning's skip.
    paused_reason: str = ""
    # "YYYY-MM-DD", the 1st of next month, while paused; "" otherwise.
    resumes_on: str = ""


class AlertRunResult(BaseModel):
    # Whose run this was. The cron returns a list of these and, since PLAN
    # 20.5/C2, runs users longest-unrun-first — so position no longer implies
    # identity and an anonymous outcome is undebuggable.
    user_id: int = 0
    ran: bool = False
    total: int = 0  # jobs the search returned
    new_count: int = 0  # of those, never seen in history before
    # Of `new_count`, how many cleared the alert's fit bar — the postings the
    # email actually carried. The two are reported separately on purpose: a run
    # that finds 12 new jobs and emails 3 is working correctly, and collapsing
    # them into one number makes that indistinguishable from a broken search.
    above_min: int = 0
    emailed: bool = False
    error: str = ""
    # Phase 30 / B6.2: "monthly_limit" when a scheduled morning did not run
    # because its owner had no use left (ran is False, error is empty); "" when
    # the run was not skipped.
    skipped_reason: str = ""
    # PLAN 32: devices the morning's notification reached (web push). Pushing
    # never keeps or spends a use.
    pushed: int = 0
    # PLAN 32: whether the digest went to the owner's verified WhatsApp number.
    # A WhatsApp message is a message sent, so like the email it keeps the use.
    whatsapped: bool = False


# --------------------------------------------------------------------------- #
# Web push (PLAN 32): the devices a user turned the morning alert on for.
# --------------------------------------------------------------------------- #
class PushKeys(BaseModel):
    p256dh: str = Field(default="", max_length=256)
    auth: str = Field(default="", max_length=64)


class PushSubscribeIn(BaseModel):
    """What `PushSubscription.toJSON()` gives the page, plus the page's language.
    The endpoint is a caller-supplied URL: the route stores it only when
    `webpush.push_endpoint_allowed` passes."""

    endpoint: str = Field(default="", max_length=2048)
    keys: PushKeys = Field(default_factory=PushKeys)
    lang: str = Field(default="", max_length=8)


class PushEndpointIn(BaseModel):
    endpoint: str = Field(default="", max_length=2048)


class PushDeviceOut(BaseModel):
    id: int
    # The browser's own endpoint, so a page can tell whether it is THIS device.
    endpoint: str = ""
    lang: str = "en"
    created_at: str = ""
    # "" = nothing has reached it yet (never "it failed").
    last_success_at: str = ""
    failure_count: int = 0


class PushDevicesOut(BaseModel):
    """GET /push/devices. `configured` false = web push is off on this server
    (no VAPID keys), and the page draws nothing; `public_key` is what a browser
    subscribes with."""

    configured: bool = False
    public_key: str = ""
    devices: list[PushDeviceOut] = Field(default_factory=list)


class PushTestResult(BaseModel):
    # "sent" | "gone" (the browser dropped it; the row is deleted) | "failed" | "network"
    status: str = ""


class PushRemoved(BaseModel):
    removed: int = 0


# --------------------------------------------------------------------------- #
# WhatsApp alerts (PLAN 32, part 2): OFF unless the server is configured AND the
# admin granted this account.
# --------------------------------------------------------------------------- #
class WhatsAppStatusOut(BaseModel):
    """GET /whatsapp. `available` false = the page draws nothing (the server has
    no WhatsApp set up, or the admin has not granted this account)."""

    available: bool = False
    # The caller's own number, E.164, "" when none is saved.
    phone: str = ""
    opted_in: bool = False
    verified: bool = False
    # A code was sent and has not expired.
    code_pending: bool = False
    last_sent_at: str = ""
    last_error: str = ""


class WhatsAppCodeIn(BaseModel):
    phone: str = Field(default="", max_length=40)
    # The explicit opt-in; the route refuses without it.
    opt_in: bool = False
    lang: str = Field(default="", max_length=8)


class WhatsAppVerifyIn(BaseModel):
    code: str = Field(default="", max_length=12)


class WhatsAppSendOut(BaseModel):
    sent: bool = False
    status: WhatsAppStatusOut = Field(default_factory=WhatsAppStatusOut)


class AlertCronResult(BaseModel):
    """One cron tick across all users (PLAN 7.3)."""

    users: int = 0  # enabled alerts found
    results: list[AlertRunResult] = Field(default_factory=list)
    # Enabled alerts the tick's time budget didn't reach (PLAN 20.5/C2). They
    # sort first on the next tick, so a non-zero value here is a rotation, not
    # a loss — but a value that stays non-zero every day means the budget can no
    # longer cover the user list and the cron needs to run more often.
    skipped: int = 0


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
    base_language: str = ""  # which master resume slot was tailored ("en"|"he")
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
    counting), the analyzed JD, the master resume the tailor ran on (the diff
    baseline), and the complete TailorResult."""

    jd_text: str = ""
    jd: Optional[JDModel] = None
    base_resume: Optional[ResumeModel] = None
    result: Optional[TailorResult] = None
    # The letter last generated on the review page (PUT /kits/{id}/cover-letter),
    # or the one approved with the kit. "" when none was generated.
    cover_letter: str = ""


# A cover letter runs to a few KB. The cap only bounds what one request can store.
KIT_COVER_LETTER_MAX_CHARS = 20_000


class KitCoverLetterIn(BaseModel):
    """Body of PUT /kits/{id}/cover-letter: the letter the review page just
    generated, stored on the kit so a reload shows it again. A longer body is a 422."""

    model_config = {"extra": "forbid"}

    cover_letter: str = Field(default="", max_length=KIT_COVER_LETTER_MAX_CHARS)


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

    `resume` is the effective resume after the reviewer's per-bullet
    accept/reject decisions (client-computed, same as the Tailor page's diff);
    omitted => the kit's full tailored resume. `cover_letter` is whatever the
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
    # P29-ADMIN-EMAIL: a free label only for an account with no sign-in row. For
    # one that signs in with an address, the route accepts only that address
    # (stored in the login's spelling) or the label's current value, and answers
    # anything else 400 — the admin API never moves a sign-in address. The field
    # stays, so a label edit on an invite-code account keeps working; no
    # TypeScript mirror exists for this model and none is needed.
    email: Optional[str] = None
    # Phase 29 / B2: may this account connect Gmail while INBOX_ACCESS=allowlist.
    inbox_enabled: Optional[bool] = None
    # PLAN 32: may this account get the morning alert on WhatsApp (the owner pays per message).
    whatsapp_enabled: Optional[bool] = None
    # Phase 30 / B7: "free" or "unlimited". The route validates it, so anything
    # else is a 400 with a sentence, never FastAPI's list-shaped 422.
    plan: Optional[str] = None


class UserOut(BaseModel):
    id: int
    name: str = ""
    email: str = ""
    invite_code: str = ""  # admin-only responses; this is what a friend types in
    is_admin: bool = False
    is_active: bool = True
    created_at: str = ""
    # "" means NOT MEASURED — either the row predates the column or this build
    # never stamped it — and NEVER "has not visited". Any UI for this has to
    # say "unknown", or a code minted before the column reads as a no-show.
    last_seen_at: str = ""
    # Phase 29, additive: the address this user signs in with ("" = invite code
    # only) and whether the gate treats them as verified — which every invite
    # code is, by construction.
    login_email: str = ""
    verified: bool = True
    inbox_enabled: bool = False
    whatsapp_enabled: bool = False
    # Phase 30 / B7: the stored plan (an unknown value reads as "free", the way it
    # is enforced) and what this user's pool spent this UTC month. Two accounts on
    # one pool (a gmail alias) show the same count.
    plan: str = "free"
    uses_this_month: int = 0


class UserList(BaseModel):
    users: list[UserOut] = Field(default_factory=list)


class FunnelPerson(BaseModel):
    """One account's first steps (PLAN 31.8), for the admin list. Content-free:
    a name to tell people apart, when they signed up, and when each step was
    first reached (`db.funnel.STEPS`; a step not reached is absent)."""

    id: int
    name: str = ""
    is_admin: bool = False
    signed_up: str = ""
    steps: dict[str, str] = Field(default_factory=dict)


class FunnelOut(BaseModel):
    people: list[FunnelPerson] = Field(default_factory=list)
    # The step names in the order a person meets them, so the page never
    # hard-codes a list the server can change.
    order: list[str] = Field(default_factory=list)


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
    """Row counts removed by DELETE /profile/data, plus whether the Gmail grant
    really went back (PLAN 7.5; Phase 30 / B2 for the two carve-outs below)."""

    resumes: int = 0
    # Version history (PLAN 20.8/N1). These hold FULL past resumes, so a wipe
    # that skipped them would leave the PII the wipe exists to remove.
    resume_versions: int = 0
    applications: int = 0
    history: int = 0
    alerts: int = 0
    # Daily-cap counters (`usage_log`). On /profile/data this counts rows from
    # EARLIER UTC days ONLY — today's are the live daily counters, and a wipe
    # that took them would reset every daily cap. DELETE /profile/account adds
    # today's rows into this SAME number, since a deactivated id can never spend
    # them. The three monthly-uses tables are in neither figure: they are never
    # wiped, because the pool belongs to the person, not to the account.
    usage: int = 0
    feedback: int = 0
    kits: int = 0
    # Phase 29 / B2: detected job emails, and the Gmail connection itself —
    # which holds the encrypted grant, so a wipe that skipped it would leave a
    # standing key to the user's mailbox behind.
    inbox_events: int = 0
    inbox_connections: int = 0
    # FIXB B17: whether a stored Gmail grant was really handed back to Google.
    # False with no connection, and False when the token could not be read —
    # never a claimed revoke that did not happen.
    google_revoked: bool = False
    # PLAN 31.8: the first time this person reached each step (`db.funnel`).
    steps: int = 0
    # PLAN 32: the devices the morning alert was pushed to, and the WhatsApp number.
    push_devices: int = 0
    whatsapp: int = 0


class MeOut(BaseModel):
    """Who the caller's access code resolves to (PLAN 23.5, Settings).

    Deliberately NOT `UserOut`: that one carries `invite_code`, and echoing the
    code back into a page body would put it in every screenshot and error
    report. The device already has it in localStorage; nothing on the account
    surface needs it re-sent.
    """

    name: str = ""
    email: str = ""
    # The Danger-zone "Close my account" is refused for an admin (see routes),
    # so the page needs this to disable the control instead of letting the user
    # discover the 400.
    is_admin: bool = False


class DeleteAccountResult(BaseModel):
    """DELETE /profile/account = the same wipe, plus switching the code off.

    The wipe counts are nested rather than flattened so the two routes can
    never drift: `data` IS a `DeleteMyDataResult`, built by the one helper both
    routes call.
    """

    data: DeleteMyDataResult
    deactivated: bool = False


# --------------------------------------------------------------------------- #
# Accounts (Phase 29 / B1): email sign-in beside the invite codes. Request
# fields all default to "", so a missing field reaches the route's own
# structured 400 (`{"code": ...}`, translated client-side) instead of FastAPI's
# English 422.
# --------------------------------------------------------------------------- #
class AuthUser(BaseModel):
    id: int
    name: str = ""
    email: str = ""  # the sign-in address when there is one, else users.email
    is_admin: bool = False
    has_password: bool = False
    google_linked: bool = False  # a Google sign-in is linked to this login (Phase 30 / E4)
    signup_source: str = ""  # "" = invite code / admin; "email" or "google" = self-service


class UsagePassOut(BaseModel):
    """One open session pass: as /auth/me lists it (interview practice, screening
    answers), and as POST /cover-letter/pass reads one posting's cover-letter pass
    back (P30-RELOAD-PASS). 0/0 means no open pass."""

    calls_left: int = 0
    # Relative seconds, never a timestamp: a phone whose clock is wrong would
    # otherwise end the pass early. The client works out its deadline on arrival.
    expires_in_s: int = 0


class UsageOut(BaseModel):
    """This month's uses (Phase 30 / B7), on AuthMe.usage. Its field names are a
    cross-lane contract with the TypeScript mirror (check-mirrors 32(j))."""

    # "free" or "unlimited"
    plan: str = "free"
    # None = no monthly limit: the admin, plan "unlimited", or the limit switched off
    limit: Optional[int] = None
    used: int = 0
    # None exactly when limit is
    remaining: Optional[int] = None
    # "YYYY-MM-DD", the 1st of the next UTC month
    resets_on: str = ""
    # SUM(delta) per feature this month
    by_feature: dict[str, int] = Field(default_factory=dict)
    # the open interview and screening passes, newest per feature; always empty with no limit
    passes: dict[str, UsagePassOut] = Field(default_factory=dict)
    # the features whose next use in this pool is free, its first ever (PLAN 31.5,
    # owner decision 7: "search"); always empty with no limit
    first_free: list[str] = Field(default_factory=list)


class AuthMe(BaseModel):
    """GET /auth/me — always 200, anonymous callers included. Deliberately not
    `MeOut`, which is pinned byte-for-byte and stays exactly what it was."""

    authenticated: bool = False
    verified: bool = False
    method: str = ""  # "invite_code" | "session" | "dev" (gate off) | "" (anonymous)
    signup_open: bool = True
    # Continue with Google is configured on this server (Phase 30 / E4), on BOTH
    # returns: /login and /signup read it signed out to decide whether to show it.
    google_enabled: bool = False
    user: Optional[AuthUser] = None
    # Phase 30 / B7: this month's uses for a signed-in caller; None for an anonymous one.
    usage: Optional[UsageOut] = None


class GoogleStartIn(BaseModel):
    """POST /auth/google/start (Phase 30 / E2). `next` is checked with safe_next;
    a `page` other than "login" or "signup" reads as login.

    `next` is bounded here so an oversize body is REFUSED (422) instead of being
    silently rewritten to /app: this is an anonymous door, and its `next` is
    STORED for the round trip (Phase 30 review, SEC-2). The ceiling that cannot
    be forgotten is `sessions.MAX_NEXT`, inside safe_next itself, because the
    callback re-derives its destination from the stored row rather than from a
    request body."""

    next: str = Field(default="", max_length=512)
    locale: str = ""  # the language of any notice this sign-in mails
    page: str = ""  # the page a refusal comes back to


class GoogleStartOut(BaseModel):
    url: str = ""


class SignupIn(BaseModel):
    name: str = ""
    email: str = ""
    password: str = ""
    locale: str = ""  # "en" | "he" — the language of this account's auth mail


class LoginIn(BaseModel):
    email: str = ""
    password: str = ""


class VerifyIn(BaseModel):
    token: str = ""  # from the emailed link; needs no session
    code: str = ""  # the 6 digits; needs the pending session


class VerifyOut(BaseModel):
    verified: bool = False
    signed_in: bool = False  # False after a link opened in a browser holding no session


class ResendOut(BaseModel):
    sent: bool = False
    cooldown_s: int = 0


class ChangeEmailIn(BaseModel):
    email: str = ""


class ForgotIn(BaseModel):
    email: str = ""


class ResetIn(BaseModel):
    token: str = ""
    password: str = ""


class PasswordChangeIn(BaseModel):
    current_password: str = ""
    new_password: str = ""


class OkOut(BaseModel):
    ok: bool = True


# FIXB B1: a password change, a reset and "sign out other devices" each replace
# a self-registered account's extension key; the answer says whether it did, so
# the page can tell the reader the extension needs the new key. False for an
# invite-code account and the admin, whose codes are never rotated here.
class PasswordChangeOut(BaseModel):
    ok: bool = True
    extension_key_rotated: bool = False


class ResetOut(AuthMe):
    """POST /auth/reset: /auth/me's answer for the fresh session, plus the rotation flag."""

    extension_key_rotated: bool = False


class LogoutOthersIn(BaseModel):
    """Body of `POST /auth/logout-others` (the phone polish pass, 2026-09-28): the
    push endpoint THIS browser holds, if it holds one, so the morning's
    notifications keep reaching it while every other device's stop. Empty or no
    body at all (a tab loaded before this, a browser with no subscription) keeps
    none. `extra="forbid"`: nothing else rides this door."""

    model_config = {"extra": "forbid"}

    keep_push_endpoint: str = Field(default="", max_length=2048)


class LogoutOthersOut(BaseModel):
    ok: bool = True
    revoked: int = 0
    extension_key_rotated: bool = False
    # The phone polish pass: how many devices' notifications stopped, and whether
    # this browser's own subscription was found among the account's and kept.
    push_removed: int = 0
    push_kept: bool = False


class ExtensionKeyOut(BaseModel):
    key: str = ""


# --------------------------------------------------------------------------- #
# Gmail inbox scanner (Phase 29 / B2). Timestamps carry an explicit UTC offset,
# and None means unknown/never — a naive ISO string is parsed as LOCAL time by
# JavaScript, which skews every date by the reader's offset.
# --------------------------------------------------------------------------- #
class InboxStatus(BaseModel):
    """GET /inbox/status. `ready` answers "may THIS account use Gmail sync":
    false with reason "invite_only" for an account the allowlist does not name
    (amendment O2), false with reason "" on a server with no Gmail set up."""

    ready: bool = False
    reason: str = ""
    google_ready: bool = False  # false while ready = only the demo mailbox exists
    connected: bool = False
    provider: str = ""  # gmail | fake | ""
    email: str = ""
    status: str = ""  # active | needs_reauth | error | ""
    last_sync_at: Optional[str] = None
    auto_sync: bool = True
    backfill_days: int = 60
    review_count: int = 0
    events_total: int = 0
    last_error_code: str = ""
    # connected_at + 7 days while Google keeps the app in Testing (O3); None when
    # no weekly expiry applies.
    reauth_due_at: Optional[str] = None
    oauth_testing: bool = False
    # An import of past mail is still unfinished; the cron carries it on.
    backfilling: bool = False


class InboxEventOut(BaseModel):
    """One email the scanner stored: the extraction, never the body."""

    id: int
    received_at: str = ""
    from_name: str = ""
    from_email: str = ""
    subject: str = ""
    snippet: str = ""
    kind: str = "other"
    company: str = ""
    job_title: str = ""
    confidence: float = 0.0
    method: str = ""
    interview_at: str = ""
    evidence: str = ""
    application_id: Optional[int] = None
    action: str = ""
    prev_status: str = ""
    new_status: str = ""
    set_interviewed: bool = False
    created_at: str = ""
    gmail_url: str = ""  # "" when the message has no Message-ID or is not in Gmail


class InboxSyncResult(BaseModel):
    """POST /inbox/sync, and one row of the cron's results. Never an exception
    for a mailbox problem: a refused grant or a spent cap is `error_code`.
    `has_more` = this run stopped with mail still to read."""

    user_id: int = 0
    scanned: int = 0
    noise: int = 0
    rule_hits: int = 0
    llm_calls: int = 0
    events: int = 0
    created: int = 0
    updated: int = 0
    review: int = 0
    has_more: bool = False
    error_code: str = ""


class InboxCronResult(BaseModel):
    users: int = 0
    results: list[InboxSyncResult] = Field(default_factory=list)
    skipped: int = 0


class InboxStartIn(BaseModel):
    backfill_days: Optional[int] = Field(default=None, ge=7, le=180)


class InboxStartOut(BaseModel):
    url: str = ""


class InboxResolveIn(BaseModel):
    application_id: Optional[int] = None
    create: bool = False


class InboxSettingsIn(BaseModel):
    auto_sync: Optional[bool] = None
    backfill_days: Optional[int] = Field(default=None, ge=7, le=180)


class InboxDisconnectOut(BaseModel):
    disconnected: bool = False
    events_deleted: int = 0
    # FIXB B17: whether Google actually accepted the revoke. False when the token
    # could not be read (INBOX_TOKEN_KEY missing or wrong) or Google did not
    # answer — our copy is deleted either way, and the page must then tell the
    # reader to remove the access at myaccount.google.com.
    google_revoked: bool = False


# --------------------------------------------------------------------------- #
# Application tracker
# --------------------------------------------------------------------------- #
class ApplicationReview(BaseModel):
    """The review behind a saved draft (PLAN 31.4/4): what the document needs to
    open it again after a reload. Sent with the draft by the tailor page.

    `result` and `base` (the tailor's answer and the master it was tailored
    from) are sent with the FIRST save of each result and left out of the saves
    after it, which carry only what changes on every tap: the edits declined
    (`lib/resumeDiff` ids) and the lines typed over the draft (source anchor →
    field → text). None for `result` keeps the stored one. `scored_at` is the
    minute the tailor's recruiter-fit reading was taken, stamped on the client
    and kept with the reading it dates."""

    model_config = {"extra": "forbid"}
    result: Optional[TailorResult] = None
    base: Optional[ResumeModel] = None
    rejected: list[str] = Field(default_factory=list, max_length=5000)
    overrides: dict[str, dict[str, str]] = Field(default_factory=dict)
    scored_at: Optional[float] = None


class ApplicationReviewOut(BaseModel):
    """GET /applications/{id}/review: a stored review, whole."""

    result: TailorResult
    base: ResumeModel
    rejected: list[str] = Field(default_factory=list)
    overrides: dict[str, dict[str, str]] = Field(default_factory=dict)
    scored_at: Optional[float] = None


class ApplicationCreate(BaseModel):
    job_title: str = ""
    company: str = ""
    jd_text: str = ""
    tailored_resume: Optional[ResumeModel] = None
    cover_letter: str = ""
    overall_score: float = 0.0
    status: str = "saved"  # saved | applied | interview | offer | rejected
    job_url: str = ""
    # What was sent (PLAN 17.3) — feeds the "what actually converts" report.
    template: str = ""
    voice_score: Optional[float] = None
    fabrication_flag_count: Optional[int] = None
    # PLAN 31.4, the job page: where the posting is, when its board says it was
    # posted, and the analysis a fit check or tailor already ran on it. Each is
    # optional; an absent one stays unknown on the row. Bounded by the columns
    # they land in (Postgres refuses a longer value, and the whole save with it).
    location: str = Field(default="", max_length=255)
    posted_at: str = Field(default="", max_length=32)
    jd: Optional[JDModel] = None
    # PLAN 31.4/4: the review behind `tailored_resume`, written with it. A
    # tailored resume sent without one clears the stored review.
    review: Optional[ApplicationReview] = None


class ApplicationUpdate(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None
    interviewed: Optional[bool] = None
    excitement: Optional[int] = Field(default=None, ge=0, le=5)  # 0 clears the rating
    # PLAN 31.4: the job page writes a letter and, before its first letter on a
    # row with no analysis, the analysis it had to run. None leaves each alone.
    cover_letter: Optional[str] = Field(default=None, max_length=20_000)
    jd: Optional[JDModel] = None


class ApplicationDraft(BaseModel):
    """PUT /applications/{id}/draft (PLAN 31.3/4, owner decision 2): a tailored
    draft saved WITH its job while the user reviews it, so nothing is lost on
    navigation and "these edits live only for this visit" could go.

    The resume and its what-was-sent signals are WRITTEN TOGETHER, None
    included, the way `create_application`'s merge writes them: a signal
    describes the resume beside it, and once the user has typed over the AI's
    draft its fabrication count is unknown, never the AI version's number
    (data-and-privacy.md, what a tracker row records). `cover_letter` is the one
    field None LEAVES alone: a draft saved before any letter was written must
    not erase one the row already holds. `extra="forbid"`: a stale client's
    field is refused, never quietly dropped."""

    model_config = {"extra": "forbid"}
    tailored_resume: ResumeModel
    template: str = ""
    voice_score: Optional[float] = None
    fabrication_flag_count: Optional[int] = None
    overall_score: Optional[float] = None
    cover_letter: Optional[str] = Field(default=None, max_length=20_000)
    # PLAN 31.4: the analysis this draft was tailored against. A tailor started
    # from a job's own page saves onto that row with this PUT, so the analysis
    # has to ride here too. None leaves the row's analysis alone, like the letter.
    jd: Optional[JDModel] = None
    # PLAN 31.4/4: the review behind this draft, written with it. Unlike the
    # letter and the analysis, None CLEARS the stored review: the draft is being
    # replaced, and a review of the previous draft would reopen the wrong one.
    review: Optional[ApplicationReview] = None


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
    # None/"" means "written before we recorded this", not "zero" — the tracker
    # report drops those rows rather than scoring them.
    template: str = ""
    voice_score: Optional[float] = None
    fabrication_flag_count: Optional[int] = None
    created_at: str
    # Phase 29 / B2, additive. `applied_at` is when the application was SENT
    # (explicit offset); None is unknown, never "not sent".
    source: str = ""  # "email" when the inbox scanner created the row
    applied_at: Optional[str] = None
    last_email_at: Optional[str] = None
    last_email_kind: str = ""  # the newest linked email's kind; "" when none
    # PLAN 31.4: where the posting is and when its board says it was posted;
    # "" = unknown (a row from before the job page, or a writer that did not know).
    location: str = ""
    posted_at: str = ""


class ApplicationKit(BaseModel):
    """A batch-tailored draft and this job (PLAN 31.4: a kit is a tailored draft
    waiting on a job). `ApplicationDetail.pending_kit` names one nobody has
    decided yet (queued, running or done); `send_kit` names the approved one
    Comeet may still send the job's draft with."""

    id: int
    status: str


# The kinds of competition line a board states, in the one order the frontend
# mirrors (`Applicants.kind`). check-mirrors 87 reads this tuple with a LINE
# grammar: keep it one quoted entry per line.
APPLICANTS_KINDS: tuple[str, ...] = (
    "early",
    "over",
    "count",
)


class Applicants(BaseModel):
    """The BOARD's own competition line for a posting, read literally (Phase 32).

    LinkedIn's guest job page prints it in the top card ("Be among the first 25
    applicants", "131 applicants", "Over 200 applicants"); the page is the one
    `LinkedInProvider.fetch_description` already fetches, and
    `providers.linkedin.linkedin_applicants` reads it there, deterministically.
    No other registered board states a number (checked live 2026-09-27), so
    this is None on every other board, which is unknown, never zero.

    `kind` says which sentence it was: "early" (fewer than `n` so far, the
    board's "Be among the first n"), "over" (more than `n`, the board's cap),
    "count" (exactly `n`). `source` is the board that stated it ("linkedin"),
    so every surface names the board the READING names, never its own context,
    and a reading that names none is never shown. `read_at` is the instant of
    the fetch that read it (naive UTC ISO with "Z"), because the number only
    means something NOW: a reading older than `job_search.APPLICANTS_FRESH_S`
    is never shown, anywhere (`job_search.current_applicants`, the one rule)."""

    kind: str = ""  # early | over | count
    n: int = 0
    source: str = ""  # the board that stated it (a PROVIDERS name)
    read_at: str = ""


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
    source: str = ""
    # The template the tailored resume was SENT in ("" = a row from before
    # 17.3, which re-downloads in the default). ApplicationOut always carried
    # it and the detail did not, so the tracker's re-download rendered every
    # CV as the default template (PLAN 31.1/8).
    template: str = ""
    applied_at: Optional[str] = None
    last_email_at: Optional[str] = None
    last_email_kind: str = ""
    # Every email tied to this row, newest first.
    email_events: list[InboxEventOut] = Field(default_factory=list)
    # PLAN 31.4, the job page. The header's place and posted date ("" unknown);
    # the analysis "What they ask for" reads (None = none stored, and the page
    # then shows the posting itself, never a model call); the timeline's last
    # status change, which is ALL the row records of its history (who made it:
    # "created" / "manual" / "email", "" = before anyone recorded it); the
    # what-was-sent signals ApplicationOut carries; and a draft still on its way
    # or waiting for review.
    location: str = ""
    posted_at: str = ""
    jd: Optional[JDModel] = None
    status_changed_at: Optional[str] = None
    status_source: str = ""
    voice_score: Optional[float] = None
    fabrication_flag_count: Optional[int] = None
    pending_kit: Optional[ApplicationKit] = None
    # PLAN 31.4/5: the approved Comeet kit that may still send this job's draft
    # (`db/applications.sendable_kit`), so the job's page can offer the send the
    # Jobs page's Kits tab offered. None whenever the send would be refused on
    # the kit or on the draft (a count that is not exactly 0).
    send_kit: Optional[ApplicationKit] = None
    # PLAN 31.4/4: whether the review behind the draft is stored whole, so the
    # document can open it again (`GET /applications/{id}/review`). Kept out of
    # this answer on purpose: every page that reads a job would carry it.
    has_review: bool = False
    # Phase 32: the board's competition line for this posting, when the user's
    # search history holds a CURRENT reading of it (same posting, read within
    # `job_search.APPLICANTS_FRESH_S`). The row itself never stores it, and
    # viewing the page never fetches the posting to get one.
    applicants: Optional[Applicants] = None
    # 2026-09-28: the board's employment type for this posting, when the user's
    # search history holds it (the same match as `applicants`); "" otherwise. The
    # page labels it and, for Contract or Freelance, offers the proposal first.
    employment: str = ""


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
    # The two-value union `types.ts` already declares, so an invented role is a
    # shape 422 before the interview pass (P30-PASS-SIZE). It was a free string,
    # formatted into every prompt line as `ROLE: text` with no limit.
    role: Literal["interviewer", "candidate"] = "interviewer"
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


class GeoRestriction(BaseModel):
    """A geographic hiring restriction LITERALLY stated in the posting (the
    worldwide-remote fix). Deterministic detection only — never an LLM, never
    the network; see app/core/geo_restriction.py. `raw` is the verbatim
    sentence the UI quotes.

    This can say a posting STATES a restriction. It can never say the user can
    or cannot work the role — the sponsorship question usually lives in the
    application FORM, not the body. No `confidence` field: a confidence number
    would be a second clock and an unearned one, since the module either
    matched a sentence or it did not."""

    kind: str = ""  # work_auth | citizenship | clearance | residency | title_tag | region | payroll | onsite | residency_state
    scope: str = ""  # us | uk | eu | il_excluded | other
    place: str = ""  # verbatim place fragment; "" when unnamed. NEVER render alone.
    blocking: bool = False  # Tier 1 — filtered before the scoring LLM call
    raw: str = ""  # the matched sentence, whitespace-normalised, <= 240 chars


class GhostSignal(BaseModel):
    """One reason to suspect a posting is not a live vacancy. Evidence, never a
    verdict.

    One signal is one thing the posting SAYS (`raw`, its own sentence) or one
    thing our own sighting history COUNTS (`days`, measured from `since` on the
    basis named in `basis`). It is never a probability and never a score — see
    GhostReport for why there is no confidence number anywhere in this pair.

    `days` / `since` / `basis` are `long_open` only, and `basis` names two
    different truths that must never be printed with the same sentence:
    "first_published" is the BOARD's own first-publish date, while "first_seen"
    is only a LOWER bound — the day one of our own searches first happened to
    see it, which says nothing about the days before that."""

    kind: str = ""      # closed | evergreen | long_open | reposted
    strength: str = ""  # certain | strong | weak
    raw: str = ""       # the posting's own sentence, whitespace-normalised, <= 240 chars
    days: int = 0       # long_open only
    since: str = ""     # long_open only: ISO date the count is measured from
    basis: str = ""     # long_open only: "first_published" | "first_seen"


class GhostReport(BaseModel):
    """What the deterministic ghost check found. NO confidence field, for the reason
    GeoRestriction's docstring gives.

    Deterministic detection only — never an LLM, never the network; see
    app/core/ghost_signals.py.

    This can say a posting SAYS it is a talent pool, that it has been visible
    for N days, that it reappeared under a new listing id, or that the board
    says it is no longer accepting applications. It can NEVER say that nobody
    is hiring: a genuine vacancy can sit open for months, a company reposts a
    live role when the first listing expires, and a talent-pool ad has produced
    real interviews. Every signal is a label on the TEXT and on our own
    sightings, which is why the UI quotes `raw` and counts rather than asserting
    a verdict.

    None — not an empty report — is what "nothing fired" looks like, and it
    means the classifier abstained, never that the posting is real. No
    `confidence` field, for GeoRestriction's reason plus one of its own:
    `strength` is a TUNED label, not a measured rate, so a number beside it
    would be a second clock reading an unmeasured quantity."""

    closed: bool = False   # a CERTAIN signal — filtered before the scoring LLM call
    likely: bool = False   # >= 1 strong, or >= 2 weak. One rule, pinned.
    signals: list[GhostSignal] = Field(default_factory=list)


class FilteredJob(BaseModel):
    """A posting removed before scoring — because it states a Tier-1 restriction,
    because the board says it is closed, or because it came from the worldwide
    pass and its location names a country where pay is well below Israel's —
    returned so the removal is VISIBLE and appealable rather than silent.
    `reason` says which.

    Deliberately carries no scores — it was never scored, and a zero would be a
    fabricated number."""

    title: str = ""
    company: str = ""
    location: str = ""
    url: str = ""
    source: str = "linkedin"
    posted_at: str = ""
    logo_url: str = ""
    geo_restriction: Optional[GeoRestriction] = None
    # Why this posting was removed. Defaults to "restriction" so every
    # pre-Phase-28 caller and every stored row stays honest. A row that predates
    # the field means "restriction", which is TRUE — this repo's "unknown is
    # never zero" rule, applied where the old value genuinely is known.
    #
    # "market" (Phase 30 J): a worldwide-origin posting whose location names a
    # country where pay is well below Israel's (`app.core.pay_market`). Its
    # evidence is `location` itself, and `geo_restriction` and `ghost` stay None:
    # it was hidden before selection, so it was never fetched and neither of
    # those classifiers ran.
    #
    # "work_mode" (2026-09-22): the posting states only work modes the user did not
    # pick. "not_remote": a WORLDWIDE-origin posting that does not say it is
    # remote, which is the whole promise of the worldwide pass. Both are read from
    # the posting's own words after it was fetched (`app.core.work_mode`), so the
    # evidence is `work_modes` and `work_mode_evidence`, and the posting cost no
    # model call.
    reason: str = "restriction"  # restriction | closed | market | work_mode | not_remote
    # The evidence behind reason == "closed" — the board's own words, or the
    # status it answered with. None when the removal was a restriction.
    ghost: Optional[GhostReport] = None
    # The evidence behind "work_mode" and "not_remote": the modes the posting
    # states, in WORK_MODES order (empty when it says nothing, which only
    # "not_remote" can be), and the words that said so.
    work_modes: list[str] = Field(default_factory=list)
    work_mode_evidence: str = ""


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
    # The earliest date a BOARD stated for this role: this card, an earlier
    # listing of the same source + title|company in the current sighting run,
    # or Greenhouse `first_published` (`ghost_signals.earliest_board_date`,
    # returned verbatim). Equal to `posted_at` when nothing earlier is known;
    # "" means unknown. Never `first_seen_at`, which is our own lower bound and
    # not a date any board stated.
    first_posted_at: str = ""
    # The card dates of other listings of this role on the same board that the
    # search folded into this one (`JobHit.twin_posted`), so `record_sightings`
    # keeps the earliest of them. Internal: EXCLUDED from every dump, so it
    # never reaches a response, a stream frame or the history.
    twin_posted_at: list[str] = Field(default_factory=list, exclude=True)
    # The work modes the posting itself STATES, in WORK_MODES order, read by
    # `app.core.work_mode` from its own words (and Comeet's field); [] when it
    # says nothing, which is unknown, never "on-site". Never the search's picks.
    work_modes: list[str] = Field(default_factory=list)
    source: str = "linkedin"  # which job board this came from (see PROVIDERS registry)
    logo_url: str = ""  # company logo from the board; empty when it has none
    also_on: list[AlsoOn] = Field(default_factory=list)  # this posting on other boards
    salary: Optional[SalaryInfo] = None  # only when literally stated in the posting
    # A hiring restriction the posting STATES (see GeoRestriction). Derived on
    # read from jd_text, never stored — so re-tuning the detector reclassifies
    # every posting with no migration. None means "nothing stated", which is
    # NOT the same as "open to you".
    geo_restriction: Optional[GeoRestriction] = None
    # Reasons to suspect this is not a live vacancy (see GhostReport). Derived
    # on read from the posting text + our sightings, NEVER stored on
    # job_search_hits — so re-tuning the rules reclassifies every posting with
    # no migration. Same as geo_restriction. None means "nothing fired", which
    # is NOT the same as "this vacancy is real".
    ghost: Optional[GhostReport] = None
    # Older than the search's max_age_days window. Set by the tiering from the
    # CARD date (selection: kept because the title matches the searched
    # keywords, PLAN 15.6), and after selection from `first_posted_at` (label
    # only: a relisted role is older even when its relist is fresh). The UI
    # shows an "Older" badge and the alert email an "Older posting" chip.
    stale: bool = False
    # The board's own competition line (see Applicants), read at the fetch this
    # search already made, or carried from the history row a cached posting was
    # rebuilt from; None when the board states none, when the posting was not
    # fetched, and when the reading is older than a day.
    applicants: Optional[Applicants] = None
    # The BOARD's own employment type when it is not plain full-time, one of
    # `app.core.employment.EMPLOYMENT_TYPES`; "" for full-time, not stated or not
    # read, alike. Never read from the title (2026-09-28).
    employment: str = ""
    # Tracker status when this posting is already in the user's tracker
    # ("saved" | "applied" | "interview" | "offer" | "rejected"), else "".
    # Carries the status rather than a bool so the card can say WHICH — "saved"
    # is a job to come back to, "applied" is one to stop re-reading.
    application_status: str = ""
    # That tracker row's id, stamped with the status, so the card's saved icon
    # opens the job's own page (PLAN 31.4/6); None when the posting is untracked.
    application_id: Optional[int] = None


class JobMatchResult(BaseModel):
    matches: list[JobMatch] = Field(default_factory=list)


# The work modes a search can ask for, in the ONE order a stored `work_mode` is
# written in: "remote,hybrid", never "hybrid,remote", so two ways of picking the
# same modes are one value (the Jobs page's dirty check and every saved alert
# compare it as a string). `app.core.work_mode` answers in the same three words.
WORK_MODES: tuple[str, ...] = ("remote", "onsite", "hybrid")


def work_modes(value: object) -> tuple[str, ...]:
    """The modes a `work_mode` value selects, in WORK_MODES order. () means ANY:
    "any", "", junk, or every mode at once (all three is no filter at all).
    Unknown words are dropped, so "remote,foo" is "remote" and a value this build
    has never heard of degrades to no filter, never to an error."""
    picked = {part.strip() for part in value.split(",")} if isinstance(value, str) else set()
    modes = tuple(m for m in WORK_MODES if m in picked)
    return () if len(modes) == len(WORK_MODES) else modes


class SearchContext(BaseModel):
    """What/where to search. Blank fields mean 'derive from resume'."""

    job_title: str = ""
    # Extra search keywords: when non-empty this is the canonical list of
    # titles/keywords (each queried separately per board, results merged) and
    # job_title mirrors the first entry so old clients keep working.
    job_titles: list[str] = Field(default_factory=list)
    location: str = ""
    # "any", or a comma list of WORK_MODES in that order ("remote,hybrid"). One
    # string rather than a list, ON PURPOSE: this model is serialised into
    # `job_alerts.context_json` and every saved alert holds a single word here,
    # which `_canonical_work_mode` reads back as itself. It filters by what each
    # posting SAYS (`app.core.work_mode`): LinkedIn's own `f_WT` is still sent and
    # is ignored by its logged-out search (measured 2026-09-22).
    work_mode: str = "any"
    limit: int = 10  # jobs to fetch + score (1-25), shared across all sources
    # Which job boards to search. Validated against the provider registry in
    # job_search._resolve_context: unknown names are ignored, and an empty /
    # all-unknown list falls back to every registered provider — so old clients
    # that never send `sources` keep working, and new boards join automatically.
    sources: list[str] = Field(default_factory=list)
    # Only surface postings at most this many days old (0 = any age). LinkedIn
    # applies it server-side (f_TPR); every board is also filtered in the
    # fan-out against JobHit.posted_at, keeping hits with no known date. A
    # date-only posted string counts its whole day (`job_search.posted_within`).
    max_age_days: int = 30
    # Worldwide-remote opt-in: when the work modes include "remote" (or are
    # "any"), ALSO search the US, the UK and the EU (see
    # job_search.WORLDWIDE_REMOTE_LOCATIONS) on the boards with global reach
    # (LinkedIn; and since 2026-09-28 Himalayas, Jobicy and We Work Remotely, asked
    # only here, for remote jobs open to people in Israel). A posting from those queries is kept only when it SAYS it is
    # remote (reason "not_remote" otherwise): LinkedIn's remote filter is ignored
    # by its logged-out search, so the query alone returns on-site jobs abroad.
    # Local Israeli boards are never queried with those locations, and the flag
    # is inert when "remote" is not among the modes. The EU query
    # returns every member state, so a worldwide posting whose location names a
    # country where pay is well below Israel's is hidden before selection
    # (`app.core.pay_market`) and returned in `JobSearchResult.filtered` with
    # reason "market".
    include_worldwide: bool = False

    @field_validator("work_mode", mode="before")
    @classmethod
    def _canonical_work_mode(cls, value: object) -> str:
        """Every door writes the same value: a search, the saved picks, an alert's
        stored JSON. A legacy single word reads back as itself, so no saved alert
        changes on deploy."""
        return ",".join(work_modes(value)) or "any"


class SearchPrefs(BaseModel):
    """The user's saved 'Customize search' picks (GET/PUT /jobs/search-prefs) —
    prefill for the Jobs page so a returning user doesn't re-enter everything.
    context=None means nothing saved (or cleared)."""

    context: Optional[SearchContext] = None


class HiddenJobs(BaseModel):
    """What the user said "Not for me" to (PLAN 31.5/4), GET/PUT /jobs/hidden:
    postings by URL, companies, and words in a job title. Applied to every
    search BEFORE selection by `app/core/hidden_jobs.py`; stored on the user row
    (`users.hidden_jobs_json`), user content, cleared by both privacy doors. NOT
    a `SearchContext` field, which is serialised into every saved alert (the
    geo section's rule). Bounded per list and per entry, since a PUT replaces
    the whole set and every search reads it."""

    model_config = {"extra": "forbid"}

    urls: list[str] = Field(default_factory=list, max_length=300)
    companies: list[str] = Field(default_factory=list, max_length=200)
    title_words: list[str] = Field(default_factory=list, max_length=100)

    @field_validator("urls", "companies", "title_words")
    @classmethod
    def _bounded(cls, values: list[str], info) -> list[str]:  # noqa: ANN001
        cap = {"urls": 300, "companies": 100, "title_words": 40}[info.field_name]
        if any(len(v) > cap for v in values):
            raise ValueError(f"each entry is at most {cap} characters")
        return values


class HiddenRow(BaseModel):
    model_config = {"extra": "forbid"}

    url: str = Field(default="", max_length=2048)
    company: str = Field(default="", max_length=300)
    title: str = Field(default="", max_length=500)


class HiddenWhichIn(BaseModel):
    """POST /jobs/hidden/which (PLAN 31.5/4): the rows a page is showing, so the
    SERVER says which the user's hides now cover. The page never re-derives it:
    one matcher, one answer."""

    model_config = {"extra": "forbid"}

    rows: list[HiddenRow] = Field(default_factory=list, max_length=100)


class HiddenWhichOut(BaseModel):
    hidden: list[bool] = Field(default_factory=list)  # one per row, in order


class SearchContextRequest(BaseModel):
    resume: ResumeModel


class SearchQueryIn(BaseModel):
    """POST /jobs/search-query (Phase 32): one line in plain words, Hebrew or
    English. Bounded by BYTES in the route (413, kind "query"), like every text
    a user writes that can reach a prompt."""

    model_config = {"extra": "forbid"}

    query: str


class SearchQueryOut(BaseModel):
    """What the line said, in the search form's OWN fields (app/core/search_query.py).
    Empty means the line did not say it, and the page leaves that field alone.
    Not a SearchContext: "" and "any" mean different things here, and nothing
    in it is ever stored or sent to the cron."""

    job_titles: list[str] = Field(default_factory=list)
    location: str = ""
    # "" unsaid; else "any" or a comma list in WORK_MODES order ("remote,hybrid").
    work_mode: str = ""
    include_worldwide: bool = False
    # Words read and deliberately not used as a filter, each said by the page:
    # "region" (searching all of Israel), "experience", "places" (one at a time).
    notes: list[str] = Field(default_factory=list)
    used_model: bool = False


SEARCH_MODES = ("jobs", "freelance")


class JobSearchRequest(BaseModel):
    resume: ResumeModel
    customize: Optional[SearchContext] = None  # None => fully automatic
    # The Jobs page's mode (2026-09-28, freelance part 3): "freelance" keeps only
    # postings whose board says contract or freelance (`job_search.search_jobs`,
    # `freelance=`). A request field, not a SearchContext one: the context is what
    # the page's form holds and alerts store, and neither changes with the mode.
    mode: Literal["jobs", "freelance"] = "jobs"


class JobSearchResult(BaseModel):
    context: SearchContext = Field(default_factory=SearchContext)  # what was actually searched
    matches: list[JobMatch] = Field(default_factory=list)
    skipped: int = 0  # listings found but not fetchable/scorable
    # Postings found but deliberately NOT scored, returned rather than silently
    # discarded so the user can see the count, read the sentence we fired on,
    # and reveal them. Five reasons, and `FilteredJob.reason` says which: a
    # Tier-1 hiring restriction stated abroad, a board that says the posting is
    # no longer accepting applications, a worldwide posting whose location
    # names a country where pay is well below Israel's, a posting that states
    # only work modes the user did not pick, or a worldwide posting that does
    # not say it is remote. NOT part of `skipped`,
    # whose user-facing string means "not fetchable/scorable" — a filtered
    # posting was fetchable, and folding any reason into it is exactly what
    # this list exists to prevent. ONE list, never a second one per reason: two
    # lists fragment the same idea and every caller has to remember both.
    filtered: list[FilteredJob] = Field(default_factory=list)
    # Provider name -> user-facing error for boards that FAILED (blocked,
    # unreachable, misconfigured) while others succeeded. Boards that answered
    # fine but had zero matching jobs land in `source_empty` instead — the UI
    # must not present an empty query as an outage. If ALL sources fail the
    # search raises instead, so a 200 always carries at least one match.
    source_errors: dict[str, str] = Field(default_factory=dict)
    source_empty: dict[str, str] = Field(default_factory=dict)
    # How many postings the user's own "Not for me" hid before selection (PLAN
    # 31.5/4). A count, said on the page, never folded into `skipped` or
    # `filtered`: the user chose these, and the page offers the list back.
    hidden: int = 0
    # How many JOBS the user already applied to were left out before selection
    # (Phase 32, `app/core/applied_jobs.py`): the tracker holds them at applied,
    # interview, offer or rejected. A count of jobs, not of board hits, said on
    # the page and never folded into `skipped`, `filtered` or `hidden`.
    applied: int = 0
    # A freelance search only (`JobSearchRequest.mode`): how many postings were
    # left out because their board says they are not contract or freelance work
    # (full-time, part-time, temporary, an internship, or no type stated), before
    # selection on the card and after the fetch on LinkedIn's page. 0 otherwise.
    not_freelance: int = 0


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
    # The earliest date a board stated for the role, as stored (see
    # JobSearchHit.first_posted_at); "" when unknown. Equal to `posted_at` unless
    # an earlier date is known, the identity rule `JobMatch.first_posted_at` keeps.
    first_posted_at: str = ""
    source: str = "linkedin"  # which job board surfaced this hit
    logo_url: str = ""  # company logo from the board; empty when it has none
    also_on: list[AlsoOn] = Field(default_factory=list)  # this posting on other boards
    salary: Optional[SalaryInfo] = None  # extracted on read from the stored jd_text
    # The board's competition line as stored, handed back only while CURRENT
    # (`job_search.current_applicants`, measured on this request's clock); None
    # for a reading older than a day, which the row keeps until a fetch replaces it.
    applicants: Optional[Applicants] = None
    # The board's employment type as the row stored it (see JobMatch.employment).
    employment: str = ""
    searched_at: str = ""
    app_status: str = ""  # tracker status if this job was saved/applied ("", saved, applied, interview, offer, rejected)
    app_id: Optional[int] = None  # that tracker row's id, which the row opens (PLAN 31.4/6); None when untracked


class JobSearchHistory(BaseModel):
    hits: list[JobSearchHitOut] = Field(default_factory=list)
    # Saved rows left out because the user hid them since (PLAN 31.5/4).
    hidden: int = 0
    # Saved rows left out because the user has applied to them since (Phase 32).
    applied: int = 0


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
class ATSXrayRequest(BaseModel):
    resume: ResumeModel
    template: str = ""  # "" falls back to the default, like every render call
    fmt: str = "pdf"  # pdf | docx


class CoverageRequest(BaseModel):
    """Live keyword coverage for a resume the user is editing.

    Takes an ANALYSED `JDModel`, never raw `jd_text`. The route is uncapped, and
    a route that accepted job-ad text would have to run `analyze_jd` to do
    anything with it — which is an LLM call, which would make an uncapped route
    a free door onto the model. The caller analyses the posting once, on a
    capped route, and re-scores against the result as often as it likes.
    """

    resume: ResumeModel
    jd: JDModel


class CoverageResult(BaseModel):
    """The deterministic half of the match score, on its own.

    Deliberately NOT the whole `Score`: `fit_score` is an LLM sample and
    `overall` blends the two, so returning either here would let a caller
    animate a number that only a paid call can honestly move.
    """

    keyword_coverage: float = 0.0  # 0-100
    gaps: list[GapItem] = Field(default_factory=list)
    covered: int = 0  # keywords fully matched
    partial: int = 0
    missing: int = 0
    total: int = 0  # deduped JD keywords + hard skills


class FitCheckRequest(BaseModel):
    resume: ResumeModel
    jd_text: str


class FitCheckResult(BaseModel):
    """Both halves of the match, from ONE LLM round-trip, before any tailoring.

    "Check fit" cannot be free, and pretending otherwise would be the exact
    dishonesty this surface exists to remove: coverage needs `jd.keywords`, and
    the only thing that produces those is `analyze_jd` — a model call. So it
    costs a model call either way, and this spends it on the better call: the
    JD_FIT task returns the analysed JD *and* the fit reading together, where
    `analyze_jd` alone would return half as much for the same price.

    It is one monthly use, and that use buys the tailor too (Phase 30 / B4.4,
    OD-1): a fit check opens a 24-hour ride for ONE tailor of the `jd` it
    returns, so checking fit and then tailoring that job costs 1, not 2. A fit
    check with no tailor still costs 1. `tailor_included_until` is when the cover
    ends (ISO UTC), "" for a caller with no monthly limit.

    The analysed `jd` comes back so the caller can tailor with it, which is also
    the key the ride is held under (`TailorRequest` carries no posting text), and
    can re-score coverage against it for free on `/tools/coverage` as often as it
    likes.

    No `overall`: it blends a live deterministic half with a frozen LLM sample.
    And no `fit_before`/`fit_after` — two samples at temperature 0.3 are not a
    measurement of improvement.
    """

    jd: JDModel
    keyword_coverage: float = 0.0
    fit_score: float = 0.0
    rationale: str = ""
    gaps: list[GapItem] = Field(default_factory=list)
    covered: int = 0
    partial: int = 0
    missing: int = 0
    total: int = 0
    # ISO UTC end of the tailor ride this fit check opened; "" when exempt (B4.4).
    # Kept for a tab loaded before `tailor_expires_in_s` existed; the client reads that.
    tailor_included_until: str = ""
    # Seconds the ride has left as this response is built; 0 when exempt. Relative
    # on purpose, like CoverLetterResponse.expires_in_s: the absolute instant,
    # compared with a phone clock that runs ahead, ended the included tailor early,
    # and at 0 uses left that disabled a Tailor the server would still cover.
    tailor_expires_in_s: int = 0


class PageImagesRequest(BaseModel):
    """POST /render/pages: the real PDF as page pictures, for a phone (PLAN
    31.2/4). The same two fields as a render. `extra="forbid"`: the route is
    uncapped and reaches no model, so a field it does not read is refused
    rather than quietly ignored (the deterministic-routes rule)."""

    model_config = {"extra": "forbid"}
    resume: ResumeModel
    template: str = ""  # "" falls back to the default, like every render call


class PageImagesResult(BaseModel):
    """The pages of the file the download would produce, as base64 PNG, in
    order. `total` is the file's page count, which can exceed `len(pages)`
    (the pictures stop at `page_images.MAX_PAGES`), so the view can say the
    rest are in the download rather than drop them without a word."""

    pages: list[str]
    total: int
    template: str = ""  # the RESOLVED id; "" only on a model built without one


class PageCountRequest(BaseModel):
    resume: ResumeModel
    template: str = ""  # "" falls back to the default, like every render call


class PageCountResult(BaseModel):
    """A live page measurement for a resume the user is editing.

    Deliberately NOT `LengthReport.pages_after`: that number is measured on
    whatever template the tailor happened to use (`TailorRequest` carries none,
    so always the default) and is not re-measured after the humanizer pass, so
    it can describe a document nobody will download. This one measures what the
    user is actually about to click.
    """

    pages: int = 1
    max_pages: int = 2
    hard_max_pages: int = 3
    template: str = ""  # the resolved spec id, echoed back


# --------------------------------------------------------------------------- #
# ATS X-ray (PLAN 21.7) — render the resume, read it back as a parser does
# --------------------------------------------------------------------------- #
class ATSXrayFact(BaseModel):
    # Stable ids the UI translates: name | email | phone | location | linkedin |
    # headline | title | employer | dates | bullet | institution | degree |
    # military | certification | skill | language
    kind: str
    value: str
    # clean    — recovered whole, on one line
    # split    — every word survived but the fact wrapped across lines
    # polluted — recovered, but sharing its line with text from the other column
    # missing  — the parser did not get it back at all
    status: str = "clean"
    line: str = ""  # the extracted line it landed on
    collided_with: str = ""  # the sidebar value glued onto it, when polluted


class ATSXrayResult(BaseModel):
    template: str = ""
    fmt: str = "pdf"
    pages: int = 1
    two_column: bool = False
    # Set when the user asked for a DOCX of a two-column template: the Word file
    # is really this single-column sibling, so the X-ray says which.
    docx_fallback: str = ""
    text: str = ""  # exactly what the parser recovered, verbatim
    facts: list[ATSXrayFact] = Field(default_factory=list)
    clean: int = 0
    split: int = 0
    polluted: int = 0
    missing: int = 0


# --------------------------------------------------------------------------- #
# The CV scan (POST /tools/scan: signed in, deterministic only — PLAN 6, Phase 30 / A2)
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


# The short fields a tool request carries into a prompt: a company, a role, a
# person's name, one of a closed set of stages or recipient types. Bounded at the
# SCHEMA (a 422 before the handler), not in bytes by the prompt guard: each is one
# line a person types or a value the UI picks, and the longest the app itself
# stores for one is the tracker's String(255) job title and company, which the
# follow-up writer is handed from a card. So 300 characters refuses nothing real,
# and 100 for a closed set whose longest member is "hiring manager".
SHORT_FIELD_MAX = 300
CHOICE_FIELD_MAX = 100


class FollowUpRequest(BaseModel):
    company: str = Field(default="", max_length=SHORT_FIELD_MAX)
    role: str = Field(default="", max_length=SHORT_FIELD_MAX)
    stage: str = Field(default="after applying", max_length=CHOICE_FIELD_MAX)
    # Free text the user types: measured in bytes by the prompt guard instead
    # (kind "note"), so a refusal has a sentence rather than a bare 422.
    context: str = ""


class FollowUpResult(BaseModel):
    subject: str = ""
    body: str = ""


# --------------------------------------------------------------------------- #
# Outreach Studio — recruiter / hiring-manager / referral messages that bypass
# the ATS. Grounded only in real resume facts (no fabrication guard needed —
# it's not a resume — but the prompt enforces the same honesty rule).
# --------------------------------------------------------------------------- #
class OutreachRequest(BaseModel):
    resume: ResumeModel
    jd_text: str = ""
    company: str = Field(default="", max_length=SHORT_FIELD_MAX)
    job_title: str = Field(default="", max_length=SHORT_FIELD_MAX)
    contact_name: str = Field(default="", max_length=SHORT_FIELD_MAX)
    contact_role: str = Field(default="recruiter", max_length=CHOICE_FIELD_MAX)  # recruiter | hiring manager | connection


class OutreachResult(BaseModel):
    connection_note: str = ""  # LinkedIn connection request, ≤300 chars
    inmail_subject: str = ""
    inmail_body: str = ""  # longer InMail / cold email
    referral_message: str = ""  # ask a 1st-degree contact for a referral


# --------------------------------------------------------------------------- #
# Screening-question answerer — honest, resume-grounded answers to application
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
    company: str = Field(default="", max_length=SHORT_FIELD_MAX)
    url: str = ""  # company about/careers/team page to fetch (optional)
    # Pasted page text (alternative to url): the user's own paste, so it is
    # REFUSED in bytes by the prompt guard (kind "page"), never clipped.
    page_text: str = ""
    jd_text: str = ""  # optional target JD for context
    job_title: str = Field(default="", max_length=SHORT_FIELD_MAX)  # optional target role for the reach-out message


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
    talking_points: list[str] = Field(default_factory=list)  # resume ↔ company fit
    people: list[BriefPerson] = Field(default_factory=list)  # founders/managers/recruiters
    targets: list[BriefTarget] = Field(default_factory=list)  # role-aware hiring-chain links (PLAN 11.7)
    company_people_url: str = ""  # the company's LinkedIn People tab, when the page linked it
    hiring_emails: list[str] = Field(default_factory=list)  # careers@/jobs@/hr@ found on the page
    outreach_subject: str = ""
    outreach_message: str = ""  # short reach-out to the top person (resume-grounded)
    grounded: bool = False  # True when a company page was actually fetched/pasted


# --------------------------------------------------------------------------- #
# The resume review (PLAN 28.6) — one home for every check, each finding
# anchored to the block it is about.
#
# This supersedes ATSScanResult and ResumeHealthResult, and the shape change is
# the point of it. Those two answered with a SCORE and a list of English
# sentences: a number the user could optimise instead of a document they could
# fix, and prose no Hebrew reader could read. A finding here carries a stable
# `id` (which is the translation key) and a `path` (which is where it IS), so
# the panel can point at the paper and say it in either language.
# --------------------------------------------------------------------------- #
class ReviewFinding(BaseModel):
    """One thing to fix, anchored to the block it is about.

    `path` is a BLOCK PATH the document resolves through `lib/resumeBlocks.ts`
    (`@exp.2.b.1`, `@summary`, `@skills.<verbatim text>`, `@edu.0`), or `""`
    for a document-level finding that belongs to no single block. The grammar
    is a MIRROR — Python emits it here, TypeScript resolves it, and
    check-mirrors 26 holds `resume_review.PATH_SHAPES` and `BLOCK_PATTERNS`
    identical — because a shape only one side knows is a review row that jumps
    nowhere, silently, on the one surface whose whole promise is that it points.

    `severity` is `bad` (fix) or `warn` (consider). There is deliberately no
    `good`: a check that ran and found nothing is an id in `ReviewResult.passed`,
    not a finding, so the panel can never fill with reassurance the user has to
    read past to reach the three rows that matter.

    `raw` is the offending text VERBATIM and it is a PREVIEW, not the anchor
    (`path` is) — capped at 240 characters so one pathological bullet cannot
    push the real findings off the panel.

    `args` interpolates the how-text (`{"suggested": "Mar 2020"}`), which is
    what lets one translated sentence carry a measurement. Values are `str` or
    `int` ONLY: a float renders as `3.0999999` in one locale and `3,1` in
    another, and this route is uncapped, so a serialisation error here is a 500
    on a free door.
    """

    id: str  # stable check id; the UI renders doc.review.checks.<id>.{label,how}
    severity: str = "warn"  # bad (fix) | warn (consider) — "good" is not a finding
    path: str = ""  # a block path the document can resolve, or "" for document-level
    raw: str = ""  # the offending text, verbatim, <= REVIEW_RAW_CAP chars
    args: dict[str, str | int] = Field(default_factory=dict)


class ReviewResult(BaseModel):
    """What the deterministic review found on the document as it stands.

    Three lists, and the third is the whole point. `passed` ran and found
    nothing; `skipped` COULD NOT run — the gap check needs two dated spans, the
    JD-gated check needs a job — and unknown is never shown as clean, the same
    rule the tracker's nullable `voice_score` and the alert bar's
    `last_above_min` follow. Folding `skipped` into `passed` would have the
    panel assert a resume is clean on a check that never looked at it.

    Every check always runs, so `passed ∪ skipped ∪ {f.id for f in findings}`
    is the entire `CHECK_IDS` set on every call: there are no toggles, and
    therefore no way for an empty result to mean "you turned that one off".

    It carries NO SCORE on purpose. A number invites the user to optimise it,
    and these checks are advice about a document, not a measurement of one.
    """

    findings: list[ReviewFinding] = Field(default_factory=list)
    passed: list[str] = Field(default_factory=list)  # ran, found nothing
    skipped: list[str] = Field(default_factory=list)  # COULD NOT run — unknown, never clean


class ReviewRequest(BaseModel):
    """Body of `POST /tools/review`.

    Takes an ANALYSED `jd` or `None`, never raw job-ad text — the
    `/tools/ats-scan` cautionary tale in CLAUDE.md, which is the whole reason
    this route can be uncapped: a route that accepted job-ad text would have to
    reach the model to use it, and an uncapped door onto the model is exactly
    what that rule exists to prevent.

    `extra="forbid"` for the reason the deleted `ATSScanRequest` carried it —
    that model went with `ats_scan.py`, so the reasoning lives here now: without
    it a stale caller sending `jd_text` gets a silent JD-less review, and one
    check quietly lands in `skipped` for ever with nothing saying why.
    """

    model_config = {"extra": "forbid"}

    resume: ResumeModel
    jd: JDModel | None = None


class ReviewRewrite(BaseModel):
    """One model-suggested rewording of a real bullet.

    `before` is copied VERBATIM out of the resume, and that exact match is what
    yields `path` — a rewrite whose `before` matches no bullet is dropped
    server-side rather than shown, because "Use this" writes through the same
    block path as every other edit on this surface and a path nothing produced
    would write into the wrong line.
    """

    path: str  # the bullet `before` was matched at
    before: str  # a real bullet, verbatim
    after: str  # same facts, stronger wording, no new claims


class ReviewRewriteResult(BaseModel):
    """The rewrite batch, plus what the guards refused.

    `dropped` is reported rather than swallowed: a guard that fires silently is
    the 21.7 failure mode, and "we asked for five and are showing you two" is a
    fact the user can act on. `dropped_reasons` are backend-authored English
    fragments, so the COUNT is the user-facing part and the reasons are for
    diagnostics — the treatment `LengthReport.notes` already gets.

    `rewrites: []` with `dropped: 0` means the model returned nothing worth
    offering, which is NOT the same as "every bullet is already strong".
    """

    rewrites: list[ReviewRewrite] = Field(default_factory=list)
    dropped: int = 0  # refused by a guard, not by the model
    dropped_reasons: list[str] = Field(default_factory=list)


class ReviewRewriteRequest(BaseModel):
    """Body of `POST /tools/review/rewrites` — the one part of the review that spends.

    `paths` picks which bullets to ask about; `[]` means "choose the rewritable
    findings server-side", which is what the panel sends. Capped server-side so
    a caller cannot turn one monthly use into an arbitrarily long prompt. A
    request with nothing to ask about costs no use at all (Phase 30 / B4.5).
    """

    model_config = {"extra": "forbid"}

    resume: ResumeModel
    paths: list[str] = Field(default_factory=list)
