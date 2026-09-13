// Turns an axios error into a user-visible message. FastAPI errors carry a
// `detail` that is usually a string, but structured errors (e.g. the per-user
// daily cap on /jobs/search and /tailor) send an object — which must never be
// rendered raw ("[object Object]").
import i18n from "../i18n";

// Must stay in sync with the `action` strings passed to check_and_count in the
// backend (app/core/usage.py callers). `inbox` is the Gmail scanner's own cap:
// emails classified per day, charged by a sync and never by an AI request.
type LimitAction = "search" | "tailor" | "llm" | "submit" | "inbox";

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

/** Translated message for an API error, or `fallback` when there's nothing
 * better. Structured (non-string) details are mapped to friendly copy or
 * swallowed — never returned raw. */
export function apiErrorMessage(e: unknown, fallback: string): string {
  const detail = detailOf(e);
  if (isDailyLimit(detail)) {
    const key = LIMIT_KEYS[detail.action] ?? "dailyLimit.generic";
    return i18n.t(key, { ns: "common", cap: detail.cap });
  }
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
  if (typeof detail === "string" && detail.trim()) return detail;
  return fallback;
}
