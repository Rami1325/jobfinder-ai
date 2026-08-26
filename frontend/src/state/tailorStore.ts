// Module-level store for the Tailor flow so an in-flight tailor run survives
// route changes: TailorPage unmounts when the user navigates away, but the
// request promise and everything on screen (résumé, JD, results, tracker
// state) live here, not in component state, and are intact when they return.
import { analyzeJD, getMasterResume, tailor } from "../api/client";
import { apiErrorMessage } from "../lib/apiError";
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
