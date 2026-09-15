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
  | "scan";

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
};

// Prompt-size limits (backend app/llm/limits.py). Same structured-detail shape
// as the daily cap and for the same reason: the sentence is composed here so it
// can be translated, instead of shipping an English string from the server.
interface SizeLimitDetail {
  code: "input_too_large";
  kind: "resume" | "jd";
  size_kb: number;
  cap_kb: number;
}

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
    // Keyed per kind: a resume that is too big and a job ad that is too big
    // need different advice (trim the CV vs paste less of the posting).
    return i18n.t(`sizeLimit.${detail.kind === "jd" ? "jd" : "resume"}`, {
      ns: "common",
      cap: detail.cap_kb,
      size: detail.size_kb,
    });
  }
  const code = codeOf(detail);
  if (code === "context_exceeded") return i18n.t("sizeLimit.context", { ns: "common" });
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
