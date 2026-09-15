// Module-level store for the Tailor flow so an in-flight tailor run survives
// route changes: TailorPage unmounts when the user navigates away, but the
// request promise and everything on screen (resume, JD, results, tracker
// state) live here, not in component state, and are intact when they return.
import { analyzeJD, getMasterResume, saveMasterResume, tailor } from "../api/client";
import { resetMasterCache } from "../hooks/useMasterResume";
import { apiErrorMessage } from "../lib/apiError";
import { clearDraft, writeDraft } from "../lib/draft";
import { resumeLanguage } from "../lib/lang";
import type { Overrides } from "../lib/resumeOverrides";
import type {
  FactsLedger,
  FitCheckResult,
  JDModel,
  MasterResume,
  ResumeModel,
  TailorResult,
} from "../types";

export type TailorState = {
  resume: ResumeModel | null;
  ledger: FactsLedger | null;
  masterLabel: string;
  jdText: string;
  jd: JDModel | null;
  result: TailorResult | null;
  // Snapshot of the resume the current `result` was tailored FROM — the diff
  // baseline. `resume` can be replaced by a later upload; this cannot.
  tailoredFrom: ResumeModel | null;
  // Edit ids (lib/resumeDiff) the user rejected; everything else is accepted.
  rejectedEdits: string[];
  /**
   * The user's own edits to the TAILORED document, keyed by SOURCE ANCHOR and
   * NEVER by block path.
   *
   * `mergeForReview` recomputes the effective resume on every accept and
   * decline, and a rejected removal shifts every later index in its section, so
   * a path-keyed store writes the typed sentence onto a different bullet the
   * first time any decision in that section is toggled. The anchor is the
   * block's coordinate in the original/tailored resume, which is frozen while a
   * result is up. See `lib/resumeOverrides.ts` for the executed proof.
   *
   * This is an OVERLAY on one application's CV. It never touches `resume`, it
   * is never mirrored into the 22.11 local draft (that draft is the MASTER's,
   * and `draftOver` spreads it over the master), and it dies with the result.
   *
   * IT LIVES IN MODULE MEMORY AND NOWHERE ELSE, and that is a decision with a
   * cost the UI has to carry: no draft mirror (correct — the draft is the
   * master's), no sessionStorage, so a backgrounded iOS tab that gets discarded
   * takes these sentences with it. Re-tailoring the same posting does not bring
   * them back either: `temperature=0.3` means the second answer is different
   * text. `TailorPage` therefore registers a `beforeunload` guard for exactly as
   * long as this map is non-empty, and `edit.tailoredHint` says out loud that
   * the edits live for this visit only.
   */
  tailorOverrides: Overrides;
  /**
   * The overrides "Clear my edits" last took away — a ONE-STEP UNDO for the one
   * control on this surface that discards several things the user typed.
   *
   * Kept in the store rather than in the toolbar's own state because the toolbar
   * unmounts on every navigation and the review does not; an undo that dies
   * because you looked at the tracker is not an undo.
   *
   * IT IS NEVER INVALIDATED BY A LATER EDIT, and that is safe only because the
   * restore MERGES (`restoreClearedOverrides`): anything typed since the clear
   * outranks the buffer, so a stale buffer can put text back but can never
   * overwrite newer text with older. Invalidating it on the next write was the
   * other candidate and it is the worse one twice over — `setBlockOverride` may
   * set `tailorOverrides` and nothing else (check-mirrors 20, and the reason is
   * that everything else in reach of that function writes the MASTER), and
   * "your undo silently expired" is a promise broken quietly.
   *
   * Null, not `{}`: "there is nothing to put back" and "the user cleared an
   * empty map" are different statements, and only the first may hide the offer.
   */
  clearedOverrides: Overrides | null;
  loading: boolean;
  error: string;
  saved: boolean;
  savedAppId: number | null;
  applyClicked: boolean;
  applied: boolean;
  coverLetterText: string;
  // Set when the JD's language differed from the loaded resume and a saved
  // master in the JD's language was swapped in ("he" | "en"); null otherwise.
  langSwitched: "he" | "en" | null;
  // "Check fit" before any tailoring: the reading, and the exact posting text it
  // was taken for. Re-checking the same text would spend a use to learn
  // nothing, so the overlay compares against `checkedFor` rather than assuming.
  fit: FitCheckResult | null;
  checkedFor: string | null;
  // TWO READINGS, TWO STAMPS, and they may never share one.
  //
  // `fitScoredAt` belongs to `fit` (the pre-tailor "Check fit" reading);
  // `scoredAt` belongs to `result.score_after`. One field served both until
  // 23.8, and the tailor's success branch re-stamped it — so after
  // `discardTailorResult` (which keeps `fit`, correctly: the number still
  // describes the master against the posting still in `jdText`) ScoreCard paired
  // the PRE-tailor number with the TAILOR's timestamp. The timestamp is the
  // entire honesty mechanism of that number — "one AI reading, taken HH:MM", no
  // before/after, no delta — so a stamp naming the wrong reading is the one
  // thing this tile must not do. `TailorPage` picks the stamp in the same
  // expression that picks the number, so the two cannot drift.
  //
  // Both are stamped on the CLIENT and neither is a field on the backend
  // `Score`, on purpose: `Score` is persisted inside kit result JSON, and
  // validating a stored kit substitutes schema defaults, so a new field would
  // read as empty on every pre-existing row forever. This store dies on reload,
  // so a reading can never outlive its stamp.
  fitScoredAt: number | null;
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
  tailorOverrides: {},
  clearedOverrides: null,
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
  fitScoredAt: null,
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
    tailorOverrides: {},
    // The undo buffer for those overrides goes with them: it holds coordinates
    // in a diff that no longer exists, so restoring it into a later review would
    // re-apply one application's sentences onto another application's CV.
    clearedOverrides: null,
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

/**
 * Tailor the MASTER resume for the posting in `jdText`.
 *
 * The source is always `state.resume` — never `result.tailored_resume` — so
 * pressing Tailor a second time re-runs the pipeline on the same master and
 * throws the previous review away. There is no compounding drift, and the only
 * branch that swaps the source fetches another STORED master (the paired he/en
 * one).
 *
 * The reset below is therefore exactly `adoptMaster`'s list minus the six
 * master-identity keys (`resume`, `savedResume`, `ledger`, `masterLabel`,
 * `editUndo`, `editError`): a tailor replaces the REVIEW, not the resume.
 * check-mirrors 13 derives that sentence from `adoptMaster` rather than
 * restating it, so a key added there forces a decision here.
 */
export function startTailor(): void {
  const { resume, jdText } = state;
  if (!resume || state.loading) return;
  const id = ++seq;
  // ONE comparison, captured BEFORE the reset writes over `state`, and used for
  // two things that must never disagree: whether the analysed JD can be reused,
  // and whether the fit reading still describes the posting we are about to
  // tailor for. Reusing it is what keeps "check fit, then tailor" at 1 use: the
  // server keys the tailor a fit check includes by the analysed JD that check
  // returned (Phase 30 / B4.4), and a second analysis of the same text is a
  // different JD, so that tailor would use a second one. The `prior` lookup used
  // to live inside the async IIFE, i.e. AFTER this reset — leaving it there while
  // clearing `checkedFor` would make it read the value this very call had just
  // nulled, and the overlay's "tailoring this job afterwards is included" would
  // be false.
  const sameJd = state.checkedFor !== null && state.checkedFor === jdText.trim();
  const prior = sameJd ? state.jd : null;
  setTailorState({
    loading: true,
    error: "",
    result: null,
    tailoredFrom: resume,
    rejectedEdits: [],
    // The overrides describe blocks of a diff that no longer exists. Cleared
    // everywhere `rejectedEdits` is, and for the same reason.
    //
    // THIS IS A DESTRUCTIVE LINE AND THE GUARD FOR IT IS IN THE UI, not here.
    // `TailorOverlay` arms-then-confirms its Tailor button while the count is
    // above zero and names the count at rest, the way the Settings danger zone
    // does. A second call site that skips that step deletes every sentence the
    // user typed on this CV in one tap, with no undo — the overrides are not
    // mirrored anywhere and re-tailoring the same posting returns different
    // text, so there is nothing to recover them from.
    tailorOverrides: {},
    clearedOverrides: null,
    saved: false,
    // The tracker row holds the PREVIOUS tailored resume for the PREVIOUS
    // posting. Leaving the id made `save()` take its `savedAppId !== null`
    // short-circuit and toast "Already in your tracker" while writing nothing,
    // so the row kept a CV for a job the user is no longer applying to.
    // `applied` / `applyClicked` answer "did you apply to THAT job".
    savedAppId: null,
    applyClicked: false,
    applied: false,
    coverLetterText: "",
    langSwitched: null,
    // A fit reading, the posting it was taken for and the minute it was taken
    // are ONE thing: reused together or dropped together. Same pairing
    // `adoptMaster` and `applyBlockEdit` document — dropping `fit` without
    // `checkedFor` makes the overlay suppress the re-check that would fix it as
    // "already read this posting", dropping `checkedFor` without `fit` leaves a
    // number on the page belonging to a posting nothing on screen names, and
    // dropping `fitScoredAt` without `fit` leaves a reading whose only claim to
    // honesty — the minute it was taken — is gone.
    fit: sameJd ? state.fit : null,
    checkedFor: sameJd ? state.checkedFor : null,
    fitScoredAt: sameJd ? state.fitScoredAt : null,
    // ALWAYS null, unlike the trio above, because this stamp belongs to
    // `result.score_after` and the result is being thrown away. The success
    // branch below re-stamps it. Carrying it through `sameJd` is what fused the
    // two clocks into one and dated the fit reading by the tailor.
    scoredAt: null,
  });
  (async () => {
    // Reuse the posting we already read. `/jobs/fit` hands its analysed JD back
    // for exactly this reason: the tailor it includes is keyed by that JD, so
    // "check fit, then tailor" is 1 use, the same as tailoring straight away,
    // which is what the overlay's note promises.
    const analyzed = prior ?? (await analyzeJD(jdText));
    if (id !== seq) return;
    setTailorState({ jd: analyzed });
    // Paired he/en masters: a Hebrew JD is tailored from the Hebrew resume (and
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
        /* older backend or no paired master — keep the loaded resume */
      }
    }
    const r = await tailor(useResume, analyzed);
    if (id === seq)
      setTailorState({
        loading: false,
        result: r,
        scoredAt: Date.now(),
        // The fit check's included tailor is spent: this tailor sent the JD that
        // reading analysed, and one fit check includes one tailor. Kept, the
        // stamp would have the overlay call a second tailor of the same job
        // "included" once this review is discarded. A failed tailor never gets
        // here, and the server gives its ride back.
        ...(prior && state.fit ? { fit: { ...state.fit, tailor_included_until: "" } } : {}),
      });
  })().catch((e: unknown) => {
    if (id === seq)
      setTailorState({
        loading: false,
        error: apiErrorMessage(e, "Something went wrong. Is the backend running?"),
      });
  });
}

/**
 * Close the review and go back to the master document.
 *
 * Until this existed there was NO way out. `editable = !result && !!resume`
 * (TailorPage), so a result makes the document non-editable AND removes the
 * Replace control, and nothing on /app ever set `result` back to null. Within a
 * session, tailoring once locked the page into review mode until a full reload.
 * That is also why hiding the Tailor button while a result is up would be the
 * wrong fix for the confusing affordance: it would remove the last control on
 * the surface and strand the user in a mode they cannot leave.
 *
 * This discards a MEMO, not a RECORD. `savedAppId` / `saved` / `applied` stay:
 * the tracker row this review produced still exists on the server, and clearing
 * the id would let the next save write a duplicate row for the same job. The
 * target job stays for `adoptMaster`'s reason — closing a review of a posting
 * does not change which posting you are aiming at, and `jdText` is what makes
 * the next Tailor one tap away.
 *
 * It writes nothing into `resume`, by design. Copying `result.tailored_resume`
 * back into the master is the compounding this surface deliberately does not
 * do: master ⇒ edit, tailored ⇒ review.
 *
 * `fit` / `checkedFor` / `fitScoredAt` survive, and the whole trio is honest
 * now that the fit reading has a stamp of its own: the number is the MASTER's
 * reading for the posting still in `jdText`, the document on screen is the
 * master again, and the minute beside it is the minute that reading was taken.
 * That was the one thing wrong here — `scoredAt` had been re-stamped by the
 * tailor's success branch, so a discard paired the pre-tailor number with the
 * tailor's clock, on the tile whose entire honesty mechanism is its timestamp.
 * `scoredAt` now goes with the result it describes; the paid reading stays.
 */
export function discardTailorResult(): void {
  if (!state.result) return;
  setTailorState({
    result: null,
    tailoredFrom: null,
    rejectedEdits: [],
    // The per-application edits go with the application they were typed into.
    // They are an overlay on a diff, and the diff is what this discards.
    //
    // DESTRUCTIVE, AND GUARDED IN THE UI. `TailorPage` arms-then-confirms the
    // ghost "Back to my resume" button whenever this map is non-empty, and says
    // at rest — not only once armed — how many typed edits leaving costs. It
    // sits one button away from "Tailor for a different job", which destroys the
    // same map through `startTailor`, so a caller reaching either without that
    // step throws away work with no undo and no warning.
    tailorOverrides: {},
    clearedOverrides: null,
    // The tailor's own stamp, going with the tailor's own reading.
    scoredAt: null,
    coverLetterText: "",
    error: "",
  });
}

// --------------------------------------------------------------------------- //
// Editing the tailored document (23.7)
// --------------------------------------------------------------------------- //

/**
 * The user typed over one block of the TAILORED document.
 *
 * THIS SETS `tailorOverrides` AND NOTHING ELSE, and each of the three things it
 * refuses to touch is a bug avoided:
 *
 *  · not `resume` — the master is not what is on screen, and writing the
 *    flattened tailored CV into it is the compounding this surface exists not
 *    to do (a tailored resume carries `skill_groups: undefined`, so one write
 *    would destroy the master's whole skills taxonomy);
 *  · not `editUndo` — the undo stack is the master's, and an application-only
 *    edit has no business on it;
 *  · and above all NOT `writeDraft` — the 22.11 local draft mirrors the MASTER,
 *    and `draftOver` spreads it over the master, so a per-application edit that
 *    reached it would have `DraftRestoreBar` offer to restore a tailored CV as
 *    the user's real resume on their next visit.
 *
 * `applyBlockEdit` does all three, which is exactly why the tailored path may
 * never call it: it also nulls `result` / `tailoredFrom` / `rejectedEdits`, so
 * one keystroke through it would destroy the review being edited.
 *
 * `anchor` is a SOURCE ANCHOR (`exp.2.b.0`), never a block path (`@exp.1.b.0`).
 * The `@` prefix is what keeps those two string-identical grammars apart.
 */
export function setBlockOverride(anchor: string, values: Record<string, string>): void {
  // ONE KEY, and check-mirrors 20 asserts it by SHAPE rather than by line — it
  // strips nested braces and counts the keys at depth 0, so folding this onto a
  // single line cannot smuggle a second one past it. That matters more than the
  // formatting: the key it exists to forbid is `editUndo`, because an edit that
  // belongs to ONE APPLICATION must never reach the master's undo stack.
  setTailorState({
    tailorOverrides: { ...state.tailorOverrides, [anchor]: values },
  });
}

/** Drop one hand-edit — the second half of "an override outranks the
 * accept/decline decision, and toggling that decision is the ONLY thing that
 * discards it". Never called silently; the review row spells out which wording
 * the tap is choosing. */
export function clearBlockOverride(anchor: string): void {
  const next = { ...state.tailorOverrides };
  delete next[anchor];
  setTailorState({ tailorOverrides: next });
}

/**
 * Drop them all, from the one control that says so — AND KEEP THEM FOR ONE UNDO.
 *
 * This is the only control on the surface that discards several things the user
 * wrote in a single tap, and until 23.8 it did so with no confirm and no way
 * back. Two ways to fix that; this is the cheaper and the kinder one. A confirm
 * would put a second tap in front of a control the user pressed on purpose;
 * keeping the map costs one nullable field and turns the mistake into a tap
 * rather than a re-typing session — and nothing else can recover it, because
 * these edits are mirrored nowhere and a re-tailor of the same posting comes
 * back as different text.
 *
 * The empty guard is not a micro-optimisation: without it a second tap on a
 * control that has nothing left to clear would overwrite a live undo buffer
 * with `{}` and quietly delete the very thing this exists to protect.
 */
export function clearAllBlockOverrides(): void {
  const cleared = state.tailorOverrides;
  if (Object.keys(cleared).length === 0) return;
  setTailorState({ tailorOverrides: {}, clearedOverrides: cleared });
}

/**
 * Put back what "Clear my edits" took away.
 *
 * A MERGE, never an assignment, and the direction is the whole safety argument:
 * anything typed SINCE the clear wins, so this can only ever add text back and
 * can never overwrite a newer sentence with an older one. That is what lets the
 * buffer survive later edits instead of being invalidated on the next write —
 * which `setBlockOverride` may not do anyway (check-mirrors 20: it sets
 * `tailorOverrides` and nothing else, because everything else within its reach
 * writes the MASTER).
 */
export function restoreClearedOverrides(): void {
  const cleared = state.clearedOverrides;
  if (!cleared) return;
  setTailorState({
    tailorOverrides: { ...cleared, ...state.tailorOverrides },
    clearedOverrides: null,
  });
}

// --------------------------------------------------------------------------- //
// A master resume replaced somewhere else (23.6)
// --------------------------------------------------------------------------- //

/**
 * The STORED master resume was replaced by another surface — a file dropped on
 * the Jobs page's Replace panel, a version restored from history, the skills
 * editor saving — and the document must BECOME it.
 *
 * This store is the app's second module-level copy of the master (the first is
 * `useMasterResume`'s cache), and nothing outside this file could reach it:
 * `TailorPage`'s loader early-returns the moment `resume` is set, so a resume
 * replaced anywhere else never arrived. The document surface kept painting the
 * old file, TAILORED it, and downloaded it — until a full page reload. That is
 * the same defect `resetMasterCache` exists for, one cache further along, and
 * it is why the call to this lives inside `useMasterResume`'s `setMaster`
 * rather than at each of its call sites.
 *
 * Everything cleared below describes the resume being replaced: a fit reading,
 * a tailor diff, a fabrication warning and a tracker row all say something
 * about a document that no longer exists. `checkedFor` has to go with `fit` or
 * the overlay suppresses the re-check that would fix it as "already read this
 * posting" — the same pairing `applyBlockEdit` documents. The `seq` bump is the
 * same argument applied to a tailor that is still running: its base is gone, so
 * its answer would describe nothing.
 *
 * The TARGET JOB survives on purpose — `jdText`, `jd`, `jobUrl`, `jobTitle`,
 * `company`. Which posting the user is aiming at has nothing to do with which
 * file their resume is in, and pressing Tailor straight afterwards using the
 * NEW resume is the whole point.
 */
export function adoptMaster(m: MasterResume): void {
  seq++; // cancel an in-flight tailor — it is about the resume that just went
  setTailorState({
    resume: m.resume,
    // The dirty baseline is the incoming copy, never the document on screen:
    // seeding it from what was there leaves the new resume reading dirty.
    savedResume: m.resume,
    ledger: m.ledger ?? null,
    masterLabel: m.label,
    editUndo: [],
    editError: "",
    loading: false,
    error: "",
    result: null,
    tailoredFrom: null,
    rejectedEdits: [],
    tailorOverrides: {},
    clearedOverrides: null,
    saved: false,
    savedAppId: null,
    applyClicked: false,
    applied: false,
    coverLetterText: "",
    langSwitched: null,
    fit: null,
    checkedFor: null,
    fitScoredAt: null,
    scoredAt: null,
  });
  // The 22.11 draft mirrors the document that was just replaced. Leaving it
  // would have DraftRestoreBar offer to "restore unsaved changes" that are in
  // fact the whole of the PREVIOUS resume, pasted over the new one — and
  // `draftOver` spreads the draft over the master, so accepting would undo the
  // replacement the user just made.
  clearDraft();
}

// --------------------------------------------------------------------------- //
// Block editing (22.8)
// --------------------------------------------------------------------------- //

/**
 * Replace the master resume with an edited copy.
 *
 * The invalidation here is the dangerous part, and every line of it is load
 * bearing: a fit reading and a tailor result both describe the document as it
 * was, and leaving either up after an edit means showing a number about a
 * resume that no longer exists. `checkedFor` has to go too, or the overlay
 * suppresses the re-check that would fix it as "already read this posting".
 */
export function applyBlockEdit(next: ResumeModel): void {
  const prev = state.resume;
  if (!prev) return;
  setTailorState({
    resume: next,
    // Cap the stack: this is an undo, not a history, and a resume is not small.
    editUndo: [...state.editUndo, prev].slice(-30),
    editError: "",
    fit: null,
    checkedFor: null,
    fitScoredAt: null,
    scoredAt: null,
    result: null,
    tailoredFrom: null,
    rejectedEdits: [],
    tailorOverrides: {},
    clearedOverrides: null,
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
 * for its documented best-effort use — persisting a freshly parsed resume — and
 * exactly wrong behind a Save button, where the user is relying on the result.
 *
 * No `ledger` is sent. The backend rebuilds it from the resume when none is
 * given, which is what we want: the user typed these facts, so the resume IS
 * the source of truth. Passing the LOADED ledger through would store facts
 * describing the PRE-edit resume, and the fabrication guard reads the stored
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
    // Leaving it would offer to "restore" the resume the user just saved.
    clearDraft();
    // `invalidateData` cannot reach useMasterResume's module-level cache, and
    // nine pages read the master from it — an X-ray run right after an edit
    // would otherwise scan the resume that was just replaced.
    resetMasterCache();
    return true;
  } catch (e: unknown) {
    setTailorState({ editSaving: false, editError: apiErrorMessage(e, fallbackError) });
    return false;
  }
}
