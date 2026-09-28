// "Look for gigs on" (2026-09-28, freelance): a row of plain links to the
// freelance platforms' OWN search pages, the search's title filled in. JobFinder
// never fetches, reads or stores those pages: each is an <a target="_blank">
// the person follows (components/GigLinks.tsx). Most listed freelance work in
// Israel is on platforms JobFinder may not read (XPlace waits on its written
// permission; Upwork's and Arc's terms forbid automated access), so the honest
// help is the door, not a copy of the room.
//
// Every template is from the freelance research's verified table (probed
// 2026-09-28 from an Israeli IP: each answered 200, or the platform's own search
// form uses that parameter; job-search.md, *Look for gigs on*). Nothing here is
// invented, and check-mirrors 105 holds each built link to that table: https, an
// allowlisted host, and the title, URL-encoded, in the platform's own parameter
// (a title holding & # / ? = cannot add a parameter or a fragment).
//
// Dependency-free but for lib/lang.ts, so check-mirrors can execute it.
import { textLanguage } from "./lang";

export type GigLang = "en" | "he";
export type GigField = "design" | "translation";
export type GigLink = { id: GigSiteId; name: string; href: string };

type GigSite = {
  /** The brand as it writes itself (Latin letters where that is its name). */
  name: string;
  /** Only where the brand has a Hebrew name of its own. */
  nameHe?: string;
  /** Its search, handed an ALREADY-ENCODED query; null when it has none. */
  search: ((q: string) => string) | null;
  /** Where it opens with no title, or with a title it cannot search. */
  general: string;
  /** Searches in English only: a Hebrew title opens its general page. */
  latinOnly: boolean;
};

const ALLJOBS = "https://www.alljobs.co.il/SearchResultsGuest.aspx?page=1&position=&type=10&freetxt=";

export const GIG_SITES = {
  xplace: {
    name: "XPlace",
    search: (q) => `https://www.xplace.com/jobs?q=${q}`,
    general: "https://www.xplace.com/jobs?q=",
    latinOnly: false,
  },
  upwork: {
    name: "Upwork",
    search: (q) => `https://www.upwork.com/nx/search/jobs/?q=${q}`,
    general: "https://www.upwork.com/nx/search/jobs/?q=",
    latinOnly: true,
  },
  // `f_JT=C` asks for contract work; LinkedIn's logged-out search ignores it (the
  // freelance search measured that), a signed-in one is not measured.
  linkedin: {
    name: "LinkedIn",
    search: (q) => `https://www.linkedin.com/jobs/search/?keywords=${q}&f_JT=C`,
    general: "https://www.linkedin.com/jobs/search/?keywords=&f_JT=C",
    latinOnly: false,
  },
  // Its general page is its own contract list ("Remote Contract and Part-Time Jobs").
  weworkremotely: {
    name: "We Work Remotely",
    search: (q) => `https://weworkremotely.com/remote-jobs/search?term=${q}`,
    general: "https://weworkremotely.com/remote-contract-jobs",
    latinOnly: true,
  },
  arc: {
    name: "Arc",
    search: (q) => `https://arc.dev/remote-jobs?search=${q}`,
    general: "https://arc.dev/remote-jobs",
    latinOnly: true,
  },
  // AllJobs' freelance list (`type=10`, "דרושים פרילנס").
  alljobs: {
    name: "AllJobs",
    search: (q) => `${ALLJOBS}${q}&city=&region=`,
    general: `${ALLJOBS}&city=&region=`,
    latinOnly: false,
  },
  dribbble: {
    name: "Dribbble",
    search: (q) => `https://dribbble.com/jobs?keyword=${q}&anywhere=true`,
    general: "https://dribbble.com/jobs",
    latinOnly: true,
  },
  behance: {
    name: "Behance",
    search: (q) => `https://www.behance.net/joblist?search=${q}`,
    general: "https://www.behance.net/joblist",
    latinOnly: true,
  },
  proz: { name: "ProZ.com", search: null, general: "https://www.proz.com/translation-jobs", latinOnly: false },
  ita: { name: "ITA", nameHe: "איגוד המתרגמים", search: null, general: "https://ita.org.il/", latinOnly: false },
} satisfies Record<string, GigSite>;

export type GigSiteId = keyof typeof GIG_SITES;

/** The row for a title in English, and for one in Hebrew: Upwork and Arc search
 * in English only, so a Hebrew title gets AllJobs' freelance list in their place
 * (We Work Remotely stays, on its own contract list). */
export const GIG_SETS: Record<GigLang, readonly GigSiteId[]> = {
  en: ["xplace", "upwork", "linkedin", "weworkremotely", "arc"],
  he: ["xplace", "alljobs", "linkedin", "weworkremotely"],
};
/** Added at the end of the row for a design or a translation title. */
export const GIG_EXTRAS: Record<GigField, readonly GigSiteId[]> = {
  design: ["dribbble", "behance"],
  translation: ["proz", "ita"],
};

// The word Israelis search LinkedIn with, put before a Hebrew title unless the
// title already says it (the freelance search's own rule, job_search.freelance_title).
const FREELANCE_HE = "פרילנס";
const SAYS_FREELANCE = /פרילנס|פרילאנס|\b(?:freelance|freelancer|contract|contractor)\b/i;

// A Latin word needs a word boundary on both sides ("logo" is inside "logistics");
// a Hebrew word may carry up to two prefix letters (ב/ל/ה/ו/מ/ש/כ) and must not
// run on into another Hebrew letter, so "גרפי" is not read inside "גאוגרפיה" or
// "גרפים" (the house rule for Hebrew, as `search_query.py` reads places).
const heWords = (words: string): RegExp =>
  new RegExp(`(?<![\\u05D0-\\u05EA])[בלהומשכ]{0,2}(?:${words})(?![\\u05D0-\\u05EA])`);
const DESIGN_LATIN = /\b(?:graphic|illustrator|illustration|logo|ux|(?:ui|product|web|visual|motion|brand)[\s/-]+designer)\b/i;
const DESIGN_HE = heWords("גרפי|גרפית|גרפיקה|גרפיקאי|גרפיקאית|מאייר|מאיירת|איור|איורים|לוגו");
const DESIGN_HE_ROLE = /מעצב(?:ת|\/ת)?\s+(?:אתרים|מוצר|ממשק|ממשקים|ui|ux)(?![א-תa-z])/i;
const TRANSLATION_LATIN = /\b(?:translator|translators|translation|translations|translating|interpreter|interpreters|interpreting)\b/i;
const TRANSLATION_HE = heWords("מתרגם|מתרגמת|תרגום|תרגומים|מתורגמן|מתורגמנית");

/** A design or a translation title, read from a small word list in both
 * languages (never a guess): "Graphic Designer", "מעצב/ת גרפי/ת", "UI/UX",
 * "Translator", "מתרגמת". Hardware design ("ASIC Design Engineer"), a
 * hairdresser ("מעצבת שיער"), a TA ("מתרגל/ת") and translational research are
 * none of them. */
export function gigField(title: string | null | undefined): GigField | null {
  const t = (title ?? "").trim();
  if (!t) return null;
  if (DESIGN_LATIN.test(t) || DESIGN_HE.test(t) || DESIGN_HE_ROLE.test(t)) return "design";
  if (TRANSLATION_LATIN.test(t) || TRANSLATION_HE.test(t)) return "translation";
  return null;
}

function queryFor(id: GigSiteId, title: string, lang: GigLang): string {
  if (id === "linkedin" && lang === "he") return SAYS_FREELANCE.test(title) ? title : `${FREELANCE_HE} ${title}`.trim();
  return title;
}

/**
 * The row for a search title. The title's own letters choose the set (any Hebrew
 * letter is a Hebrew title, `textLanguage`: Upwork and Arc could not match a
 * query holding one Hebrew word); with no title the page's language does, and
 * every link opens the platform's general search or freelance page. The query is
 * URL-encoded whole into the platform's own parameter.
 */
export function gigLinks(title: string | null | undefined, uiLang: string): GigLink[] {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  const lang: GigLang = t ? textLanguage(t) : uiLang.startsWith("he") ? "he" : "en";
  const field = gigField(t);
  const ids = [...GIG_SETS[lang], ...(field ? GIG_EXTRAS[field] : [])];
  const hebrewUi = uiLang.startsWith("he");
  return ids.map((id) => {
    const site: GigSite = GIG_SITES[id];
    const q = queryFor(id, t, lang);
    const readable = !(site.latinOnly && lang === "he");
    const href = site.search && q && readable ? site.search(encodeURIComponent(q)) : site.general;
    return { id, name: hebrewUi && site.nameHe ? site.nameHe : site.name, href };
  });
}
