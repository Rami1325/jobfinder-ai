import type { ResumeModel } from "../types";

// Mirrors the backend scorer's tokenizer (app/core/scorer.py::_WORD_RE): Latin
// word chars, digits, +#. (C++, C#, .NET) plus the Hebrew block so Hebrew
// keywords count correctly. Used as a boundary class so "Java" ≠ "JavaScript".
const WORD_CLASS = "a-z0-9+#.\\u0590-\\u05FF";

/** Case-insensitive whole-phrase matcher with token boundaries. */
export function keywordRegex(keyword: string): RegExp | null {
  const kw = keyword.trim();
  if (!kw) return null;
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![${WORD_CLASS}])${escaped}(?![${WORD_CLASS}])`, "gi");
}

/** Verbatim (whole-phrase) occurrence count of a keyword in free text. */
export function countOccurrences(keyword: string, text: string): number {
  const re = keywordRegex(keyword);
  if (!re || !text) return 0;
  return (text.match(re) ?? []).length;
}

/**
 * Flatten a résumé to searchable text the same way the backend scorer does
 * (app/core/scorer.py::_resume_text), so displayed counts line up with the
 * covered/partial/missing statuses it computed.
 */
export function resumeSearchText(resume: ResumeModel): string {
  const parts: string[] = [resume.summary, resume.skills.join(" "), resume.certifications.join(" ")];
  for (const exp of resume.experience) parts.push(exp.title, exp.company, ...exp.bullets);
  for (const proj of resume.projects) parts.push(proj.name, proj.description, ...proj.bullets);
  for (const edu of resume.education) parts.push(edu.degree, edu.field, edu.institution, edu.details);
  return parts.join(" ");
}
