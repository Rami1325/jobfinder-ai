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
 * What the page budget had to do to fit the résumé (app/core/length_budget.py).
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

/** One restore point for the master résumé (PLAN 20.8/N1). Metadata only — the
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
  top_matched?: string[]; // strongest covered JD keywords; absent on older backends
  top_gaps: string[];
  jd_text: string;
  url: string; // set for scraped listings; empty for pasted ones
  location: string;
  posted_at: string; // ISO date from the LinkedIn search card; empty when unknown
  source?: string; // provider id ("linkedin", "drushim", …); absent on older backends
  logo_url?: string; // company logo from the board; empty/absent when it has none
  also_on?: AlsoOn[]; // the same posting on other boards (cross-board dedupe)
  salary?: SalaryInfo | null; // only when literally stated in the posting
  geo_restriction?: GeoRestriction | null; // a hiring restriction the posting STATES
  // Reasons to suspect this is not a live vacancy. Derived on read from the
  // posting text + our own sightings, never stored — so re-tuning the rules
  // reclassifies every posting with no migration. Same as `geo_restriction`.
  ghost?: GhostReport | null;
  stale?: boolean; // older than the search window, kept for keyword relevance (PLAN 15.6)
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
 * restriction, or because the board says it is closed. Carries no scores on
 * purpose: it was never scored, and a zero would be a fabricated number. */
export interface FilteredJob {
  title: string;
  company: string;
  location: string;
  url: string;
  source: string;
  posted_at: string;
  logo_url: string;
  geo_restriction?: GeoRestriction | null;
  // Why it was dropped. The backend defaults it to "restriction", so a response
  // that predates Phase 28 means "restriction" — which is TRUE, not unknown.
  // Read it in that direction: anything not literally "closed" is a restriction.
  reason?: string; // restriction | closed
  ghost?: GhostReport | null; // the evidence behind reason === "closed"
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
}
export interface AlertRunResult {
  ran: boolean;
  total: number;
  new_count: number;
  above_min?: number; // of new_count, how many cleared the fit bar
  emailed: boolean;
  error: string;
}
export interface JobSearchResult {
  context: SearchContext;
  matches: JobMatch[];
  skipped: number;
  // Postings dropped before scoring for a stated hiring restriction abroad.
  // NOT part of `skipped`. Absent on older backends.
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
  base_language: string; // which master résumé slot was tailored ("en" | "he")
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

/** Free public CV-vs-JD scan (no signup, deterministic only). */
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

/** One thing to fix on the résumé, anchored to the block it is about.
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
 * assert a résumé is clean on a check that never looked.
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
 * `before` is copied VERBATIM out of the résumé, and that exact match is what
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

/** DELETE /profile/account — the same per-table wipe counts as
 * `deleteMyData`, plus confirmation the code was switched off. */
export interface DeleteAccountResult {
  data: Record<string, number>;
  deactivated: boolean;
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
