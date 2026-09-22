// Turns an axios error into a user-visible message. FastAPI errors carry a
// `detail` that is usually a string, but structured errors (e.g. the per-user
// daily cap on /jobs/search and /tailor) send an object — which must never be
// rendered raw ("[object Object]").
import i18n from "../i18n";
import type { MonthlyLimitDetail } from "../types";
import { formatUsesDate, usedUpMonth } from "./usesStore";

// Must stay in sync with the `action` strings passed to check_and_count in the
// backend (app/core/usage.py callers). `inbox` is the Gmail scanner's own cap:
// emails classified per day, charged by a sync and never by an AI request.
// `upload`, `jd_analyze` and `search_context` are Phase 30's caps on three free
// model routes that are sub-steps of counted flows (counting them against the
// monthly uses would make one tailor cost 2), and `scan` is the CV scan's own
// daily cap on top of its monthly use (B4.6). check-mirrors 32(c) renders all four.
type LimitAction =
  | "search"
  | "tailor"
  | "llm"
  | "submit"
  | "inbox"
  | "upload"
  | "jd_analyze"
  | "search_context"
  | "scan"
  | "fetch";

interface DailyLimitDetail {
  code: "daily_limit";
  action: LimitAction;
  cap: number;
}

// An unknown action falls back to the generic line rather than to "searches",
// which is what the old `action === "tailor" ? … : search` ternary did — it
// silently told anyone who hit the submit cap they were out of searches.
const LIMIT_KEYS: Record<LimitAction, string> = {
  search: "dailyLimit.search",
  tailor: "dailyLimit.tailor",
  llm: "dailyLimit.llm",
  submit: "dailyLimit.submit",
  inbox: "dailyLimit.inbox",
  upload: "dailyLimit.upload",
  jd_analyze: "dailyLimit.jdAnalyze",
  search_context: "dailyLimit.searchContext",
  scan: "dailyLimit.scan",
  fetch: "dailyLimit.fetch",
};

// Prompt-size limits (backend app/llm/limits.py). Same structured-detail shape
// as the daily cap and for the same reason: the sentence is composed here so it
// can be translated, instead of shipping an English string from the server.
interface SizeLimitDetail {
  code: "input_too_large";
  kind: string;
  size_kb: number;
  cap_kb: number;
}

// One sentence per kind the backend can raise, because each needs different
// advice (P30-PASS-SIZE): trim a CV, paste less of a posting, end a practice
// session that is full, restart one too long to score, shorten an answer, paste
// just the question. It used to be `kind === "jd" ? jd : resume`, so a practice
// session that was too long was told "That CV is too large… upload again".
// check-mirrors 34 reads every kind out of the backend and fails a build where
// one has no row here, or no sentence in either locale. Looked up by the table's
// OWN keys, like GOOGLE_ERROR_KEYS: an unknown kind gets the generic sentence,
// never the CV's, and `constructor` is not a kind.
const SIZE_LIMIT_KEYS: Record<string, string> = {
  resume: "sizeLimit.resume",
  jd: "sizeLimit.jd",
  transcript: "sizeLimit.transcript",
  session: "sizeLimit.session",
  answer: "sizeLimit.answer",
  question: "sizeLimit.question",
  // The follow-up writer's note and a pasted company page (2026-09-22): both
  // reached the model unmeasured, and the page was clipped instead of refused.
  note: "sizeLimit.note",
  page: "sizeLimit.page",
};

// A context overflow that is not the CV's alone. The model refused the prompt,
// so no size is known; on the mock interview's two routes the transcript can be
// the larger part, and "Your CV is too long" was false there. A missing or
// unknown kind reads the CV's sentence, which is what every other route means.
// check-mirrors 39 holds these keys to the kinds routes.py raises.
const CONTEXT_LIMIT_KEYS: Record<string, string> = {
  transcript: "sizeLimit.contextTranscript",
  session: "sizeLimit.contextSession",
};

function isSizeLimit(detail: unknown): detail is SizeLimitDetail {
  return (
    typeof detail === "object" &&
    detail !== null &&
    (detail as { code?: unknown }).code === "input_too_large"
  );
}

function codeOf(detail: unknown): string | null {
  if (typeof detail === "object" && detail !== null) {
    const c = (detail as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return null;
}

function isDailyLimit(detail: unknown): detail is DailyLimitDetail {
  return (
    typeof detail === "object" &&
    detail !== null &&
    (detail as { code?: unknown }).code === "daily_limit"
  );
}

// Account errors (the backend's /auth routes and the access gate). Same
// structured `{code, ...}` shape as the caps above, translated here for the
// same reason, but from the `auth` namespace, so the login form and a feature
// call that trips the same code say the same sentence.
//
// check-mirrors 29 resolves EVERY "errors.*" literal in this file against both
// auth.json files. The pages never spell these keys out: they render a server
// code through this table. So a code mapped to a key that exists in neither
// locale would show the raw key in the form's error slot, and no scrape of the
// pages could see it.
const AUTH_ERROR_KEYS: Record<string, string> = {
  invalid_credentials: "errors.invalidCredentials",
  email_taken: "errors.emailTaken",
  invalid_email: "errors.invalidEmail",
  name_required: "errors.nameRequired",
  expired: "errors.expired",
  used: "errors.used",
  signup_closed: "errors.signupClosed",
  email_unavailable: "errors.emailUnavailable",
  email_unverified: "errors.emailUnverified",
  csrf: "errors.csrf",
  admin_key_from_env: "errors.adminKey",
  // Raised by the backend's account flows, not named in the spec: an account
  // with no email sign-in (an invite code) asked to change it, a code sent from
  // a browser without the signup session, and an address confirmed already.
  no_login: "errors.noLogin",
  session_required: "errors.sessionRequired",
  already_verified: "errors.alreadyVerified",
  // Phase 30: a Google-only account asked to change a password it does not have
  // (it adds one through Forgot password, E4), and the Google start route while
  // sign-in is not configured.
  password_not_set: "errors.passwordNotSet",
  google_disabled: "errors.google.disabled",
};

// Continue with Google's refusals (Phase 30 F3). The callback redirects, so a
// refusal reaches /login or /signup as `?google=<code>` with no JSON detail, and
// is read through `googleErrorMessage`, never `apiErrorMessage`. Its OWN table:
// two of these codes (`expired`, `signup_closed`) already name other sentences
// in AUTH_ERROR_KEYS, and one object literal cannot hold a key twice.
//
// One row per code the callback can send, each named `errors.google.<code>`.
// check-mirrors 32(g) reads the codes out of the backend (the callback's own and
// accounts.google_sign_in's) and fails a code with no row here.
const GOOGLE_ERROR_KEYS: Record<string, string> = {
  disabled: "errors.google.disabled",
  state_invalid: "errors.google.state_invalid",
  expired: "errors.google.expired",
  state_mismatch: "errors.google.state_mismatch",
  cancelled: "errors.google.cancelled",
  google_error: "errors.google.google_error",
  exchange_failed: "errors.google.exchange_failed",
  token_invalid: "errors.google.token_invalid",
  account_inactive: "errors.google.account_inactive",
  not_authoritative: "errors.google.not_authoritative",
  signup_closed: "errors.google.signup_closed",
  linked_elsewhere: "errors.google.linked_elsewhere",
  try_again: "errors.google.try_again",
  // E3's account-creation throttle. The redirect carries no `retry_after`, so
  // there is no countdown to give, and the sentence does not say "sign up with
  // your email" either: email signup counts on the same per-network counter, so
  // a new email account is refused on that network for the same hour.
  too_many_attempts: "errors.google.too_many_attempts",
};

// The server's password rules (validate_password's reasons). An unknown reason
// falls back to the generic line rather than to nothing.
const WEAK_PASSWORD_KEYS: Record<string, string> = {
  too_short: "errors.weakPassword.tooShort",
  too_long: "errors.weakPassword.tooLong",
  same_as_email: "errors.weakPassword.sameAsEmail",
  too_common: "errors.weakPassword.tooCommon",
};

type ErrorShape = { response?: { status?: number; data?: { detail?: unknown } } };

function detailOf(e: unknown): unknown {
  return (e as ErrorShape)?.response?.data?.detail;
}

/** The structured `code` of an API error, or null (a network failure, or a
 * plain-string detail). For pages that react to a specific code, e.g. signup
 * switching to its "sign-ups are paused" state. */
export function apiErrorCode(e: unknown): string | null {
  return codeOf(detailOf(e));
}

/** This browser no longer holds a session the request needed: the access
 * gate's 401 (its detail is a plain English string), or `session_required`
 * from the verify flow. Pages that act on it show a translated "log in again"
 * state instead of an error. A 403 (`email_unverified`) is NOT this: that
 * session is alive and only needs its code. */
export function isSessionEnded(e: unknown): boolean {
  return (e as ErrorShape)?.response?.status === 401 || apiErrorCode(e) === "session_required";
}

/** The server answered, and answered with a failure of its OWN (5xx).
 *
 * The one class of failure that can happen after a session pass has already
 * been charged: `pass_charged` runs behind the handler's own checks, so a 400,
 * a 422, the gate's 401/403, a daily-cap 429 and a request that never got a
 * response all leave the pass untouched, while a 502 or a 503 was raised from
 * inside it. A caller keeping its own count of what a pass has left decrements
 * on this and on nothing else: counting a refusal the pass never saw can
 * disable a control the server would still have served for free. */
export function isServerFailure(e: unknown): boolean {
  const status = (e as ErrorShape)?.response?.status;
  return typeof status === "number" && status >= 500;
}

/** The `kind` of a 413 `input_too_large` ("transcript", "answer"…), or null for
 * any other failure. The mock interview reads it to stop offering Send once the
 * session is full. */
export function sizeLimitKind(e: unknown): string | null {
  const detail = detailOf(e);
  if (!isSizeLimit(detail)) return null;
  return typeof detail.kind === "string" ? detail.kind : null;
}

/** The `retry_after` seconds a 429 `too_many_attempts` carries, or null. */
export function retryAfterSeconds(e: unknown): number | null {
  const detail = detailOf(e) as { retry_after?: unknown } | undefined;
  const s = detail?.retry_after;
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? s : null;
}

/** "Too many attempts. Try again in 3 minutes." from `retry_after` seconds.
 *
 * Rounded UP. "In 0 minutes" with 40 seconds left is a sentence the user acts
 * on, and it is false. Whole sentences per unit, not an Intl.RelativeTimeFormat
 * fragment glued into one: engines disagree on the Hebrew fragment (Node's ICU
 * prints "בעוד דקה (1)"), and a translator needs the sentence, not a slot. */
function retryMessage(seconds: number | null): string {
  if (!seconds) return i18n.t("errors.retryLater", { ns: "auth" });
  const s = Math.ceil(seconds);
  if (s < 60) return i18n.t("errors.retrySeconds", { ns: "auth", count: s });
  if (s < 3600) return i18n.t("errors.retryMinutes", { ns: "auth", count: Math.ceil(s / 60) });
  return i18n.t("errors.retryHours", { ns: "auth", count: Math.ceil(s / 3600) });
}

function authMessage(e: unknown, code: string): string | null {
  const detail = detailOf(e) as Record<string, unknown>;
  if (code === "weak_password") {
    const reason = typeof detail.reason === "string" ? detail.reason : "";
    return i18n.t(WEAK_PASSWORD_KEYS[reason] ?? "errors.weakPassword.generic", { ns: "auth" });
  }
  if (code === "invalid_code") {
    const left = detail.attempts_left;
    if (typeof left !== "number") return i18n.t("errors.wrongCode", { ns: "auth" });
    // Zero left is not "0 attempts left": that code is spent, and the only way
    // on is a new one. Say so instead of counting down to nothing.
    if (left <= 0) return i18n.t("errors.codeLocked", { ns: "auth" });
    return i18n.t("errors.invalidCode", { ns: "auth", count: left });
  }
  if (code === "too_many_attempts") return retryMessage(retryAfterSeconds(e));
  const key = AUTH_ERROR_KEYS[code];
  return key ? i18n.t(key, { ns: "auth" }) : null;
}

/** A 429 from the monthly free limit (Phase 30): this month's uses are spent.
 * Not a session ending and not a daily cap, so a page that branches on it can
 * say when uses come back instead of "try again". */
export function isMonthlyLimit(e: unknown): boolean {
  return apiErrorCode(e) === "monthly_limit";
}

/** "You've used all your uses for September. More on October 1.", in the
 * reader's language. The month named is the one that ran out, the month before
 * `resets_on`; a refusal with no readable date gets the sentence that names none. */
function monthlyLimitMessage(detail: Partial<MonthlyLimitDetail>): string {
  const resetsOn = typeof detail.resets_on === "string" ? detail.resets_on : "";
  const date = formatUsesDate(resetsOn, i18n.language);
  const month = usedUpMonth(resetsOn, i18n.language);
  return date && month
    ? i18n.t("uses.limitReached", { ns: "common", month, date })
    : i18n.t("uses.limitReachedBare", { ns: "common" });
}

/** Translated message for an API error, or `fallback` when there's nothing
 * better. Structured (non-string) details are mapped to friendly copy or
 * swallowed — never returned raw. */
export function apiErrorMessage(e: unknown, fallback: string): string {
  const detail = detailOf(e);
  if (isDailyLimit(detail)) {
    const key = LIMIT_KEYS[detail.action] ?? "dailyLimit.generic";
    return i18n.t(key, { ns: "common", cap: detail.cap });
  }
  if (codeOf(detail) === "monthly_limit") return monthlyLimitMessage(detail as Partial<MonthlyLimitDetail>);
  if (isSizeLimit(detail)) {
    const key = Object.prototype.hasOwnProperty.call(SIZE_LIMIT_KEYS, detail.kind)
      ? SIZE_LIMIT_KEYS[detail.kind]
      : "sizeLimit.generic";
    return i18n.t(key, { ns: "common", cap: detail.cap_kb, size: detail.size_kb });
  }
  const code = codeOf(detail);
  if (code === "context_exceeded") {
    const kind = (detail as { kind?: unknown }).kind;
    const key =
      typeof kind === "string" && Object.prototype.hasOwnProperty.call(CONTEXT_LIMIT_KEYS, kind)
        ? CONTEXT_LIMIT_KEYS[kind]
        : "sizeLimit.context";
    return i18n.t(key, { ns: "common" });
  }
  if (code === "output_truncated") return i18n.t("sizeLimit.truncated", { ns: "common" });
  if (code) {
    const auth = authMessage(e, code);
    if (auth) return auth;
  }
  // The gate's 401 carries a plain English string ("Access code required.").
  // Printed as-is it reaches a Hebrew form verbatim, so it is translated here.
  // Only for a 401: any other string detail still reads as the server sent it.
  if ((e as ErrorShape)?.response?.status === 401) return i18n.t("errors.sessionEnded", { ns: "auth" });
  if (typeof detail === "string" && detail.trim()) return detail;
  return fallback;
}

/** The sentence for a Google sign-in that came back refused, read from its
 * `?google=<code>` (Phase 30 F3).
 *
 * The lookup is by the table's OWN keys. The code arrives in an address anyone
 * can type, and a plain `GOOGLE_ERROR_KEYS[code]` answers `?google=constructor`
 * with a function every object inherits. Anything unknown gets the generic
 * sentence, which still says a Google sign-in is what failed. */
export function googleErrorMessage(code: string): string {
  const key = Object.prototype.hasOwnProperty.call(GOOGLE_ERROR_KEYS, code)
    ? GOOGLE_ERROR_KEYS[code]
    : "errors.google.generic";
  return i18n.t(key, { ns: "auth" });
}

/** A failed password login's sentence. On a server that offers Continue with
 * Google, `invalid_credentials` also says that an account made with Google has
 * no password to type — the one reason a correct address fails that the
 * ordinary sentence cannot suggest. It reads the same for every failed login, so
 * it says nothing about whether an address has an account. Every other refusal
 * reads exactly as `apiErrorMessage` reads it. */
export function loginErrorMessage(e: unknown, googleEnabled: boolean, fallback: string): string {
  if (googleEnabled && apiErrorCode(e) === "invalid_credentials")
    return i18n.t("errors.invalidCredentialsGoogle", { ns: "auth" });
  return apiErrorMessage(e, fallback);
}
