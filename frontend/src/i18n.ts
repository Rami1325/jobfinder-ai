import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import enCommon from "./locales/en/common.json";
import enInterview from "./locales/en/interview.json";
import enJobs from "./locales/en/jobs.json";
import enMarketing from "./locales/en/marketing.json";
import enScan from "./locales/en/scan.json";
import enTailor from "./locales/en/tailor.json";
import enTools from "./locales/en/tools.json";
import enTracker from "./locales/en/tracker.json";
import heCommon from "./locales/he/common.json";
import heInterview from "./locales/he/interview.json";
import heJobs from "./locales/he/jobs.json";
import heMarketing from "./locales/he/marketing.json";
import heScan from "./locales/he/scan.json";
import heTailor from "./locales/he/tailor.json";
import heTools from "./locales/he/tools.json";
import heTracker from "./locales/he/tracker.json";

export const LANGUAGES = ["en", "he"] as const;
export type Language = (typeof LANGUAGES)[number];

const resources = {
  en: {
    common: enCommon,
    marketing: enMarketing,
    scan: enScan,
    jobs: enJobs,
    tailor: enTailor,
    interview: enInterview,
    tools: enTools,
    tracker: enTracker,
  },
  he: {
    common: heCommon,
    marketing: heMarketing,
    scan: heScan,
    jobs: heJobs,
    tailor: heTailor,
    interview: heInterview,
    tools: heTools,
    tracker: heTracker,
  },
} as const;

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
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

/** Keep <html lang dir> in sync — Hebrew flips the whole app to RTL.
 * The inline script in index.html sets the same attributes before first
 * paint; this keeps them correct across runtime language switches. */
function syncDocument(lng: string) {
  const lang = lng.split("-")[0];
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
}
syncDocument(i18n.resolvedLanguage ?? "en");
i18n.on("languageChanged", syncDocument);

export default i18n;
