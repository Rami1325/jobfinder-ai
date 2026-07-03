// Module-level store for the Tailor flow so an in-flight tailor run survives
// route changes: TailorPage unmounts when the user navigates away, but the
// request promise and everything on screen (résumé, JD, results, tracker
// state) live here, not in component state, and are intact when they return.
import { analyzeJD, tailor } from "../api/client";
import type { FactsLedger, JDModel, ResumeModel, TailorResult } from "../types";

export type TailorState = {
  resume: ResumeModel | null;
  ledger: FactsLedger | null;
  masterLabel: string;
  jdText: string;
  jd: JDModel | null;
  result: TailorResult | null;
  loading: boolean;
  error: string;
  saved: boolean;
  savedAppId: number | null;
  applyClicked: boolean;
  applied: boolean;
  coverLetterText: string;
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
  loading: false,
  error: "",
  saved: false,
  savedAppId: null,
  applyClicked: false,
  applied: false,
  coverLetterText: "",
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
    error: "",
    saved: false,
    savedAppId: null,
    applyClicked: false,
    applied: false,
    coverLetterText: "",
  });
}

let seq = 0; // a restarted tailor must not be overwritten by a stale response

export function startTailor(): void {
  const { resume, jdText } = state;
  if (!resume || state.loading) return;
  const id = ++seq;
  setTailorState({ loading: true, error: "", result: null, saved: false, coverLetterText: "" });
  (async () => {
    const analyzed = await analyzeJD(jdText);
    if (id !== seq) return;
    setTailorState({ jd: analyzed });
    const r = await tailor(resume, analyzed);
    if (id === seq) setTailorState({ loading: false, result: r });
  })().catch((e: any) => {
    if (id === seq)
      setTailorState({
        loading: false,
        error: e?.response?.data?.detail || "Something went wrong. Is the backend running?",
      });
  });
}
