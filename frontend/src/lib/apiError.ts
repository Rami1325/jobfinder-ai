// Turns an axios error into a user-visible message. FastAPI errors carry a
// `detail` that is usually a string, but structured errors (e.g. the per-user
// daily cap on /jobs/search and /tailor) send an object — which must never be
// rendered raw ("[object Object]").
import i18n from "../i18n";

// Must stay in sync with the `action` strings passed to check_and_count in the
// backend (app/core/usage.py callers).
type LimitAction = "search" | "tailor" | "llm" | "submit";

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
};

function isDailyLimit(detail: unknown): detail is DailyLimitDetail {
  return (
    typeof detail === "object" &&
    detail !== null &&
    (detail as { code?: unknown }).code === "daily_limit"
  );
}

/** Translated message for an API error, or `fallback` when there's nothing
 * better. Structured (non-string) details are mapped to friendly copy or
 * swallowed — never returned raw. */
export function apiErrorMessage(e: unknown, fallback: string): string {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (isDailyLimit(detail)) {
    const key = LIMIT_KEYS[detail.action] ?? "dailyLimit.generic";
    return i18n.t(key, { ns: "common", cap: detail.cap });
  }
  if (typeof detail === "string" && detail.trim()) return detail;
  return fallback;
}
