import type { ResumeModel } from "../types";
import { resumeLanguage } from "./lang";

const KEY = "jobfinder.resumeDraft";

/** Older than this and the draft is dropped rather than offered.
 *
 * Not a tidiness rule. A resume the user edited months ago and abandoned is
 * content they have forgotten writing, and offering to "restore" it reads as
 * the app inventing changes. Generous enough that a real interruption — a
 * closed laptop, a week off — still gets its work back. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface ResumeDraft {
  /** The resume's OWN language, not the UI locale. See `offerDraft`. */
  language: "he" | "en";
  resume: ResumeModel;
  savedAt: number;
}

/** Key-order-independent equality, so a round trip through JSON cannot make an
 * identical resume look changed and produce a restore prompt that does nothing. */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

export function sameResume(a: ResumeModel, b: ResumeModel): boolean {
  return stable(a) === stable(b);
}

/** Mirror the edited resume to this device. Called from `applyBlockEdit`, so a
 * new edit path cannot forget it. Best-effort by design: private mode and a
 * full quota both throw, and neither is worth failing an edit over — the
 * in-session bar still covers everything except closing the tab. */
export function writeDraft(resume: ResumeModel): void {
  try {
    const draft: ResumeDraft = { language: resumeLanguage(resume), resume, savedAt: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    /* no draft this session; the document on screen is unaffected */
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do — a stale draft is filtered on read anyway */
  }
}

/** Read a structurally-valid, in-date draft, or null. Anything unparseable or
 * expired is REMOVED rather than returned: a draft that fails this check can
 * never become useful, and leaving it costs a parse on every load. */
export function readDraft(): ResumeDraft | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as ResumeDraft;
    const r = d?.resume as Partial<ResumeModel> | undefined;
    const structural =
      !!r &&
      typeof r === "object" &&
      !!r.contact &&
      Array.isArray(r.experience) &&
      Array.isArray(r.education) &&
      Array.isArray(r.projects) &&
      Array.isArray(r.skills);
    if (!structural || (d.language !== "he" && d.language !== "en") || typeof d.savedAt !== "number") {
      clearDraft();
      return null;
    }
    if (Date.now() - d.savedAt > MAX_AGE_MS) {
      clearDraft();
      return null;
    }
    return d;
  } catch {
    clearDraft();
    return null;
  }
}

/**
 * Should this draft be offered against the master that just loaded?
 *
 * THE LANGUAGE RULE IS NOT COSMETIC. There is one master row per language, and
 * `PUT /profile/resume` picks the row by DETECTED language and carries no id —
 * so restoring a Hebrew draft on top of the English master and pressing Save
 * writes over the *Hebrew* CV and leaves the one on screen untouched. That is
 * the same hazard `ResumeEditBar` guards at save time; this refuses to create
 * it in the first place. A mismatched draft is KEPT, not deleted: the user may
 * simply be looking at the other language slot right now.
 */
export function offerDraft(draft: ResumeDraft | null, master: ResumeModel): boolean {
  if (!draft) return false;
  if (draft.language !== resumeLanguage(master)) return false;
  return !sameResume(draft.resume, master);
}

/**
 * The resume to restore, merged OVER the loaded master.
 *
 * Field-by-field fallback rather than the stored object wholesale, and the
 * reason is check 1's bug in a different costume: a draft written before a
 * `ResumeModel` field existed simply has no such key, and restoring it raw
 * would silently delete that field from the document — exactly how `headline`
 * and `skill_groups` disappeared from the download in 22.1. Absent keys fall
 * back to the master; keys the draft genuinely holds (including empty arrays)
 * win. No version stamp to remember to bump.
 */
export function draftOver(master: ResumeModel, draft: ResumeDraft): ResumeModel {
  return { ...master, ...draft.resume };
}
