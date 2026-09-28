// Shared constants + pure helpers for the Jobs surfaces (split out of
// JobsPage.tsx — PLAN 12.5d). No JSX here.
import type { TFunction } from "i18next";
import { textLanguage } from "../../lib/lang";
import type { Applicants, JobMatch, JobSearchResult, KitJobIn, SearchContext, SearchQueryReading } from "../../types";

// House ease curve — shared by the scan ticker flips and JobsPage's tab/card motion.
export const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

export const inputCls =
  "rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none disabled:opacity-50";

// The work modes a search can pick, in the ONE order the backend writes a stored
// value in (`app.models.WORK_MODES`): "remote,hybrid", never "hybrid,remote".
// `work_mode` stays ONE string — "any" or a comma list — because every saved
// alert holds a single word there. No pick, or all three, is "any".
export const WORK_MODES = ["remote", "onsite", "hybrid"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

/** The modes a `work_mode` value picks, in WORK_MODES order; [] is ANY. The
 * TypeScript twin of `app.models.work_modes`: unknown words are dropped, and all
 * three at once is no filter at all. */
export function parseWorkModes(value: string | null | undefined): WorkMode[] {
  const picked = new Set((value ?? "").split(",").map((part) => part.trim()));
  const modes = WORK_MODES.filter((m) => picked.has(m));
  return modes.length === WORK_MODES.length ? [] : modes;
}

/** The value to store for a set of picks: "any", or the picks in WORK_MODES order. */
export function joinWorkModes(modes: readonly string[]): string {
  return parseWorkModes(modes.join(",")).join(",") || "any";
}

/** Can this search include remote jobs? The gate on the worldwide opt-in, the
 * twin of `job_search._remote_ok`. */
export function allowsRemote(value: string | null | undefined): boolean {
  const modes = parseWorkModes(value);
  return modes.length === 0 || modes.includes("remote");
}

// "Posted within" choices in days; 0 = any age. Backend default is 30, so a
// ctx without max_age_days (older saved contexts) behaves like "Month".
export const MAX_AGE_OPTIONS = [1, 3, 7, 14, 30, 0] as const;

// The email alert's fit bar: only new postings at or above it are mailed.
// 0 = "any fit", i.e. the pre-bar behaviour of emailing every unseen job.
// Same numbers the batch-tailor card offers (KIT_THRESHOLDS in kits.tsx),
// because both read the same `overall` fit — two lists would let the app offer
// 75 for one and 78 for the other while meaning the same thing. The server
// owns the value and clamps it; this is only which bars the picker offers.
export const MIN_SCORE_OPTIONS = [0, 60, 65, 70, 75, 80, 85, 90] as const;

// Selectable job boards: the backend registry's ids (`app.core.providers.PROVIDERS`),
// in its order. Empty/absent = all boards. check-mirrors 98 holds the two
// together: a board missing here disappears from any customized search the
// moment the user unchecks one box, and a board here the backend lacks is a box
// that searches nothing. (Jooble retired 2026-07-05 — they discontinued their
// Israeli index. The boards from Lever on joined 2026-09-28.)
export const SOURCE_IDS = ["linkedin", "drushim", "comeet", "jobmaster", "greenhouse", "lever"] as const;

// One-click Israeli locations (PLAN 2.3). English values work across all
// boards: LinkedIn expects English; Drushim matches CityEnglish; Comeet
// aliases Hebrew cities to English anyway.
export const LOCATION_PRESETS = [
  { key: "telAviv", value: "Tel Aviv, Israel" },
  { key: "jerusalem", value: "Jerusalem, Israel" },
  { key: "haifa", value: "Haifa, Israel" },
  { key: "israel", value: "Israel" },
] as const;

// Each board's name in English and in Hebrew, for the board picker, the scan
// panel, the source badges and every "Open on …" line. A brand keeps its Latin
// name in Hebrew (the Hebrew copy already writes "ב־LinkedIn"), except Drushim,
// whose own Hebrew name is the one Israelis know it by. "jooble" stays for
// history rows saved before the board was retired. check-mirrors 98 requires an
// entry with both names for every id in SOURCE_IDS.
export const SOURCE_NAMES: Record<string, { en: string; he: string }> = {
  linkedin: { en: "LinkedIn", he: "LinkedIn" },
  drushim: { en: "Drushim", he: "דרושים" },
  comeet: { en: "Comeet", he: "Comeet" },
  jobmaster: { en: "JobMaster", he: "JobMaster" },
  greenhouse: { en: "Greenhouse", he: "Greenhouse" },
  lever: { en: "Lever", he: "Lever" },
  smartrecruiters: { en: "SmartRecruiters", he: "SmartRecruiters" },
  ashby: { en: "Ashby", he: "Ashby" },
  himalayas: { en: "Himalayas", he: "Himalayas" },
  jooble: { en: "Jooble", he: "Jooble" },
};

/** A board's name in the page's language ("linkedin" → "LinkedIn"); an id this
 * build does not know is shown capitalised rather than dropped. */
export function sourceLabel(source?: string, lang?: string): string {
  if (!source) return "";
  const names = SOURCE_NAMES[source.toLowerCase()];
  if (!names) return source.charAt(0).toUpperCase() + source.slice(1);
  return lang?.startsWith("he") ? names.he : names.en;
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

/** The board's own competition line in the app's words (Phase 32): "131
 * applicants on LinkedIn", or "" when there is nothing to say. ONE function for
 * every surface (the search row, the History row, a job's page), so no two of
 * them can word the same reading differently.
 *
 * It judges no freshness: the server sends a reading only while it is current
 * (`job_search.current_applicants`, a day), so there is no date here to compare
 * on a device clock that may be wrong. It names the board the READING names
 * (`source`), never the page's context, and says nothing for a reading that
 * names none. A `kind` this build has no sentence for draws nothing, because
 * `t()` on a missing key renders the key. Each key is a plain literal call, so
 * check-mirrors 87 resolves it in both locales. */
export function applicantsText(a: Applicants | null | undefined, t: TFunction<"jobs">): string {
  if (!a || !a.source || !Number.isInteger(a.n) || a.n < 0) return "";
  const board = sourceLabel(a.source);
  switch (a.kind) {
    case "early":
      return t("card.applicantsEarly", { n: a.n, board });
    case "over":
      return t("card.applicantsOver", { n: a.n, board });
    case "count":
      return t("card.applicantsCount", { count: a.n, board });
    default:
      return "";
  }
}

// Job-board hosts whose favicon is the board's logo, not the company's — those
// cards fall back to the lettered avatar unless the backend supplied a real
// company logo_url (LinkedIn/Drushim/Comeet boards carry one when available).
const BOARD_HOST_RE =
  /(^|\.)(linkedin\.com|licdn\.com|drushim\.co\.il|comeet\.(co|com)|jobmaster\.co\.il|greenhouse\.io|lever\.co|smartrecruiters\.com|ashbyhq\.com|himalayas\.app|jooble\.org)$/;

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


/** A search/manual match as the kit-batch endpoint wants it (PLAN 8.1) —
 * shared by the batch card and the per-job kit button (15.9). */
/** The posting as the tailor should read it: `Location: <location>` as the
 * first line when the board gave a location that the ad's own text never
 * states.
 *
 * The server decides "is this job in Israel?" from the posting text (it gets no
 * separate location field from this handoff), and a lot of LinkedIn ads never
 * name the city in the body. Without the line, the "Leave Arabic off" setting
 * would read those jobs as "couldn't tell". The kit queue needs none of this:
 * it sends `location` as its own field.
 *
 * Two cases stay untouched:
 *   - the text already contains the location (any case): the line adds nothing.
 *   - a Hebrew location on an English ad. The server marks a posting Hebrew
 *     when it holds ANY Hebrew letter (`textLanguage`), so one prepended city
 *     name would switch the whole tailored resume to Hebrew.
 * The "Location:" label itself is Latin, so it never changes a Hebrew ad's
 * language. */
export function jdTextWithLocation(jdText: string, location?: string): string {
  const loc = (location ?? "").replace(/\s+/g, " ").trim();
  if (!jdText.trim() || !loc) return jdText;
  if (jdText.replace(/\s+/g, " ").toLowerCase().includes(loc.toLowerCase())) return jdText;
  if (textLanguage(loc) === "he" && textLanguage(jdText) === "en") return jdText;
  return `Location: ${loc}\n${jdText}`;
}

export function kitJobFromMatch(m: JobMatch): KitJobIn {
  return {
    title: m.title,
    company: m.company,
    location: m.location,
    url: m.url,
    source: m.source ?? "linkedin",
    logo_url: m.logo_url ?? "",
    posted_at: m.posted_at,
    jd_text: m.jd_text,
    overall: m.overall,
  };
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
    // Canonical, so "hybrid,remote" typed by an older tab and the backend's
    // "remote,hybrid" are one pick, not an unsaved change.
    joinWorkModes(parseWorkModes(c.work_mode)),
    c.limit,
    c.sources?.length ? [...c.sources].sort() : [...SOURCE_IDS].sort(),
    c.max_age_days ?? 30,
    c.include_worldwide ?? false,
  ]);
}

/** Did a plain-words line say anything the form can use? (Phase 32) */
export function readingUnderstood(r: SearchQueryReading | null | undefined): boolean {
  return !!r && ((r.job_titles?.length ?? 0) > 0 || !!r.location || !!r.work_mode || !!r.include_worldwide);
}

/** A plain-words reading applied to the search form (Phase 32). Each field the
 * line SAID replaces the form's; every field it did not say is left exactly as
 * it was (the result count, "posted within", the boards, and anything the line
 * was silent on). Asking for jobs abroad also puts LinkedIn back among the
 * boards when a customized set left it out, because the worldwide pass runs on
 * LinkedIn alone and the form shows the box it ticks. Pure, so check-mirrors 95
 * EXECUTES it; it never searches. */
export function applySearchReading(prev: SearchContext | null, r: SearchQueryReading): SearchContext {
  const next: SearchContext = { ...(prev ?? { job_title: "", location: "", work_mode: "any", limit: 10 }) };
  const titles = (r.job_titles ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 5);
  if (titles.length) {
    next.job_titles = titles;
    next.job_title = titles[0];
  }
  if (r.location) next.location = r.location;
  if (r.work_mode) next.work_mode = joinWorkModes(parseWorkModes(r.work_mode));
  if (r.include_worldwide) {
    next.include_worldwide = true;
    if (next.sources?.length && !next.sources.includes("linkedin")) next.sources = [...next.sources, "linkedin"];
  }
  return next;
}

/** The sentences over the Jobs page's filtered list, counted per reason: how
 * many rows each one describes, and whether "Every job we found states a hiring
 * restriction abroad" is TRUE of this result.
 *
 * ONE list on the wire, three reasons in it (Phase 30 J added `market`), so the
 * count is taken PER REASON here rather than a list per reason being asked for
 * on the API, and each reason is tested BY NAME. `reason` defaults to
 * "restriction" on the backend and is absent on a pre-Phase-28 response, so a
 * restriction is `!reason || reason === "restriction"`; the old count,
 * "everything not literally closed", called a posting hidden for its country's
 * pay a hiring restriction it never stated.
 *
 * Pure, so check-mirrors 31 EXECUTES it over every mix of reasons. */
export function filteredSummary(result: Pick<JobSearchResult, "matches" | "skipped" | "filtered">): {
  restricted: number;
  closed: number;
  market: number;
  workMode: number;
  notRemote: number;
  everyRestricted: boolean;
} {
  const filtered = result.filtered ?? [];
  const restricted = filtered.filter((j) => !j.reason || j.reason === "restriction").length;
  const closed = filtered.filter((j) => j.reason === "closed").length;
  const market = filtered.filter((j) => j.reason === "market").length;
  // 2026-09-22: a posting that states only work modes the user did not pick, and a
  // worldwide one that does not say it is remote. Each BY NAME, like the rest.
  const workMode = filtered.filter((j) => j.reason === "work_mode").length;
  const notRemote = filtered.filter((j) => j.reason === "not_remote").length;
  // "Every job we found states a hiring restriction abroad" is a claim about
  // EVERY row, so it is tested as one: `restricted === filtered.length`. Listing
  // the other reasons instead (`closed === 0 && market === 0`) went false for a
  // row whose reason this build has never heard of, which a tab opened before a
  // deploy reads from a newer backend.
  const everyRestricted =
    restricted > 0 &&
    restricted === filtered.length &&
    result.matches.length === 0 &&
    result.skipped === 0;
  return { restricted, closed, market, workMode, notRemote, everyRestricted };
}
