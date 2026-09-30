// How a changelog entry reads on the page: its section's name and the sentence
// before its reason. Pure, so check-mirrors 121 can run it.
import type { EditSection } from "./resumeDiff";

/** A changelog entry's free-text section, as the review's `EditSection`. The
 * model writes these ("summary", "Professional summary", "Work experience"), and
 * the pipeline adds its own ("skills", "keywords", "languages"); one without a
 * section of its own stays in the notes, never dropped. */
const REASON_SECTION: [RegExp, EditSection][] = [
  [/headline|title line/, "headline"],
  [/summary|profile|about/, "summary"],
  [/skill/, "skills"],
  [/military|service/, "militaryService"],
  [/experience|role|work|position|employment/, "experience"],
  [/project/, "projects"],
  [/education|degree/, "education"],
  [/certif/, "certifications"],
  [/language/, "languages"],
  [/contact/, "contact"],
];

export function reasonSection(section: string): EditSection | null {
  const s = section.trim().toLowerCase();
  for (const [re, key] of REASON_SECTION) if (re.test(s)) return key;
  return null;
}

/** The `tailor` key that names a note's section in the reader's language, or
 * null for a section the model wrote in its own words, which is printed as
 * written (the model writes in the resume's language). The notes printed the
 * raw key, so the Hebrew page labelled the pipeline's notes "keywords" and
 * "skills". `keywords` is the pipeline's section for the keyword notes
 * (`core/tailor.py`), which is no section of the resume. */
export function noteSectionKey(section: string): string | null {
  const s = reasonSection(section);
  if (s) return `sections.${s}`;
  return section.trim().toLowerCase() === "keywords" ? "report.title" : null;
}

/** A change printed before ". Why: …", without its own closing full stop. The
 * model ends some changes with one, and the page printed "Senior Product
 * Manager.. Why:". Only full stops at the very end go: "v2.0" is a word. */
export function changeLead(change: string): string {
  return change.replace(/[\s.]+$/, "");
}
