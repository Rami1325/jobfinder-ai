import type { ResumeModel } from "../types";

// Hebrew block U+0590-U+05FF: letters incl. finals, niqqud, geresh.
const HEBREW_RE = new RegExp("[\\u0590-\\u05FF]");
const HEBREW_WORD_RE = new RegExp("[\\u0590-\\u05FF]+", "g");
const LATIN_WORD_RE = /[A-Za-z]+/g;

/** A resume is Hebrew when at least one word in this many of its prose is
 * Hebrew — backend `app/core/lang.py::HEBREW_SHARE_DEN`, where the measurement
 * behind it is recorded. check-mirrors 76 runs this file over the backend's
 * own cases (`backend/tests/fixtures/lang_cases.json`). */
const HEBREW_SHARE_DEN = 5;

/** "he" when the text contains ANY Hebrew letter, else "en" — the rule backend
 * `app/core/lang.py::detect_language` stamps `JDModel.language` with. One
 * Hebrew word is enough, which is why a caller adding text to a posting has to
 * ask this before it adds any. */
export function textLanguage(text: string): "he" | "en" {
  return HEBREW_RE.test(text) ? "he" : "en";
}

/** [Hebrew words, all words], a word being one script's run ("ב-Python" is
 * one of each). Digits and punctuation count for neither side. */
function hebrewWords(text: string): [number, number] {
  const hebrew = (text.match(HEBREW_WORD_RE) ?? []).length;
  return [hebrew, hebrew + (text.match(LATIN_WORD_RE) ?? []).length];
}

/** Language a resume is written in — mirrors backend `app/core/lang.py`:
 * only prose fields count (summary, titles, bullets, project / education
 * text), so an English resume at a Hebrew-named employer stays "en", and
 * skills vote only while there is no prose yet. One Hebrew word typed into an
 * English resume leaves it English (PLAN 31.6/1). */
export function resumeLanguage(resume: ResumeModel): "he" | "en" {
  const parts: string[] = [resume.summary ?? ""];
  const add = (...xs: (string | undefined | null)[]) => {
    for (const x of xs) parts.push(x ?? "");
  };
  for (const exp of resume.experience ?? []) add(exp.title, ...(exp.bullets ?? []));
  for (const proj of resume.projects ?? []) add(proj.description, ...(proj.bullets ?? []));
  for (const edu of resume.education ?? []) add(edu.degree, edu.field, edu.details);
  for (const ms of resume.military_service ?? []) add(ms.role, ...(ms.bullets ?? []));
  let [hebrew, words] = hebrewWords(parts.join(" "));
  if (!words) [hebrew, words] = hebrewWords((resume.skills ?? []).join(" "));
  return words && hebrew * HEBREW_SHARE_DEN >= words ? "he" : "en";
}
