// Module-level store for the Tailor flow so an in-flight tailor run survives
// route changes: TailorPage unmounts when the user navigates away, but the
// request promise and everything on screen (résumé, JD, results, tracker
// state) live here, not in component state, and are intact when they return.
import { analyzeJD, getMasterResume, saveMasterResume, tailor } from "../api/client";
import { resetMasterCache } from "../hooks/useMasterResume";
import { apiErrorMessage } from "../lib/apiError";
import { clearDraft, writeDraft } from "../lib/draft";
import { resumeLanguage } from "../lib/lang";
import type { FactsLedger, FitCheckResult, JDModel, ResumeModel, TailorResult } from "../types";

export type TailorState = {
  resume: ResumeModel | null;
  ledger: FactsLedger | null;
  masterLabel: string;
  jdText: string;
  jd: JDModel | null;
  result: TailorResult | null;
  // Snapshot of the résumé the current `result` was tailored FROM — the diff
  // baseline. `resume` can be replaced by a later upload; this cannot.
  tailoredFrom: ResumeModel | null;
  // Edit ids (lib/resumeDiff) the user rejected; everything else is accepted.
  rejectedEdits: string[];
  loading: boolean;
  error: string;
  saved: boolean;
  savedAppId: number | null;
  applyClicked: boolean;
  applied: boolean;
  coverLetterText: string;
  // Set when the JD's language differed from the loaded résumé and a saved
  // master in the JD's language was swapped in ("he" | "en"); null otherwise.
  langSwitched: "he" | "en" | null;
  // "Check fit" before any tailoring: the reading, and the exact posting text it
  // was taken for. Re-checking the same text would spend a credit to learn
  // nothing, so the overlay compares against `checkedFor` rather than assuming.
  fit: FitCheckResult | null;
  checkedFor: string | null;
  // When the fit reading was taken, epoch ms — stamped on the CLIENT. It is not
  // a field on the backend `Score` on purpose: `Score` is persisted inside kit
  // result JSON, and validating a stored kit substitutes schema defaults, so a
  // new field would read as empty on every pre-existing row forever. This store
  // dies on reload, so a reading can never outlive its stamp.
  scoredAt: number | null;
  overlayOpen: boolean;
  // --- block editing (22.8) --------------------------------------------- //
  // The last SAVED state of the master, and the only honest baseline for "is
  // this dirty". Seeded from the server's copy on load and after every save —
  // never from the local draft, because the model validator can append to the
  // flat skills union, and a local baseline it cannot match leaves the document
  // reading dirty forever.
  savedResume: ResumeModel | null;
  /** Previous states, newest last. Local undo; the server versions are the
   * undo of last resort and are only written on an explicit save. */
  editUndo: ResumeModel[];
  editSaving: boolean;
  editError: string;
  // Target job carried over from the Jobs page ("Tailor to this").
  jobUrl?: string;
  jobTitle?: string;
  company?: string;
};

let state: TailorState = {
  resume: null,
  ledger: null,
  masterLabel: "",
  jdText: "",
  jd: null,
  result: null,
  tailoredFrom: null,
  rejectedEdits: [],
  loading: false,
  error: "",
  saved: false,
  savedAppId: null,
  applyClicked: false,
  applied: false,
  coverLetterText: "",
  langSwitched: null,
  fit: null,
  checkedFor: null,
  scoredAt: null,
  overlayOpen: false,
  savedResume: null,
  editUndo: [],
  editSaving: false,
  editError: "",
};

const listeners = new Set<() => void>();

export function setTailorState(patch: Partial<TailorState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getTailorState(): TailorState {
  return state;
}

export function subscribeTailor(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let consumedNavKey = ""; // each router navigation has a unique key — apply its state once

/** Load a target job handed over by navigation (Jobs page → "Tailor to this").
 * Keyed by the router location key so revisiting the same history entry
 * (back/forward) doesn't wipe in-progress work a second time. */
export function setTargetJob(
  navKey: string,
  target: { jdText?: string; jobUrl?: string; jobTitle?: string; company?: string },
): void {
  if (navKey === consumedNavKey) return;
  consumedNavKey = navKey;
  setTailorState({
    jdText: target.jdText ?? "",
    jobUrl: target.jobUrl,
    jobTitle: target.jobTitle,
    company: target.company,
    jd: null,
    result: null,
    tailoredFrom: null,
    rejectedEdits: [],
    error: "",
    saved: false,
    savedAppId: null,
    applyClicked: false,
    applied: false,
    coverLetterText: "",
    langSwitched: null,
  });
}

let seq = 0; // a restarted tailor must not be overwritten by a stale response

export function startTailor(): void {
  const { resume, jdText } = state;
  if (!resume || state.loading) return;
  const id = ++seq;
  setTailorState({
    loading: true,
    error: "",
    result: null,
    tailoredFrom: resume,
    rejectedEdits: [],
    saved: false,
    coverLetterText: "",
    langSwitched: null,
  });
  (async () => {
    // Reuse the posting we already read. `/jobs/fit` hands its analysed JD back
    // for exactly this reason, so "check fit, then tailor" costs the same one
    // credit as tailoring straight away — which is what the overlay promises.
    const prior = state.checkedFor !== null && state.checkedFor === jdText.trim() ? state.jd : null;
    const analyzed = prior ?? (await analyzeJD(jdText));
    if (id !== seq) return;
    setTailorState({ jd: analyzed });
    // Paired he/en masters: a Hebrew JD is tailored from the Hebrew résumé (and
    // vice versa) when one is saved — otherwise stick with what's loaded.
    let useResume = resume;
    const jdLang = analyzed.language === "he" ? "he" : "en";
    if (jdLang !== resumeLanguage(resume)) {
      try {
        const paired = await getMasterResume(jdLang);
        if (id !== seq) return;
        if (paired?.resume) {
          useResume = paired.resume;
          setTailorState({
            resume: paired.resume,
            ledger: paired.ledger ?? null,
            masterLabel: paired.label,
            tailoredFrom: paired.resume,
            langSwitched: jdLang,
          });
        }
      } catch {
        /* older backend or no paired master — keep the loaded résumé */
      }
    }
    const r = await tailor(useResume, analyzed);
    if (id === seq) setTailorState({ loading: false, result: r, scoredAt: Date.now() });
  })().catch((e: unknown) => {
    if (id === seq)
      setTailorState({
        loading: false,
        error: apiErrorMessage(e, "Something went wrong. Is the backend running?"),
      });
  });
}


// --------------------------------------------------------------------------- //
// Block editing (22.8)
// --------------------------------------------------------------------------- //

/**
 * Replace the master résumé with an edited copy.
 *
 * The invalidation here is the dangerous part, and every line of it is load
 * bearing: a fit reading and a tailor result both describe the document as it
 * was, and leaving either up after an edit means showing a number about a
 * résumé that no longer exists. `checkedFor` has to go too, or the overlay
 * suppresses the re-check that would fix it as "already read this posting".
 */
export function applyBlockEdit(next: ResumeModel): void {
  const prev = state.resume;
  if (!prev) return;
  setTailorState({
    resume: next,
    // Cap the stack: this is an undo, not a history, and a résumé is not small.
    editUndo: [...state.editUndo, prev].slice(-30),
    editError: "",
    fit: null,
    checkedFor: null,
    scoredAt: null,
    result: null,
    tailoredFrom: null,
    rejectedEdits: [],
  });
  // Mirror to this device. HERE rather than at the call sites so a future edit
  // path cannot forget it — this function is the single writer of `resume`
  // during editing, which is the same reason the invalidation above lives here.
  writeDraft(next);
}

export function undoBlockEdit(): void {
  const stack = state.editUndo;
  if (stack.length === 0) return;
  const back = stack[stack.length - 1];
  setTailorState({ resume: back, editUndo: stack.slice(0, -1), editError: "" });
  // Undo has to move the draft too, or closing the tab restores the very edit
  // the user just took back. Undoing to the bottom of the stack means the
  // document matches the saved master again, so there is nothing to restore.
  if (stack.length === 1) clearDraft();
  else writeDraft(back);
}

/** True when the document on screen differs from the last saved state. */
export function hasUnsavedEdits(): boolean {
  return state.editUndo.length > 0;
}

/**
 * Persist the edited master. Explicit, never automatic.
 *
 * Deliberately NOT `useSaveMasterResume`: that hook's bare `catch {}` makes a
 * 401, a 502 and being offline indistinguishable, and returns null. It is fine
 * for its documented best-effort use — persisting a freshly parsed résumé — and
 * exactly wrong behind a Save button, where the user is relying on the result.
 *
 * No `ledger` is sent. The backend rebuilds it from the résumé when none is
 * given, which is what we want: the user typed these facts, so the résumé IS
 * the source of truth. Passing the LOADED ledger through would store facts
 * describing the PRE-edit résumé, and the fabrication guard reads the stored
 * ledger — a corrected employer would then read as an invention forever.
 */
export async function commitResumeEdits(label: string, fallbackError: string): Promise<boolean> {
  const resume = state.resume;
  if (!resume || state.editSaving) return false;
  setTailorState({ editSaving: true, editError: "" });
  try {
    const saved = await saveMasterResume({ resume, label });
    setTailorState({
      // Seed BOTH from the server's copy, never from the local object.
      resume: saved.resume,
      savedResume: saved.resume,
      masterLabel: saved.label,
      editUndo: [],
      editSaving: false,
      editError: "",
    });
    // The draft has served its purpose the moment the server has the content.
    // Leaving it would offer to "restore" the résumé the user just saved.
    clearDraft();
    // `invalidateData` cannot reach useMasterResume's module-level cache, and
    // nine pages read the master from it — an X-ray run right after an edit
    // would otherwise scan the résumé that was just replaced.
    resetMasterCache();
    return true;
  } catch (e: unknown) {
    setTailorState({ editSaving: false, editError: apiErrorMessage(e, fallbackError) });
    return false;
  }
}
