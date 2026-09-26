import type { ResumeModel } from "../types";
import { resumeLanguage } from "./lang";

/** Human-readable label for a saved master resume, derived from the contact
 * name, in the resume's own language (labels are stored, not translated).
 * Here rather than in `hooks/useSaveMasterResume` since PLAN 31.6/2: the store's
 * autosave names a resume saved from a blank page, and a store importing a hook
 * module would drag the toast layer and i18n into every store probe. */
export function masterResumeLabel(resume: ResumeModel): string {
  const name = resume.contact.name;
  if (resumeLanguage(resume) === "he") {
    return name ? `קורות החיים של ${name}` : "קורות החיים שלי";
  }
  return name ? `${name}'s resume` : "My resume";
}
