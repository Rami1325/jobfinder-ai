import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

export const LANGUAGES = ["en", "he"] as const;
export type Language = (typeof LANGUAGES)[number];

// PLAN 12.5b: locale catalogs are code-split — only the active language rides
// the critical path (~80 kB of JSON per language leaves the entry chunk).
// import.meta.glob turns every namespace file into its own lazy chunk.
const catalogs = import.meta.glob<{ default: Record<string, unknown> }>("./locales/*/*.json");

const loaded = new Set<string>();

export async function loadLanguage(lng: Language): Promise<void> {
  if (loaded.has(lng)) return;
  const prefix = `./locales/${lng}/`;
  await Promise.all(
    Object.entries(catalogs)
      .filter(([path]) => path.startsWith(prefix))
      .map(async ([path, load]) => {
        const ns = path.slice(prefix.length).replace(/\.json$/, "");
        i18n.addResourceBundle(lng, ns, (await load()).default, true, true);
      }),
  );
  loaded.add(lng);
}

/** Switch the app language, loading its catalogs first so no keys flash. */
export async function setLanguage(lng: Language): Promise<void> {
  await loadLanguage(lng);
  await i18n.changeLanguage(lng);
}

/** Keep <html lang dir> in sync — Hebrew flips the whole app to RTL.
 * The inline script in index.html sets the same attributes before first
 * paint; this keeps them correct across runtime language switches. */
function syncDocument(lng: string) {
  const lang = lng.split("-")[0];
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
}

/** Initialize i18next, then load the active language's catalogs. main.tsx
 * awaits this before the first render, so translations are always present
 * by the time anything calls t(). */
export async function initI18n(): Promise<void> {
  await i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: {}, // catalogs stream in via addResourceBundle
      partialBundledLanguages: true,
      fallbackLng: "en",
      supportedLngs: [...LANGUAGES],
      load: "languageOnly", // "he-IL" -> "he"
      defaultNS: "common",
      interpolation: { escapeValue: false }, // React already escapes
      detection: {
        order: ["localStorage", "navigator"],
        caches: ["localStorage"],
        lookupLocalStorage: "lang", // kept in sync with the no-flash script in index.html
      },
    });
  // `i18n.language`, NOT `i18n.resolvedLanguage` — and the difference is the
  // whole bug this line used to have. i18next only assigns `resolvedLanguage`
  // to a language the STORE ALREADY HAS TRANSLATIONS FOR (`if
  // (this.store.hasLanguageSomeTranslations(lngInLngs))`). We init with
  // `resources: {}` and stream the catalogs in afterwards via
  // `addResourceBundle`, so at this point no language qualifies and
  // `resolvedLanguage` is *always* undefined — which made `?? "en"` the answer
  // on every single first load. The detector read "he" out of localStorage
  // correctly and this line threw it away, so a user who picked Hebrew got
  // English back on the next page load, forever, in the primary market.
  // `language` is what the detector actually sets, and it is set by now.
  const detected = (i18n.language ?? "en").split("-")[0];
  const active: Language = (LANGUAGES as readonly string[]).includes(detected)
    ? (detected as Language)
    : "en";
  await loadLanguage(active);
  // The catalogs are in the store now, so re-resolve: `resolvedLanguage` is
  // still undefined until something recomputes it, and LanguageSwitch decides
  // which way it points from exactly that property. Registering the
  // languageChanged listener below rather than above keeps this from
  // double-firing syncDocument.
  await i18n.changeLanguage(active);
  // Hebrew falls back to English on any missing key (the catalogs are
  // parity-checked, so this is a safety net) — warm the fallback off the
  // critical path.
  if (active !== "en") void loadLanguage("en");
  syncDocument(active);
  i18n.on("languageChanged", syncDocument);
}

export default i18n;
