// Turns an axios error into a user-visible message. FastAPI errors carry a
// `detail` that is usually a string, but structured errors (e.g. the per-user
// daily cap on /jobs/search and /tailor) send an object — which must never be
// rendered raw ("[object Object]").
import i18n from "../i18n";

interface DailyLimitDetail {
  code: "daily_limit";
  action: "search" | "tailor";
  cap: number;
}

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
    const key = detail.action === "tailor" ? "dailyLimit.tailor" : "dailyLimit.search";
    return i18n.t(key, { ns: "common", cap: detail.cap });
  }
  if (typeof detail === "string" && detail.trim()) return detail;
  return fallback;
}
