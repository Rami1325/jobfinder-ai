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

// Israeli-resume sections (optional: older saved resumes predate them).
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

export interface SkillGroup {
  label: string;
  items: string[];
}

export interface ResumeModel {
  contact: Contact;
  /** Target-title line under the name; tailoring aims it at the JD. */
  headline?: string;
  summary: string;
  /**
   * The flat skill surface — always populated, and the only list anything
   * scores. When `skill_groups` is present the backend keeps this as the flat
   * union of every group's items, so nothing here is ever unscored or unshown.
   */
  skills: string[];
  /**
   * The same skills as the source CV grouped them ("AI & LLMs", "Backend &
   * Data"). Presentation only, and absent on older backends — empty means the
   * flat list is the whole story.
   */
  skill_groups?: SkillGroup[];
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
  hard_skills: string[]; // mandatory/required skills
  preferred_skills?: string[]; // nice-to-have skills; absent on older backends
  business_outcomes?: string[]; // outcomes the role drives; absent on older backends
  soft_skills: string[];
  keywords: string[];
  responsibilities: string[];
  qualifications: string[];
  language?: string; // "en" | "he" — detected server-side; absent on older backends
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

export interface VoiceIssue {
  category:
    | "banned_phrase"
    | "repeated_verb"
    | "repeated_phrase"
    | "outcome_clause"
    | "jd_echo"
    | "uniform_bullets";
  value: string;
  location: string;
  detail: string;
}

export interface VoiceReport {
  human_voice_score: number;
  jd_copy_pct?: number; // % of resume 5-word phrases copied from the JD
  issues: VoiceIssue[];
  fixed: VoiceIssue[];
  revised: boolean;
}

export interface CVPlan {
  positioning: string;
  lead_strengths: string[];
  emphasize: string[];
  downplay: string[];
  conservative_notes: string[];
  /**
   * Project curation, in priority order. The planner runs BEFORE the tailor
   * call, so these are an intent, not a record — the model can and does
   * contradict them. Read `drop_projects` only to describe what the plan said,
   * never to claim why something is missing.
   */
  select_projects?: string[];
  drop_projects?: string[];
}

/**
 * What the page budget had to do to fit the resume (app/core/length_budget.py).
 *
 * Only `dropped_projects` is safe to read. Its presence proves the budget cut a
 * project; its ABSENCE proves nothing, because `fit_to_pages` is handed the
 * model's already-curated output and early-exits when that output already fits.
 * `trimmed: false` therefore means *unknown*, never *nothing was cut* — the same
 * rule the tracker applies to its nullable columns. Page numbers here describe
 * whatever template the tailor measured (always the default) and are not
 * re-measured after the humanizer pass, so the UI takes them from a live
 * `POST /tools/page-count` instead.
 */
export interface LengthReport {
  pages_before: number;
  pages_after: number;
  max_pages: number;
  hard_max_pages: number;
  trimmed: boolean;
  dropped_projects: string[];
  notes: string[]; // hard-coded English fragments — never rendered
}

/** The deterministic half of the match score, on its own — recomputable for
 * free as often as the document changes. Deliberately carries no `fit_score`
 * and no `overall`: those need a model call, so a surface that could animate
 * them would be animating something it did not measure. */
export interface CoverageResult {
  keyword_coverage: number;
  gaps: GapItem[];
  covered: number;
  partial: number;
  missing: number;
  total: number;
}

/** Both halves of the match from ONE model round-trip, before any tailoring.
 * `jd` rides back so tailoring afterwards does not pay to read the same posting
 * twice. No `overall` and no before/after fit — see the backend docstring. */
export interface FitCheckResult {
  jd: JDModel;
  keyword_coverage: number;
  fit_score: number;
  rationale: string;
  gaps: GapItem[];
  covered: number;
  partial: number;
  missing: number;
  total: number;
  /** When the tailor this fit check paid for stops being included (ISO UTC); ""
   * for an account with no monthly limit. Check fit, then Tailor the same
   * analysed job, is 1 use (Phase 30 / B4.4). Absent on older backends. */
  tailor_included_until?: string;
}

/** A live page measurement for the document the user is about to download. */
export interface PageCountResult {
  pages: number;
  max_pages: number;
  hard_max_pages: number;
  template: string; // the resolved spec id, echoed back
}

export interface TailorResult {
  tailored_resume: ResumeModel;
  changelog: ChangeLogEntry[];
  covered_keywords: string[];
  fabrication_flags: FabricationFlag[];
  score_before: Score;
  score_after: Score;
  voice_report?: VoiceReport; // absent on results saved by older backends
  plan?: CVPlan | null;
  length_report?: LengthReport; // absent on results saved by older backends
}

/** POST /cover-letter: the letter, and the pass it rode (Phase 30 / B5). The
 * first letter for a posting uses 1 and opens a 24-hour pass for that analysed
 * job; changes to it ride the pass, up to 10 calls in all. The pass belongs to
 * one posting, so it travels here and never in /auth/me. Both pass fields are
 * absent on older backends. */
export interface CoverLetterResponse {
  cover_letter: string;
  /** ISO UTC end of this posting's pass; "" for an account with no monthly limit. */
  included_until?: string;
  /** Calls left on the pass after this one; 0 when exempt. */
  changes_left?: number;
}

export interface ResumeUploadResponse {
  resume: ResumeModel;
  ledger: FactsLedger;
}

export interface MasterResume {
  resume: ResumeModel;
  ledger: FactsLedger | null;
  label: string;
  language?: string; // "en" | "he" — one saved master per language; absent on older backends
  updated_at: string;
}

/** One restore point for the master resume (PLAN 20.8/N1). Metadata only — the
 * backend deliberately omits `resume` here so the picker stays light; fetch the
 * full version with `getResumeVersion` when one is opened. */
export interface ResumeVersion {
  id: number;
  label: string;
  language: string; // "en" | "he"
  created_at: string; // when this content STOPPED being current
  headline: string;
  experience_count: number;
  project_count: number;
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
  /** What was sent. "" / null means the row predates 17.3 — unknown, not zero. */
  template: string;
  voice_score: number | null;
  fabrication_flag_count: number | null;
  created_at: string;
  /** The inbox fields (Phase 29). All optional: a backend without the inbox
   * sends none of them, and every reader treats absent as unknown. */
  /** "email" when the inbox scanner created the row; "" for every other writer. */
  source?: string;
  /** When the application was SENT, with an explicit offset. null is unknown,
   * never "not sent": a row saved before the field existed, or one whose first
   * email was a rejection, has no date it was sent on. The card and the
   * analytics file a row under this and fall back to `created_at`
   * (`dateOfRecord`), so the two cannot disagree about which week it is in. */
  applied_at?: string | null;
  /** The newest email linked to this row. */
  last_email_at?: string | null;
  /** That email's kind (see `InboxEvent.kind`); "" when none is linked. */
  last_email_kind?: string;
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
  source?: string;
  applied_at?: string | null;
  last_email_at?: string | null;
  last_email_kind?: string;
  /** Every email the scanner tied to this row, newest first. Absent on a
   * backend without the inbox. */
  email_events?: InboxEvent[];
}

/** GET /inbox/status: whether this account can use Gmail sync, and how the
 * connection is doing.
 *
 * `ready` answers "may THIS account connect", not "is the feature built":
 * with the allowlist on, a user who is not on it reads `ready: false` with
 * `reason: "invite_only"`, and the UI says so in one line instead of offering a
 * Connect button that Google's own page would refuse. `ready: false` with any
 * other reason means the server has no Gmail set up at all, and the inbox UI
 * renders nothing.
 *
 * `status`, `provider` and `reason` are plain strings, not unions, for the
 * reason `GeoRestriction` gives: a newer backend value must not break the
 * build. */
export interface InboxStatus {
  ready: boolean;
  reason: string; // "invite_only" | "" — why `ready` is false
  google_ready: boolean; // false with `ready` true = only the demo mailbox exists
  connected: boolean;
  provider: string; // gmail | fake | ""
  email: string;
  status: string; // active | needs_reauth | error | ""
  last_sync_at: string | null; // explicit offset; null/"" = never synced
  auto_sync: boolean;
  backfill_days: number;
  review_count: number;
  events_total: number;
  /** The last run's failure. The connection stays "active" through an ordinary
   * failed run, so THIS is where one shows; a successful run clears it. */
  last_error_code: string;
  /** While Google keeps the app in testing it ends the grant every 7 days:
   * connected_at + 7d. null = no weekly expiry applies. */
  reauth_due_at: string | null;
  /** The server's GOOGLE_OAUTH_TESTING, so the connect screen can say the
   * 7-day reconnect BEFORE anyone connects. */
  oauth_testing: boolean;
  /** An import of past mail is still unfinished and the cron carries it on, so
   * "importing" holds on a later visit too, not only during the foreground
   * rounds that started it. */
  backfilling: boolean;
}

/** One email the scanner stored: the extraction, never the body.
 *
 * `kind` and `action` are plain strings for `GeoRestriction`'s reason; the UI
 * labels the values it knows and falls back to a neutral label for any other.
 *   kind:   confirmation | viewed | interview | assessment | offer | rejection | recruiter | other
 *   action: created | updated | linked | review | dismissed | undone
 * `prev_status`/`new_status` are tracker status keys, set on `updated`. */
export interface InboxEvent {
  id: number;
  received_at: string; // explicit offset
  from_name: string;
  from_email: string;
  subject: string;
  snippet: string;
  kind: string;
  company: string;
  job_title: string;
  confidence: number;
  method: string; // rule | llm
  interview_at: string;
  evidence: string; // a verbatim quote from the email, or ""
  application_id: number | null;
  action: string;
  prev_status: string;
  new_status: string;
  set_interviewed: boolean;
  created_at: string;
  gmail_url: string; // "" when the message has no Message-ID or is not in Gmail
}

/** POST /inbox/sync. Never an exception for a mailbox problem: a refused
 * refresh or a spent daily cap comes back in `error_code`. `has_more` means
 * this run stopped with mail still to read — the budget, not the mailbox, ran
 * out. */
export interface InboxSyncResult {
  user_id: number;
  scanned: number;
  noise: number;
  rule_hits: number;
  llm_calls: number;
  events: number;
  created: number;
  updated: number;
  review: number;
  has_more: boolean;
  error_code: string;
}

/** DELETE /inbox/connection. */
export interface InboxDisconnectResult {
  disconnected: boolean;
  events_deleted: number;
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
  top_matched?: string[]; // strongest covered JD keywords; absent on older backends
  top_gaps: string[];
  jd_text: string;
  url: string; // set for scraped listings; empty for pasted ones
  location: string;
  posted_at: string; // ISO date from the LinkedIn search card; empty when unknown
  // The earliest date a BOARD stated for the role (this card, an earlier listing
  // of it, or Greenhouse first_published), returned verbatim, so a string that
  // differs from `posted_at` IS an earlier date. Absent on older backends.
  first_posted_at?: string;
  source?: string; // provider id ("linkedin", "drushim", …); absent on older backends
  logo_url?: string; // company logo from the board; empty/absent when it has none
  also_on?: AlsoOn[]; // the same posting on other boards (cross-board dedupe)
  salary?: SalaryInfo | null; // only when literally stated in the posting
  geo_restriction?: GeoRestriction | null; // a hiring restriction the posting STATES
  // Reasons to suspect this is not a live vacancy. Derived on read from the
  // posting text + our own sightings, never stored — so re-tuning the rules
  // reclassifies every posting with no migration. Same as `geo_restriction`.
  ghost?: GhostReport | null;
  // Older than the search window: by the card date (kept for keyword relevance,
  // PLAN 15.6), or by `first_posted_at` when the role was listed earlier.
  stale?: boolean;
  // Tracker status when this posting is already in the tracker ("saved" |
  // "applied" | "interview" | "offer" | "rejected"); "" or absent when new.
  application_status?: string;
}
export interface AlsoOn {
  source: string;
  url: string;
}
/** A salary figure literally present in the posting (never an estimate). */
export interface SalaryInfo {
  min: number;
  max: number;
  currency: string; // ILS | USD | EUR | ""
  period: string; // hour | month | year | ""
  raw: string; // the verbatim snippet from the posting
}
/** A geographic hiring restriction the posting LITERALLY states (never an LLM
 * verdict, never an estimate). This says what the posting SAYS — it can never
 * say whether the user qualifies, which is why the UI quotes `raw`.
 * `kind` and `scope` are plain strings, not unions, so a newer backend value
 * cannot break the build. */
export interface GeoRestriction {
  kind: string; // work_auth | citizenship | clearance | residency | title_tag | region | payroll | onsite | residency_state
  scope: string; // us | uk | eu | il_excluded | other
  place: string; // verbatim place fragment; "" when unnamed — never render alone
  blocking: boolean; // true => the search dropped it before scoring
  raw: string; // the posting's own sentence
}
/** One reason to suspect a posting is not a live vacancy — evidence, never a
 * verdict. A signal is either something the posting SAYS (`raw`, its own
 * sentence) or something our own search history COUNTS (`days`, measured from
 * `since` on the basis named in `basis`).
 * `kind`, `strength` and `basis` are plain strings, not unions, for the reason
 * `GeoRestriction` gives above: a newer backend value must not break the build.
 * `days`/`since`/`basis` are `long_open` only, and `basis` separates two claims
 * that must never share a sentence — `first_published` is the BOARD's own date,
 * `first_seen` is only a lower bound (the day one of our searches first saw it,
 * which says nothing about the days before that). */
export interface GhostSignal {
  kind: string; // closed | evergreen | long_open | reposted
  strength: string; // certain | strong | weak
  raw: string; // the posting's own sentence; "" when the signal is a date, not a quote
  days: number; // long_open only
  since: string; // long_open only: ISO date the count is measured from
  basis: string; // long_open only: first_published | first_seen
}
/** What the deterministic ghost check found. No confidence number, for the
 * reason `GeoRestriction` gives — the module either matched or it did not.
 * Absent/null means nothing fired, which is NOT the same as "this vacancy is
 * real". `likely` is the backend's ONE pinned rule (>= 1 strong, or >= 2 weak)
 * and the UI must threshold on it rather than re-deriving one from `signals` —
 * a second gate answering the same question is how two surfaces end up
 * contradicting each other about the same posting. */
export interface GhostReport {
  closed: boolean; // a CERTAIN signal — the search dropped it before scoring
  likely: boolean; // >= 1 strong, or >= 2 weak
  signals: GhostSignal[];
}
/** A posting the search dropped BEFORE scoring — because it states a blocking
 * restriction, because the board says it is closed, or, for a worldwide
 * posting only, because its location names a country where pay is well below
 * Israel's. Carries no scores on purpose: it was never scored, and a zero would
 * be a fabricated number. A `market` row never took a result slot at all: the
 * pay filter runs before selection, so the job ranked below it took the slot. */
export interface FilteredJob {
  title: string;
  company: string;
  location: string; // for reason === "market" this IS the evidence
  url: string;
  source: string;
  posted_at: string;
  logo_url: string;
  geo_restriction?: GeoRestriction | null; // the evidence behind "restriction"; null for "market"
  // Why it was dropped. The backend defaults it to "restriction", so a response
  // that predates Phase 28 means "restriction" — which is TRUE, not unknown.
  // Test each reason BY NAME: a restriction is `!reason || reason ===
  // "restriction"`. The old reading, "anything not literally closed is a
  // restriction", became false when `market` arrived: it would label a posting
  // hidden for its country's pay with a hiring restriction it never stated. A
  // reason this build has never heard of is none of the three.
  reason?: string; // restriction | closed | market
  ghost?: GhostReport | null; // the evidence behind reason === "closed"; null for "market"
}
/** Multi-turn mock interview (PLAN 11.3) — stateless backend, the client
 * sends the whole transcript with every turn. */
export interface ChatTurn {
  role: "interviewer" | "candidate";
  text: string;
}
export interface InterviewChatResult {
  message: string;
  done: boolean;
}
export interface QuestionFeedback {
  question: string;
  feedback: string;
}
export interface InterviewScorecardResult {
  overall: number;
  summary: string;
  strengths: string[];
  improvements: string[];
  question_feedback: QuestionFeedback[];
}
export interface JobMatchResult {
  matches: JobMatch[];
}
export interface SearchContext {
  job_title: string;
  job_titles?: string[]; // multi-keyword search: each searched separately; job_title mirrors the first
  location: string;
  work_mode: string; // any | onsite | remote | hybrid
  limit: number;
  sources?: string[]; // provider ids to search ("linkedin", "drushim", …); absent on older backends
  max_age_days?: number; // only postings at most this old, 0 = any age; backend defaults to 30
  include_worldwide?: boolean; // remote/any opt-in: also search worldwide remote roles (US/UK/EU) on LinkedIn
}
export interface AlertSettings {
  enabled: boolean;
  email: string;
  context: SearchContext | null;
  last_run_at: string;
  last_new_count: number;
  last_error: string;
  smtp_configured: boolean;
  nudge_emails?: boolean; // PLAN 11.4 follow-up reminders; absent on older backends
  // Minimum fit a new posting needs to reach the inbox (0 = email everything).
  // Below-bar jobs are still recorded in search history — hidden from the
  // mail, not from the app.
  min_score?: number;
  // Of last_new_count, how many cleared the bar. null/absent = the last run
  // predates the bar and never measured it — NOT the same as 0, which means it
  // measured and nothing cleared. Render the pre-bar line for null.
  last_above_min?: number | null;
  // Phase 30 / B6.5: "monthly_limit" while this account's monthly uses are
  // spent, so the morning emails wait for the 1st; "" otherwise. Worked out when
  // the card is read, never from the last morning's skip. Absent on older backends.
  paused_reason?: string;
  // "YYYY-MM-DD", the day the mornings resume, while paused; "" otherwise.
  resumes_on?: string;
}
export interface AlertRunResult {
  ran: boolean;
  total: number;
  new_count: number;
  above_min?: number; // of new_count, how many cleared the fit bar
  emailed: boolean;
  error: string;
  // "monthly_limit" when a scheduled morning did not run for want of a use (ran
  // false, error empty); "" when the run was not skipped. Absent on older backends.
  skipped_reason?: string;
}
export interface JobSearchResult {
  context: SearchContext;
  matches: JobMatch[];
  skipped: number;
  // Postings dropped before scoring, one reason each (see FilteredJob.reason):
  // a stated hiring restriction abroad, a closed posting, or a worldwide
  // posting in a country where pay is well below Israel's. NOT part of
  // `skipped`. Absent on older backends.
  filtered?: FilteredJob[];
  source_errors?: Record<string, string>; // provider id → error when a source actually failed; absent on older backends
  source_empty?: Record<string, string>; // provider id → note when a source worked but matched nothing; absent on older backends
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
  top_matched?: string[]; // strongest covered JD keywords; absent on older backends
  top_gaps: string[];
  jd_text: string;
  posted_at: string; // ISO date the job was posted; empty when unknown
  source?: string; // provider id ("linkedin", "drushim", …); absent on older backends
  logo_url?: string; // company logo from the board; empty/absent when it has none
  also_on?: AlsoOn[]; // the same posting on other boards (cross-board dedupe)
  salary?: SalaryInfo | null; // extracted from the stored posting text on read
  searched_at: string;
  app_status: string; // tracker status if saved/applied: "", saved, applied, interview, offer, rejected
}
export interface JobSearchHistory {
  hits: JobSearchHit[];
}

/** Batch auto-tailor kits (PLAN 8.1): high-fit search results queued for a
 * background tailor run, drained one per request via /kits/process-next. */
export interface KitJobIn {
  title: string;
  company: string;
  location: string;
  url: string;
  source: string;
  logo_url: string;
  posted_at: string;
  jd_text: string;
  overall: number; // the search's fit score — why this job qualified
}
export interface KitOut {
  id: number;
  status: "queued" | "running" | "done" | "failed" | "approved" | "rejected" | "submitted";
  job_title: string;
  company: string;
  location: string;
  url: string;
  source: string;
  logo_url: string;
  posted_at: string;
  search_overall: number;
  score_before: number; // meaningful only when status === "done"
  score_after: number;
  flag_count: number; // > 0 ⇒ fabrication flags; never auto-approvable
  base_language: string; // which master resume slot was tailored ("en" | "he")
  error: string;
  reject_reason: string; // set when the reviewer rejected the kit
  application_id: number | null; // tracker row created on approve
  submit_note: string; // auto-submit (PLAN 8.4): follow-up questionnaire URL, if any
  submitted_at: string;
  created_at: string;
  processed_at: string;
}
export interface KitDetail extends KitOut {
  jd_text: string;
  jd: JDModel | null;
  base_resume: ResumeModel | null; // the master the tailor ran on (diff baseline)
  result: TailorResult | null;
}
export interface KitBatchResult {
  queued: KitOut[];
  skipped_existing: number;
}
export interface KitProcessResult {
  kit: KitOut | null; // null ⇒ queue was empty
  remaining: number;
}

/** The CV scan at /tools/scan (Phase 30 / A2): deterministic keyword coverage
 * and a few resume checks. The names are the backend's models, kept from when
 * the scan was a public page. */
export interface FreeScanCheck {
  id: "email" | "phone" | "length" | "numbers";
  severity: "good" | "warn";
  value: string;
}
export interface FreeScanResult {
  coverage: number;
  keywords: GapItem[];
  checks: FreeScanCheck[];
  jd_language: "en" | "he";
  resume_language: "en" | "he";
}

// Tools
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
export interface OutreachResult {
  connection_note: string;
  inmail_subject: string;
  inmail_body: string;
  referral_message: string;
}
export interface ScreeningAnswerResult {
  answer: string;
  tips: string[];
}
/** A hiring-relevant person found on the company page (never model memory). */
export interface BriefPerson {
  name: string;
  role: string;
  evidence: string;
  linkedin_search: string;
  /** Only set when the address literally appears on the page. */
  email: string;
}
/** A likely decision-maker title for the target role, with a LinkedIn deep
 * link (company People tab when the page linked it, else a people search).
 * Deterministic role→titles table — never the LLM. */
export interface BriefTarget {
  title: string;
  url: string;
}
export interface CompanyBriefResult {
  company: string;
  overview: string;
  products: string[];
  culture: string[];
  interview_style: string[];
  talking_points: string[];
  people: BriefPerson[];
  targets?: BriefTarget[]; // absent on older backends
  company_people_url?: string; // absent on older backends
  hiring_emails: string[];
  outreach_subject: string;
  outreach_message: string;
  grounded: boolean;
}

/** One thing to fix on the resume, anchored to the block it is about.
 *
 * `path` is a BLOCK PATH the document resolves through `lib/resumeBlocks.ts`
 * (`@exp.2.b.1`, `@summary`, `@skills.<verbatim text>`, `@edu.0`), or "" for a
 * document-level finding that belongs to no single block. The grammar is a
 * MIRROR — Python emits it, TypeScript resolves it, and check-mirrors holds the
 * two lists identical — so a path this build cannot resolve means a newer
 * backend knows a shape `BLOCK_PATTERNS` does not. Such a row is listed
 * WITHOUT a mark on the paper and never thrown on: a review that crashes the
 * document is worse than a review that admits it cannot point.
 *
 * `id` and `severity` are plain strings, not unions, for the reason
 * `GeoRestriction` gives above: a newer backend value must not break the build.
 * `id` doubles as the translation key (`review.checks.<id>.{label,how}`), so an
 * id this build has no strings for degrades to an untranslated row rather than
 * a type error — and check-mirrors is what stops that shipping.
 *
 * `raw` is the offending text VERBATIM and it is a PREVIEW, not the anchor
 * (`path` is). Render it inside `<bdi dir="auto">`: one list can hold a Hebrew
 * bullet and a Latin skill, and a bare span lets the first strong character of
 * one row reorder the punctuation of the next. */
export interface ReviewFinding {
  id: string; // stable check id; the UI renders review.checks.<id>.{label,how}
  severity: string; // bad (fix) | warn (consider) — "good" is NOT a finding
  path: string; // a block path the document can resolve, or "" for document-level
  raw: string; // the offending text, verbatim, <= 240 chars
  args: Record<string, string | number>; // interpolates the how-text: { suggested: "Mar 2020" }
}

/** What the deterministic review found on the document as it stands RIGHT NOW.
 *
 * Three lists, and the third is the whole point. `passed` ran and found
 * nothing; `skipped` COULD NOT run (the gap check needs two dated spans, the
 * JD-gated checks need a JD) — and unknown is never shown as clean, the same
 * rule the tracker's nullable `voice_score` and the alert bar's
 * `last_above_min` follow. Folding `skipped` into `passed` would have the panel
 * assert a resume is clean on a check that never looked.
 *
 * Every check always runs, so `passed ∪ skipped ∪ ids(findings)` is the entire
 * check set: there are no toggles, and therefore no way for an empty result to
 * mean "you turned that one off". It carries no SCORE on purpose — a number
 * invites the user to optimise it, and these checks are advice about a
 * document, not a measurement of one. */
export interface ReviewResult {
  findings: ReviewFinding[];
  passed: string[]; // ids that ran and found nothing
  skipped: string[]; // ids that COULD NOT run — unknown, never clean
}

/** One model-suggested rewording of a real bullet.
 *
 * `before` is copied VERBATIM out of the resume, and that exact match is what
 * yields `path` — a rewrite whose `before` matches no bullet is dropped
 * server-side rather than shown, because "Use this" writes through the same
 * block path as every other edit on this surface and a path nothing produced
 * would write into the wrong line. `after` is the same facts in stronger
 * wording with no new number, tool or claim, re-checked deterministically after
 * the call the way `check_fabrication` runs after a tailor. */
export interface ReviewRewrite {
  path: string; // the bullet `before` was matched at
  before: string; // a real bullet, verbatim
  after: string; // same facts, stronger wording, no new claims
}

/** The rewrite batch, plus what the guards refused.
 *
 * `dropped` is reported rather than swallowed: a guard that fires silently is
 * the 21.7 failure mode, and "we asked for five and are showing you two" is a
 * fact the user can act on. `dropped_reasons` are backend-authored English
 * fragments, so the COUNT is the user-facing part and the reasons are for
 * diagnostics — the treatment `LengthReport.notes` already gets. `rewrites: []`
 * with `dropped: 0` means the model returned nothing worth offering, which is
 * NOT the same as "every bullet is already strong". */
export interface ReviewRewriteResult {
  rewrites: ReviewRewrite[];
  dropped: number; // refused by a guard, not by the model
  dropped_reasons: string[]; // hard-coded English fragments — the count is what the user sees
}
export interface RecruiterPrepItem {
  question: string;
  talking_point: string;
}
export interface RecruiterScreenResult {
  pitch: string;
  items: RecruiterPrepItem[];
  salary_note: string;
}
/** A stalled "applied" application worth following up on (GET /applications/nudges). */
export interface StaleApplication {
  id: number;
  job_title: string;
  company: string;
  status: string;
  days_stale: number;
  job_url: string;
}

/** Friends-beta feedback (POST /feedback). */
export interface FeedbackOut {
  id: number;
  page: string;
  text: string;
  created_at: string;
}

/** Who this device's access code belongs to (GET /profile/me).
 * No `invite_code` by design — the backend omits it so the code the device
 * already holds never lands in a screenshot of the settings page. `is_admin`
 * is here for one reason: Close-my-account is refused for an admin, and the
 * page disables that control rather than letting the user discover the 400. */
export interface Me {
  name: string;
  email: string;
  is_admin: boolean;
}

/** One account as the admin API lists it (GET /admin/users, `X-App-Key`). No
 * page reads it yet; it mirrors the backend so the admin's plan switch (Phase 30
 * / B7) has a shape on this side, and check-mirrors 32(j) holds its Phase 30
 * names to Python. */
export interface UserOut {
  id: number;
  name: string;
  email: string;
  invite_code: string;
  is_admin: boolean;
  is_active: boolean;
  created_at: string;
  /** "" = not measured, never "has not visited". */
  last_seen_at: string;
  login_email: string;
  verified: boolean;
  inbox_enabled: boolean;
  plan: string; // "free" | "unlimited"
  /** What this account's pool spent this UTC month. */
  uses_this_month: number;
}

/** The account behind `AuthMe`. */
export interface AuthUser {
  id: number;
  name: string;
  email: string;
  is_admin: boolean;
  /** This login has a password, so there is a current one to confirm before
   * changing it. False for an invite-code account, which has no login, and for a
   * Google-only account, which adds one through Forgot password (Phase 30 E4). */
  has_password: boolean;
  /** A Google sign-in is linked to this login (Phase 30 E4). */
  google_linked: boolean;
  /** "" = invite code / admin (grandfathered as verified); "email" or "google" = self-service. */
  signup_source: string;
}

/** GET /auth/me: who this browser is, and whether that account may use the app.
 *
 * Always a 200. A signed-out visitor is `authenticated: false`, never a 401:
 * any 401 sends the app to /login, and this is the question the login page
 * itself asks on the way in. */
export interface AuthMe {
  authenticated: boolean;
  /** Signed in but not confirmed yet: every feature route answers such an
   * account with 403 `email_unverified`. */
  verified: boolean;
  /** How the request was recognised: an account session (cookie), an invite
   * code (`X-App-Key`), or "dev" — the gate is off locally and every request is
   * the admin. Empty when nobody was recognised. */
  method: "session" | "invite_code" | "dev" | "" | null;
  signup_open: boolean;
  /** Continue with Google is configured on this server (Phase 30 E4). On the
   * signed-out answer too: /login and /signup read it to decide whether to show
   * the button, and they are read by visitors who are signed in to nothing. */
  google_enabled: boolean;
  user: AuthUser | null;
  /** This month's uses for a signed-in caller (Phase 30 / B7); null for a
   * signed-out one, absent on an older backend. `getAuthMe` hands it to
   * lib/usesStore.ts, which is where pages read it. */
  usage?: UsageOut | null;
}

/** One open session pass as /auth/me lists it: interview practice or screening
 * answers. Relative seconds, never a timestamp, so a phone whose clock is wrong
 * cannot end a pass early. Mirrors backend `UsagePassOut` (check-mirrors 32(j)). */
export interface UsagePassOut {
  calls_left: number;
  expires_in_s: number;
}

/** This month's uses (Phase 30 / B7). Mirrors backend `UsageOut` field for
 * field (check-mirrors 32(j)). */
export interface UsageOut {
  plan: string; // "free" | "unlimited"
  /** null = no monthly limit: the admin, plan "unlimited", or the limit switched off. */
  limit: number | null;
  used: number;
  /** null exactly when `limit` is. */
  remaining: number | null;
  resets_on: string; // "YYYY-MM-DD", the 1st of the next UTC month
  by_feature: Record<string, number>; // this month's net uses per feature id
  /** The open interview and screening passes, newest per feature; {} with no limit. */
  passes: Record<string, UsagePassOut>;
}

/** The 429 detail of the monthly free limit. `remaining` is the true count and
 * not always 0: a kits batch bigger than what is left is refused with it. */
export interface MonthlyLimitDetail {
  code: "monthly_limit";
  feature: string;
  plan: string;
  limit: number;
  used: number;
  remaining: number;
  resets_on: string; // "YYYY-MM-DD"
}

/** POST /auth/verify. `signed_in` says whether THIS browser holds the session
 * that just became verified. A link opened elsewhere verifies the account but
 * signs nobody in there. */
export interface VerifyEmailResult {
  verified: boolean;
  signed_in: boolean;
}

/** POST /auth/resend. */
export interface ResendResult {
  sent: boolean;
  cooldown_s: number;
}

/** DELETE /profile/account — the same per-table wipe counts as
 * `deleteMyData`, plus confirmation the code was switched off. */
export interface DeleteAccountResult {
  data: Record<string, number>;
  deactivated: boolean;
}

/** GET/PUT /profile/resume-prefs: what a TAILORED resume may leave out.
 *
 * Every flag is off until the user turns it on in Settings, and none of them
 * ever touches the master resume. */
export interface ResumePrefs {
  /** Leave the Arabic language off a resume tailored for a job in Israel. The
   * server keeps it when the job ad asks for Arabic, and says so in the
   * changelog when it cannot tell whether the job is in Israel. */
  hide_arabic_in_israel: boolean;
}

/** ATS X-ray (21.7) — what a parser actually recovers from the rendered file. */
export interface ATSXrayFact {
  kind: string;
  value: string;
  /** clean = whole, on one line · split = wrapped · polluted = shares its line
   *  with the other column · missing = the parser never got it back. */
  status: "clean" | "split" | "polluted" | "missing";
  line: string;
  collided_with: string;
}

export interface ATSXrayResult {
  template: string;
  fmt: "pdf" | "docx";
  pages: number;
  two_column: boolean;
  /** Set for a DOCX of a two-column template: the id actually rendered. */
  docx_fallback: string;
  text: string;
  facts: ATSXrayFact[];
  clean: number;
  split: number;
  polluted: number;
  missing: number;
}
