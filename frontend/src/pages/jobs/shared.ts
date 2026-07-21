// Shared constants + pure helpers for the Jobs surfaces (split out of
// JobsPage.tsx — PLAN 12.5d). No JSX here.
import type { TFunction } from "i18next";
import type { SearchContext } from "../../types";

// House ease curve — shared by the scan ticker flips and JobsPage's tab/card motion.
export const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

export const inputCls =
  "rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none disabled:opacity-50";

export const WORK_MODES = ["any", "remote", "onsite", "hybrid"] as const;

// "Posted within" choices in days; 0 = any age. Backend default is 30, so a
// ctx without max_age_days (older saved contexts) behaves like "Month".
export const MAX_AGE_OPTIONS = [1, 3, 7, 14, 30, 0] as const;

// Selectable job boards (PROVIDERS registry ids). Empty/absent = all boards.
// Keep in sync with the backend registry: a board missing here disappears
// from any customized search the moment the user unchecks one box.
// (Jooble retired 2026-07-05 — they discontinued their Israeli index.)
export const SOURCE_IDS = ["linkedin", "drushim", "comeet", "jobmaster", "greenhouse"] as const;

// One-click Israeli locations (PLAN 2.3). English values work across all
// boards: LinkedIn expects English; Drushim matches CityEnglish; Comeet
// aliases Hebrew cities to English anyway.
export const LOCATION_PRESETS = [
  { key: "telAviv", value: "Tel Aviv, Israel" },
  { key: "jerusalem", value: "Jerusalem, Israel" },
  { key: "haifa", value: "Haifa, Israel" },
  { key: "israel", value: "Israel" },
] as const;

// Provider id → display name for source badges ("linkedin" → "LinkedIn").
// "jooble" stays for history rows saved before the board was retired.
const SOURCE_LABELS: Record<string, string> = {
  linkedin: "LinkedIn",
  drushim: "Drushim",
  comeet: "Comeet",
  jobmaster: "JobMaster",
  greenhouse: "Greenhouse",
  jooble: "Jooble",
};

export function sourceLabel(source?: string): string {
  if (!source) return "";
  return SOURCE_LABELS[source.toLowerCase()] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

export function postedAgo(iso: string, t: TFunction<"jobs">): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return t("posted.today");
  if (days === 1) return t("posted.yesterday");
  if (days < 7) return t("posted.days", { count: days });
  if (days < 30) return t("posted.weeks", { count: Math.floor(days / 7) });
  return t("posted.months", { count: Math.floor(days / 30) });
}

// Job-board hosts whose favicon is the board's logo, not the company's — those
// cards fall back to the lettered avatar unless the backend supplied a real
// company logo_url (LinkedIn/Drushim/Comeet boards carry one when available).
const BOARD_HOST_RE =
  /(^|\.)(linkedin\.com|licdn\.com|drushim\.co\.il|comeet\.(co|com)|jobmaster\.co\.il|greenhouse\.io|jooble\.org)$/;

export function companyDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return BOARD_HOST_RE.test(host) ? null : host;
  } catch {
    return null;
  }
}

// Deterministic theme-token backgrounds for the lettered fallback avatar.
const AVATAR_TONES = [
  "bg-accent/15 text-accent-soft",
  "bg-mint/15 text-mint",
  "bg-warn/15 text-warn",
  "bg-accent/10 text-ink-muted",
] as const;

export function avatarTone(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}


/** Posted within the last 48 hours. */
export function isNewPosting(iso: string): boolean {
  const ts = new Date(iso).getTime();
  return !Number.isNaN(ts) && Date.now() - ts < 48 * 3_600_000;
}


/** Tracker rows and job hits both store the raw job URL — normalize just enough
 * (trailing slashes) to match them client-side. */
export function normalizeJobUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

// Elapsed-time stage guesses, used only when the SSE stream isn't feeding real
// progress (old backend fallback): the pipeline really does run boards → fetch
// → score, and per-job scoring dominates.
export const SEARCH_STAGES = ["boards", "fetching", "scoring"] as const;

export function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Rough remaining-time estimate for the scoring stage, rounded to friendly
// units: under ~1.5 min it reads "~40s left" (5 s steps), above it "~2 min
// left" — precision would be fake anyway.
export function formatEta(secondsLeft: number, t: TFunction): string {
  if (secondsLeft < 90) {
    return t("search.eta.secondsLeft", { n: Math.max(5, Math.round(secondsLeft / 5) * 5) });
  }
  return t("search.eta.minutesLeft", { n: Math.round(secondsLeft / 60) });
}

/** Semantic fingerprint of a SearchContext for dirty-checking, ignoring field
 * order and the absent-vs-default noise a backend round-trip introduces
 * (missing sources = all boards, missing max_age_days = 30). */
export function contextKey(c: SearchContext | null): string {
  if (!c) return "";
  const titles = c.job_titles?.length ? c.job_titles : [c.job_title];
  return JSON.stringify([
    titles,
    c.location,
    c.work_mode,
    c.limit,
    c.sources?.length ? [...c.sources].sort() : [...SOURCE_IDS].sort(),
    c.max_age_days ?? 30,
    c.include_worldwide ?? false,
  ]);
}
