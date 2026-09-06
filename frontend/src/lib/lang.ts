import type { ResumeModel } from "../types";

// Hebrew block U+0590-U+05FF: letters incl. finals, niqqud, geresh.
const HEBREW_RE = new RegExp("[\\u0590-\\u05FF]");

/** Language a resume is written in — mirrors backend `app/core/lang.py`:
 * only prose fields count (summary, skills, titles, bullets, project /
 * education text), so an English resume at a Hebrew-named employer stays "en". */
export function resumeLanguage(resume: ResumeModel): "he" | "en" {
  const parts: string[] = [resume.summary, resume.skills.join(" ")];
  for (const exp of resume.experience) {
    parts.push(exp.title, ...exp.bullets);
  }
  for (const proj of resume.projects) {
    parts.push(proj.description, ...proj.bullets);
  }
  for (const edu of resume.education) {
    parts.push(edu.degree, edu.field, edu.details);
  }
  for (const ms of resume.military_service ?? []) {
    parts.push(ms.role, ...ms.bullets);
  }
  return HEBREW_RE.test(parts.join(" ")) ? "he" : "en";
}
