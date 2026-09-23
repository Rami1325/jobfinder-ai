import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import { Wand2, Download, Save, BadgeCheck, Briefcase, ChevronRight, ExternalLink, ArrowLeft, Target, Pencil } from "lucide-react";
import {
  downloadResume,
  resumeFilename,
  getApplication,
  getAuthMe,
  getMasterResume,
  recordRejectedPhrases,
  type ResumeTemplate,
  saveApplication,
  updateApplication,
} from "../api/client";
import { isPdfOnlyTemplate } from "../components/TemplatePicker";
import PageBadge from "../components/PageBadge";
import DocumentToolbar from "../components/DocumentToolbar";
import DraftRestoreBar from "../components/DraftRestoreBar";
import ChangeLog, { LeftOut } from "../components/ChangeLog";
import DocumentPanel, { type DocView, type DrawerPane } from "../components/DocumentPanel";
import DraftSummary from "../components/DraftSummary";
import TailorOverlay from "../components/TailorOverlay";
import BlockEditSheet from "../components/BlockEditSheet";
import ResumeEditBar from "../components/ResumeEditBar";
import { useCoverage } from "../hooks/useCoverage";
import { useReview } from "../hooks/useReview";
import CoverLetter from "../components/CoverLetter";
import MatchReport from "../components/MatchReport";
import ResumeUpload from "../components/ResumeUpload";
import { flagsOf } from "../components/ReviewPanel";
import VoicePanel from "../components/VoicePanel";
import { resetMasterCache } from "../hooks/useMasterResume";
import { useUses } from "../lib/usesStore";
import { masterResumeLabel, useSaveMasterResume } from "../hooks/useSaveMasterResume";
import { blocksByEdit, flagStates, mergeForReview } from "../lib/resumeDiff";
import { applyOverrides, blockText, movedPath } from "../lib/resumeOverrides";
import {
  inlineField,
  insertBlock,
  insertBullet,
  insertNamed,
  insertSkill,
  readBlock,
  removeBlock,
  writeBlock,
  type EntryInsertKind,
  type NamedInsertKind,
  type Values,
} from "../lib/resumeBlocks";
import type { BlockMark } from "../components/ResumeView";
import { resumeLanguage } from "../lib/lang";
import { clearDraft, draftOver, offerDraft, readDraft, type ResumeDraft } from "../lib/draft";
import { classifyEdit } from "../lib/editGroups";
import { cn } from "../lib/cn";
import { Badge, Button, Card, CardTitle, Skeleton, useToast } from "../components/ui";
import {
  adoptMaster,
  applyBlockEdit,
  bindDraftRow,
  clearAllBlockOverrides,
  clearBlockOverride,
  discardTailorResult,
  flushDraftSave,
  getTailorState,
  restoreClearedOverrides,
  setBlockOverride,
  setTailorState,
  setTargetJob,
  settleDraft,
  startTailor,
  subscribeTailor,
  syncDraft,
  type DraftOutcome,
  type DraftSnapshot,
} from "../state/tailorStore";
import type { FactsLedger, ResumeModel } from "../types";

/**
 * Does a review row's edit own this hand-edit?
 *
 * TRUE for the edit's own anchor, and — only for a WHOLE-ENTRY edit — for
 * anything inside it. Both halves are load-bearing, and each of them fixed a
 * defect the other caused.
 *
 * The subtree half: `editSrc(id, id)` registers an ADDED or REMOVED entry under
 * the entry's own anchor (`exp.add.1`), while its bullets get anchors one level
 * deeper (`exp.add.1.b.0`) that no edit id points at — so a hand-edit on a bullet
 * of an AI-added job was invisible to the row above it. The row kept a live
 * Accept/Reject, and declining it silently discarded the user's text with no
 * "Yours" badge and no note, while the toolbar went on counting it.
 *
 * THE GATE is the correction. An entry-level SCALAR edit (`exp.0.title`) is
 * anchored to the ENTRY, `exp.0` — so an ungated prefix walk made the row about
 * a job TITLE own every hand-edit on that job's bullets: the AI's title change
 * became undecidable behind a "Yours" badge, the row printed "Neither wording
 * below is on your CV any more" while the AI's wording was plainly on the paper,
 * and both of its buttons cleared the bullet override, so one tap on a row about
 * the job title silently deleted a sentence the user had typed on a different
 * line. Reproduced by executing the shipped merge.
 *
 * `editAnchors[id] === id` is exactly the discriminator, DERIVED rather than
 * pattern-matched: only `editSrc(id, id)` — the add/remove sites — registers an
 * edit under its own id, so that identity IS "this edit is the whole entry", and
 * it stays true if the id grammar is ever renamed.
 *
 * The trailing dot is load-bearing: without it `exp.1` would own `exp.10`.
 */
const ownsAnchor = (editAnchor: string, overrideAnchor: string, whole: boolean): boolean =>
  overrideAnchor === editAnchor || (whole && overrideAnchor.startsWith(`${editAnchor}.`));

/** The tailored draft's action bar, one row of 42 px buttons and its padding
 * (PLAN 31.2/2). The toast stack and the page's spacer read the same number. */
const BAR_HEIGHT = "3.75rem";

/** Where the one-time "tap to edit" hint remembers it was seen. Per device, and
 * kept through a sign-out: it teaches a gesture, not anything about an account. */
const EDIT_HINT_KEY = "jf-edit-hint-v1";

export default function TailorPage() {
  const { t, i18n } = useTranslation("tailor");
  const { t: tCommon } = useTranslation("common");
  const navigate = useNavigate();
  const loc = useLocation() as {
    key: string;
    state?: { jdText?: string; jobUrl?: string; jobTitle?: string; company?: string };
  };
  // Consume a handed-over target job (Jobs page → "Tailor to this") before the
  // first snapshot below, so the page never flashes the previous job's state.
  useState(() => {
    if (loc.state?.jdText || loc.state?.jobUrl) setTargetJob(loc.key, loc.state);
  });
  // Everything on this page lives in a module-level store so an in-flight
  // tailor keeps running — and the results stay put — across tab switches.
  const {
    resume,
    masterLabel,
    jdText,
    jd,
    result,
    tailoredFrom,
    rejectedEdits,
    tailorOverrides,
    clearedOverrides,
    loading,
    error,
    savedAppId,
    savedFor,
    draftSave,
    applyClicked,
    applied,
    coverLetterText,
    langSwitched,
    fit,
    checkedFor,
    fitScoredAt,
    scoredAt,
    overlayOpen,
    savedResume,
    editUndo,
    editSaving,
    editError,
    template,
    jobUrl,
    jobTitle,
    company,
  } = useSyncExternalStore(subscribeTailor, getTailorState);
  const toast = useToast();
  // The design (visual only — every option is ATS-safe). In the store since
  // PLAN 31.3/4: the draft saved with its job records it, and page state went
  // back to "standard" on every remount.
  const setTemplate = useCallback((next: ResumeTemplate) => setTailorState({ template: next }), []);
  const persistMaster = useSaveMasterResume();

  // Deep handoff from the Chrome extension ("Save & tailor"): ?tailor_app=<id>
  // loads that tracker application's JD into the target-job slot. The param is
  // stripped immediately so reloads don't re-apply it over in-progress work.
  const [searchParams, setSearchParams] = useSearchParams();
  // StrictMode runs a mount effect twice in development, and the stripped param has
  // not reached `searchParams` by the second run — so one handoff fetched twice and a
  // failure toasted twice (Phase 29 browser pass). The ref survives that remount.
  const handledHandoff = useRef<string | null>(null);
  useEffect(() => {
    const raw = searchParams.get("tailor_app");
    if (!raw || handledHandoff.current === raw) return;
    handledHandoff.current = raw;
    const next = new URLSearchParams(searchParams);
    next.delete("tailor_app");
    setSearchParams(next, { replace: true });
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return;
    (async () => {
      try {
        const d = await getApplication(id);
        setTargetJob(`tailor-app-${id}-${Date.now()}`, {
          jdText: d.jd_text,
          jobUrl: d.job_url,
          jobTitle: d.job_title,
          company: d.company,
        });
      } catch {
        toast("error", t("toasts.handoffFailed"));
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A draft written by a previous visit, once we have a master to judge it
  // against. Offered, never applied — see DraftRestoreBar.
  const [draft, setDraft] = useState<ResumeDraft | null>(null);

  // What the fetch below has found, because an empty store means two different
  // things. Until it answers, the store is empty for a person who HAS a resume,
  // and the page painted the upload card — "No resume yet? Build one from
  // scratch" — to them for the length of the request: seconds, on the document
  // load a sign-in redirect makes (seen on production, 2026-09-22). A FAILED
  // fetch is the same unknown, not a zero: `GET /profile/resume` answers a
  // person with no resume with a 200 and `null`, so a throw means we could not
  // look, and the card would invite a first upload over a saved resume.
  const [masterLoad, setMasterLoad] = useState<"loading" | "done" | "failed">(() =>
    getTailorState().resume ? "done" : "loading",
  );

  function loadMaster() {
    if (getTailorState().resume) {
      setMasterLoad("done"); // already loaded (or uploaded) this session
      return;
    }
    setMasterLoad("loading");
    (async () => {
      try {
        // /auth/me alongside the master, because the draft is offered only to
        // the account that wrote it and that answer is what names the account
        // (lib/draft.ts). A failed read offers nothing and deletes nothing.
        const [m] = await Promise.all([getMasterResume(), getAuthMe().catch(() => null)]);
        if (m?.resume && !getTailorState().resume) {
          setTailorState({
            resume: m.resume,
            savedResume: m.resume, // the dirty baseline is the SERVER's copy
            ledger: m.ledger ?? null,
            masterLabel: m.label,
          });
          // Only now can a draft be judged: the language rule needs the
          // master's language, and "differs" needs something to differ FROM.
          const d = readDraft();
          if (offerDraft(d, m.resume)) setDraft(d);
        }
        setMasterLoad("done");
      } catch {
        setMasterLoad("failed");
      }
    })();
  }

  useEffect(() => {
    loadMaster();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Restore as a normal unsaved edit: the master goes on the undo stack, so
   * ResumeEditBar immediately offers the same Undo and Save as any other edit
   * and there is no way to be stuck with content you did not want. */
  function keepDraft() {
    const base = getTailorState().resume;
    if (base && draft) applyBlockEdit(draftOver(base, draft));
    setDraft(null);
  }

  /** A single-field block was typed on and the caret left it.
   *
   * The change guard is HERE, against the MODEL, not against the rendered text
   * — ResumeView already refuses an unchanged edit, but the two are not the
   * same string everywhere: a nameless CV renders the "Resume" placeholder over
   * an empty `contact.name`, so clearing that block would otherwise write ""
   * over "" and burn an undo slot on nothing. Comparing to `field.value`
   * catches every such case at once.
   *
   * `writeBlock` stays the only writer and `applyBlockEdit` the only way into
   * the MASTER, so the undo stack and the 22.11 local draft keep working
   * untouched. The tailored branch below reaches neither — see its own note.
   */
  function commitInline(path: string, text: string) {
    // THE TAILORED PATH. It must never reach `applyBlockEdit` below:
    // that one sets `result: null, tailoredFrom: null, rejectedEdits: []` and
    // mirrors to the master's local draft, so a single keystroke would collapse
    // the review being edited AND leave DraftRestoreBar offering the flattened
    // tailored CV back as the user's real resume on their next visit.
    //
    // Stored against the block's SOURCE ANCHOR, never its path. Committed on
    // BLUR, like the master path, and that is what keeps the caret alive: the
    // merged memo now depends on `tailorOverrides`, so a commit produces a new
    // resume object and re-renders the sheet. On input it would kill the caret
    // on the first keystroke.
    //
    // `if (result)` FIRST, then the null check INSIDE it, and the nesting is the
    // point. As `if (result && merged)` the fallthrough was the MASTER writer:
    // with a result up and `merged` somehow null, a keystroke on the tailored
    // document would resolve a TAILORED path against the master resume, call
    // `applyBlockEdit`, write the master, mirror it into the master's local
    // draft and null the review — four wrong documents from one guard reading
    // false. Unreachable today (`merged` is non-null whenever `result` and
    // `original` are), and pinned by nothing, which is exactly why it is worth
    // one line: this changes the failure from "write the wrong document" to
    // "refuse the edit", the direction the anchor check three lines below
    // already chose.
    if (result) {
      if (!merged) return;
      const field = inlineField(merged.resume, path);
      if (!field || field.value.trim() === text.trim()) return;
      const anchor = merged.sources[path];
      // No anchor means no stable coordinate to hang this on, and a path-keyed
      // override lands on a DIFFERENT bullet the first time any add or removal
      // in that section is toggled. Refuse rather than corrupt.
      if (!anchor) return;
      // Empty stays empty here: `applyOverrides` reads the same
      // `readBlock(...).removable` rule as the branch below and turns a blank
      // value on a removable block into a removal, so there is one definition
      // of empty-means-remove rather than two.
      setBlockOverride(anchor, { [field.key]: text });
      return;
    }
    const base = getTailorState().resume;
    if (!base) return;
    const field = inlineField(base, path);
    if (!field || field.value.trim() === text.trim()) return;
    // EMPTY MEANS REMOVE for a block that IS its own text. Both renderers draw
    // a glyph for an empty list item, so there is no honest blank bullet to
    // store — `readBlock`'s `removable` doc comment already says clearing has
    // to mean removal, and nothing implemented it. This is also what makes an
    // abandoned insert clean itself up: add a skill, type nothing, tap away,
    // and it is gone, with no pending-insert state to keep in sync.
    const res =
      !text.trim() && readBlock(base, path)?.removable
        ? removeBlock(base, path)
        : writeBlock(base, path, { [field.key]: text });
    if (res.ok) applyBlockEdit(res.resume);
  }

  /** Add a blank ENTRY and put the panel (or the caret) on it straight away. An
   * added thing you then have to hunt for is not an add control. */
  function addToResume(kind: EntryInsertKind) {
    const base = getTailorState().resume;
    if (!base) return;
    const res = insertBlock(base, kind);
    if (!res.ok) return;
    applyBlockEdit(res.resume);
    // Compound kinds have no single field to type into, so they open the panel;
    // the single-field kinds get a caret, on the next frame, once rendered.
    // Derived from `inlineField` rather than listed here, so a kind that later
    // becomes one field starts getting a caret by itself.
    if (inlineField(res.resume, res.path)) focusBlockSoon(res.path);
    else {
      setFreshEntry(res.path);
      setEditPath(res.path);
    }
  }

  /** A finished skill, certification or language, typed into the foot control.
   *
   * The keyed twin of `addToResume`, and the reason that function no longer
   * handles all seven kinds. These three are addressed by their own text
   * (`@skills.python` IS the skill), so there is nothing to insert until the
   * user has typed something: `insertBlock` used to invent that text —
   * "New skill", "New certification", "New language" — which put a claim the
   * user never made into the master resume, live in the store with no Save,
   * rendered as a chip and present in the download. `check_fabrication` cannot
   * see it: the ledger is built FROM the master, so the app's own truthfulness
   * guard certifies the invented string clean. On a Hebrew CV it was English.
   *
   * A duplicate is not an edit — `insertNamed` hands back the SAME resume
   * object, so the identity check keeps it off the undo stack and the chip that
   * already says it is scrolled to and bloomed instead. `addSkill`'s rule, for
   * `addSkill`'s reason: the honest answer to "add Python" on a CV that already
   * says Python is to show them where it already is.
   *
   * A language arrives with an empty level, which is its second field, so it is
   * set the way every other second field on this page is — by tapping the chip
   * and using the panel. Nothing here guesses at it.
   */
  function addNamed(kind: NamedInsertKind, text: string) {
    const base = getTailorState().resume;
    if (!base) return;
    const res = insertNamed(base, kind, text);
    if (!res.ok) return;
    if (res.resume !== base) applyBlockEdit(res.resume);
    else scrollToBlock(res.path);
    markSpot(res.path);
  }

  /** A finished skill, typed straight onto the chip row of the group the user
   * was reading — no placeholder chip to rename, and the field stays open so
   * the next one can follow. `insertSkill` writes BOTH `skills` and the group,
   * for the reason `writeSkill` documents.
   *
   * A skill you already have is not an edit: `insertSkill` hands back the SAME
   * resume object, so the identity check keeps it off the undo stack. It is
   * still worth spotlighting — the honest answer to "add Python" on a CV that
   * already says Python is to show them where it already is.
   *
   * SHOWING is the load-bearing word, and `markSpot` alone does not do it: the
   * chip clears the field either way, so a duplicate looked exactly like a
   * successful add while the bloom fired on a chip that can be anywhere on the
   * page — most likely in a different group, since the whole reason to retype
   * a skill is not having spotted it. Scrolled, so the promise in
   * `insertSkill`'s own doc comment is kept. Only on the no-op branch: an add
   * that really happened lands on the row the caret is already sitting in, and
   * scrolling the paper under a user mid-run of typing is motion they did not
   * ask for. */
  function addSkill(group: string, text: string) {
    const base = getTailorState().resume;
    if (!base) return;
    const res = insertSkill(base, group, text);
    if (!res.ok) return;
    if (res.resume !== base) applyBlockEdit(res.resume);
    else scrollToBlock(res.path);
    markSpot(res.path);
  }

  /** Close the panel, and take an ADDED entry with it if it is still blank.
   *
   * The single-field kinds clean themselves up through the empty-means-remove
   * rule in `commitInline`, but a compound entry has no such moment: cancel the
   * form on a just-added project and an empty entry stays on the paper and
   * prints an empty heading into the PDF. Scoped to the entry this session
   * created — cancelling the form on a genuinely blank EXISTING entry must not
   * delete it, which is the direction that loses the user's data.
   *
   * MASTER ONLY, and the early return is not caution. Everything below reads and
   * writes `getTailorState().resume` — the MASTER — while a `path` arriving here
   * with a result up came from the TAILORED coordinate space: string-identical
   * grammar, different document. Adding is `isMaster`-gated so `freshEntry` can
   * only ever be minted against the master, but nothing used to CLEAR it when a
   * review arrived, and one stale value is all it takes: `@exp.2` in the master
   * and `@exp.2` in the tailored merge are different jobs, and cancelling that
   * panel would delete a role from the saved resume and take the review with it
   * (`applyBlockEdit` nulls `result`). `onGone` clears it too, for the same
   * reason — it was the one dismissal path that left the flag set.
   */
  function closeEditSheet() {
    const path = editPath;
    setEditPath(null);
    if (result) return;
    if (!path || path !== freshEntry) return;
    setFreshEntry(null);
    const base = getTailorState().resume;
    const draft = base ? readBlock(base, path) : null;
    if (!draft || draft.fields.some((f) => f.value.trim())) return;
    const res = removeBlock(base!, path);
    if (res.ok) applyBlockEdit(res.resume);
  }

  /** The panel's tailored twin: store the ENTRY's values as one override.
   *
   * Entry granularity is what the sheet already edits ("the sheet edits an
   * ENTRY, not a field"), so the override grain and the panel's grain are the
   * same thing and nothing has to be diffed back apart. */
  function commitBlockValues(values: Values, path: string) {
    setEditPath(null);
    setFreshEntry(null);
    const anchor = merged?.sources[path];
    if (!anchor) return; // same refusal as the inline path
    setBlockOverride(anchor, values);
    // The path the write LANDS on, not the one it left. A keyed rename moves its
    // own block — `@lang.hebrew` stops existing the instant it becomes Arabic — so
    // spotlighting the pre-write path names a node that is no longer in the DOM
    // and the confirmation bloom silently does not play. The master twin below
    // takes the post-write path from `writeBlock` for exactly this reason;
    // `movedPath` asks the same writer the same question.
    markSpot(merged ? movedPath(merged.resume, path, values) : path);
  }

  /** The two exits from a hand-edited review row, and the ONLY things that
   * discard what the user typed.
   *
   * An override outranks the accept/decline decision for its block, so the
   * decision control is replaced rather than left live. Each of these is one
   * tap that both clears the override and sets the decision, under a label that
   * says which wording it is choosing: a later Decline that silently replaced
   * typed text with the original wording would be deleting the user's own
   * writing with no notice. */
  function resolveOverride(id: string, useOriginal: boolean) {
    // Every anchor this row owns, not just the edit's own: a hand-edit on a bullet
    // INSIDE an AI-added job hangs one level deeper, and clearing only the entry's
    // anchor would leave the row's two buttons doing nothing to the text they name.
    for (const anchor of anchorsForEdit(id)) clearBlockOverride(anchor);
    const next = new Set(rejectedEdits);
    if (useOriginal) next.add(id);
    else next.delete(id);
    setTailorState({ rejectedEdits: [...next] });
  }

  /** Put back a line the USER deleted, and touch nothing else.
   *
   * The third exit, and it is deliberately not one of the two above: neither
   * "use the AI's wording" nor "use my original" describes undoing a deletion,
   * and the accept/decline decision on this row is not what removed the line —
   * so changing it here would be answering a question nobody asked. */
  function restoreOverride(id: string) {
    for (const anchor of anchorsForEdit(id)) clearBlockOverride(anchor);
  }

  function addBullet(entryPath: string) {
    const base = getTailorState().resume;
    if (!base) return;
    const res = insertBullet(base, entryPath);
    if (!res.ok) return;
    applyBlockEdit(res.resume);
    focusBlockSoon(res.path);
  }

  /** The node does not exist until React has rendered the new model. */
  function focusBlockSoon(path: string) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = docRef.current?.querySelector<HTMLElement>(`[data-block="${CSS.escape(path)}"]`);
        el?.focus();
        el?.scrollIntoView({ block: "center", behavior: smooth() });
      });
    });
  }

  /** Begin with a blank page rather than a wizard. No label and no
   * `savedResume`: nothing has been saved, so the edit bar correctly shows
   * nothing to save until the first keystroke, and the 22.11 draft starts
   * mirroring from that first edit. */
  function startFromScratch() {
    setTailorState({
      resume: {
        contact: { name: "", email: "", phone: "", location: "", linkedin: "", website: "" },
        headline: "",
        summary: "",
        skills: [],
        skill_groups: [],
        experience: [],
        education: [],
        projects: [],
        certifications: [],
        languages: [],
        military_service: [],
      },
      savedResume: null,
      ledger: null,
      masterLabel: "",
      editUndo: [],
    });
  }

  function discardDraft() {
    clearDraft();
    setDraft(null);
  }

  // The document is always on screen when a resume exists, so there is no
  // stepper any more: `step` gated nothing and described a flow that no
  // longer happens. Tailoring is an action ON the document, not a stage.
  const canRun = !!resume && !loading;

  // Per-bullet accept/reject: diff the tailored resume against the one it was
  // tailored from, and build the effective resume the user actually ships.
  const original = tailoredFrom ?? resume;
  const rejectedSet = useMemo(() => new Set(rejectedEdits), [rejectedEdits]);
  // ONE walk for all three: the edit list, the resume the user ships, and where
  // each edit lands in it. Computing them separately is how they drift.
  //
  // The user's OWN edits ride on top, in a second pass rather than inside the
  // walk, because they are not a decision about the AI's work — they replace
  // its answer entirely. `applyOverrides` resolves each one through the source
  // anchors this walk emits, which is what makes a typed sentence survive every
  // later accept and decline: `@exp.1` is a different job in the two decision
  // states, and `exp.2` is the same one in both. Every consumer of `shown` /
  // `effectiveResume` below — both downloads, the PDF preview, the x-ray, the
  // page count, coverage, the tracker row, the cover letter — gets it for free.
  const merged = useMemo(() => {
    if (!result || !original) return null;
    const m = mergeForReview(original, result.tailored_resume, rejectedSet);
    const o = applyOverrides(m.resume, m.sources, tailorOverrides, m.blocks);
    // `removed` is carried out with the other three: it is the ONLY record that a
    // blank value was a deletion the user made rather than a block a decision took
    // away, and everything below that tells those two apart reads it.
    //
    // `base` / `baseSources` are the merge BEFORE the user's own text went over
    // it — the last place the pre-edit wording exists. Nothing else on the page
    // holds it: `original` is the untailored master and `o.resume` is the
    // document with the override already applied, so without this pair "Undo my
    // edit" is a button whose outcome cannot be read anywhere on screen. Carried
    // out of the same memo rather than recomputed, because a second
    // `mergeForReview` call is a second answer to the same question.
    return {
      ...m,
      base: m.resume,
      baseSources: m.sources,
      resume: o.resume,
      sources: o.sources,
      blocks: o.blocks,
      removed: o.removed,
    };
  }, [original, result, rejectedSet, tailorOverrides]);
  const edits = merged?.edits ?? [];
  const effectiveResume = merged?.resume ?? result?.tailored_resume ?? null;
  const editBlock = useMemo(() => (merged ? blocksByEdit(merged.blocks) : {}), [merged]);
  // What the page shows: the tailored resume once there is one, the master
  // before that. This one expression is the whole of "the page always has a CV".
  const shown = effectiveResume ?? resume;
  // The document names its own page. The fallback is safe HERE and nowhere on
  // the paper: a heading is not `contentEditable`, so unlike the sheet's
  // placeholder it can never be committed into `contact.name` by a tap.
  const docTitle = shown?.contact?.name?.trim() || t("sections.fallbackName");
  // A tailored draft is named by its JOB in the one-row toolbar ("For Paywise"):
  // the person's name is on the paper right under it, and which job this draft
  // is for is the thing a phone could no longer see (PLAN 31.2/1).
  const tailoredName = (jd?.company || company || jobTitle || jd?.job_title || "").trim();
  const tailoredTitle = tailoredName ? t("toolbar.tailoredFor", { name: tailoredName }) : t("toolbar.tailoredDraft");

  // The live, deterministic half of the match — recomputed from the document as
  // it stands, on every accept and decline. The other half cannot move without
  // spending, so it is not here.
  const coverage = useCoverage(shown, jd);

  /**
   * Every deterministic check, against the document ON SCREEN.
   *
   * `shown`, not `resume` — so on a tailored draft the review describes the
   * merged CV with the user's own overrides over it, which is the paper, the
   * PDF preview, the x-ray, both downloads and the tracker row. Reviewing the
   * master while the user is looking at something else would put a finding on
   * the tool badge for a sentence that is not on the page.
   *
   * `jd` is passed and may be null: unlike coverage, this hook does NOT bail
   * without a job. Twenty-five of the twenty-six checks are properties of the
   * CV alone, and the master document — where there is usually no posting
   * attached — is the surface the feature exists for. The one JD-gated check
   * lands in `skipped`, never in `passed`.
   *
   * Free to run on every keystroke for the same reason coverage is: `POST
   * /tools/review` carries no `Depends`, reaches no model and writes no
   * `usage_log` row. The one part that spends is a button inside the panel.
   */
  const review = useReview(shown, jd);

  /** Block path → the worst thing the review found there. Derived in
   * `ReviewPanel` beside the badge count, so the dots on the paper and the
   * number on the tool cannot be computed two different ways. */
  const reviewFlags = useMemo(() => flagsOf(review.data), [review.data]);

  /** How each block on the page relates to the tailoring. There is no
   * "undecided" state in this flow — every edit is accepted until rejected — so
   * a block is either showing the AI's wording or, if every edit on it was
   * declined, the user's original. The second is the one worth seeing.
   *
   * A hand-edit is the third answer and OUTRANKS both, which is why it is
   * written last: with an override on a block, neither "the AI's wording" nor
   * "your original" is the text on the paper, and saying either would be
   * false. */
  const marks = useMemo(() => {
    const m = new Map<string, BlockMark>();
    if (merged) {
      for (const [path, ids] of Object.entries(merged.blocks)) {
        m.set(path, ids.every((id) => rejectedSet.has(id)) ? "restored" : "changed");
      }
      for (const [path, anchor] of Object.entries(merged.sources)) {
        if (anchor in tailorOverrides) m.set(path, "yours");
      }
    }
    return m;
  }, [merged, rejectedSet, tailorOverrides]);

  /** Every hand-edit that belongs to one review row: the block the edit
   * describes, and anything INSIDE it. `ownsAnchor` is defined once, at module
   * scope, because the classifier below and the two exits that CLEAR these
   * anchors have to agree — a row that says "Yours" over a hand-edit its own
   * buttons cannot reach is the shipped defect wearing a different hat. */
  const anchorsForEdit = (id: string): string[] => {
    const a = merged?.editAnchors[id];
    if (!a) return [];
    return Object.keys(tailorOverrides).filter((k) => ownsAnchor(a, k, a === id));
  };

  /** Edit id → what the user's own wording is doing on the block that edit
   * describes.
   *
   * THREE states, and the third was a lie until 23.8. An override whose anchor is
   * on no path is `"hidden"` ONLY when a decision took its block away — a
   * declined addition, a re-accepted removal — because dropping typed text on a
   * reversible toggle is the data loss the vanish rule exists to avoid, and
   * undoing the toggle brings it back. A block the USER cleared is off the page
   * for the opposite reason and needs the opposite offer: `applyOverrides` is the
   * only thing that knows which, so `merged.removed` is what separates them.
   * Without it, clearing a line reported "a declined change removed the line it
   * was on" and offered two buttons that both silently put the line back.
   *
   * Precedence is `yours` → `removed` → `hidden`, because those are three
   * statements of decreasing strength about the same block: text of the user's
   * own on the page outranks a deletion inside the same entry, which outranks
   * "kept but not applied". */
  const overriddenEdits = useMemo(() => {
    const out: Record<string, "yours" | "hidden" | "removed"> = {};
    if (!merged) return out;
    const onPage = new Set(Object.values(merged.sources));
    const deleted = new Set(merged.removed.map((r) => r.anchor));
    for (const [id, a] of Object.entries(merged.editAnchors)) {
      const mine = Object.keys(tailorOverrides).filter((k) => ownsAnchor(a, k, a === id));
      if (mine.length === 0) continue;
      out[id] = mine.some((k) => onPage.has(k))
        ? "yours"
        : mine.some((k) => deleted.has(k))
          ? "removed"
          : "hidden";
    }
    return out;
  }, [merged, tailorOverrides]);
  const overrideCount = Object.keys(tailorOverrides).length;

  /** Every hand-edit, and what each one is doing to the document right now.
   *
   * THE COUNT HAS TO BE ANSWERABLE. "3 edits of your own" beside one marked block
   * and one review badge is a number whose members cannot be found: an override
   * that DELETED a block has nothing to mark (it is off the paper) and no review
   * row (an untouched bullet or skill has no edit id), and so did an override on a
   * block a later decision took away. The only recovery on offer was "Clear my
   * edits", which reverts all three. This list is the enumeration — one row per
   * override, named by its own words, each with the one control that undoes it. */
  const myEdits = useMemo(() => {
    const out: { anchor: string; state: "yours" | "removed" | "hidden"; text: string; was: string }[] = [];
    if (!merged) return out;
    const byAnchor: Record<string, string> = {};
    for (const [path, a] of Object.entries(merged.sources)) if (!(a in byAnchor)) byAnchor[a] = path;
    // The SAME inversion against the pre-override merge. `applyOverrides` only
    // moves a path on a keyed rename, so for almost every row these two agree —
    // but "almost" is what silently prints the wrong line under a rename, which
    // is precisely the class of bug the anchor keying exists to kill.
    const wasByAnchor: Record<string, string> = {};
    for (const [path, a] of Object.entries(merged.baseSources)) if (!(a in wasByAnchor)) wasByAnchor[a] = path;
    const deleted = new Map(merged.removed.map((r) => [r.anchor, r.text]));
    for (const [anchor, values] of Object.entries(tailorOverrides)) {
      // WHAT UNDO PUTS BACK, read rather than guessed: the anchor already names
      // a coordinate, and `readBlock` on the pre-override merge is that
      // coordinate's own words. Without it the row shows what the user typed and
      // the button underneath promises to replace it with something that appears
      // nowhere on the page — the whole objection to a one-tap discard, one
      // scale down. Empty for the two states that have no pre-edit block to
      // read: a deletion already IS the pre-edit text, and a hand-edit the
      // vanish rule is holding has no path in either map.
      const wasPath = wasByAnchor[anchor];
      const was = wasPath ? blockText(readBlock(merged.base, wasPath)?.fields) : "";
      const gone = deleted.get(anchor);
      if (gone !== undefined) {
        out.push({ anchor, state: "removed", text: gone, was: "" });
        continue;
      }
      const path = byAnchor[anchor];
      const draft = path ? readBlock(merged.resume, path) : null;
      // No block to read means the vanish rule is holding this one: the words the
      // user typed are all there is left to name it by.
      out.push(
        draft
          ? { anchor, state: "yours", text: blockText(draft.fields), was }
          : {
              anchor,
              state: "hidden",
              text: blockText(Object.values(values).map((value) => ({ value }))),
              was: "",
            },
      );
    }
    return out;
  }, [merged, tailorOverrides]);
  const clearedCount = Object.keys(clearedOverrides ?? {}).length;

  // The document ↔ review jump. `spot` is the block lit up right now; `focusEdit`
  // carries a nonce so clicking the same block twice re-fires the effect.
  const docRef = useRef<HTMLDivElement>(null);
  const [docView, setDocView] = useState<DocView>("screen");
  // Which pane the document's drawer shows (PLAN 31.3/3). Held here, not in
  // DocumentPanel, because a draft's changes open from three places the panel
  // does not own: the toolbar's "N changes", the summary over the paper, and a
  // changed block tapped on the paper.
  const [pane, setPane] = useState<DrawerPane | null>(null);
  // Ephemeral, per session: the enumeration of the user's own edits is an answer
  // to a question they just asked, not a preference to remember. It needs no
  // reset either — the list is gated on `overrideCount`, so clearing the edits
  // takes the panel with them.
  const [yoursOpen, setYoursOpen] = useState(false);
  // "Back to my resume" is armed, having been tapped once while there were
  // hand-edits to lose. State on THIS page and not shared with the overlay's own
  // arming, for the Settings danger zone's reason: two destructive controls
  // sharing one flag lets a user who armed one confirm under the other — and
  // here the two sit side by side in the same toolbar row.
  const [discardArmed, setDiscardArmed] = useState(false);
  // "Tap anything on your resume to edit it", ONCE per device (PLAN 31.2/1). It
  // sat in the sticky toolbar on every visit, a whole row over the paper it
  // points at, long after the gesture was learned. It goes when "Got it" is
  // tapped or the first edit lands, whichever comes first.
  const [hintSeen, setHintSeen] = useState(() => {
    try {
      return localStorage.getItem(EDIT_HINT_KEY) !== null;
    } catch {
      return true; // storage unavailable: never nag
    }
  });
  const dismissHint = useCallback(() => {
    setHintSeen(true);
    try {
      localStorage.setItem(EDIT_HINT_KEY, "1");
    } catch {
      /* storage unavailable: it shows again next visit */
    }
  }, []);
  const [editPath, setEditPath] = useState<string | null>(null);
  // The entry THIS session just added, so an abandoned add can be undone and a
  // pre-existing blank entry cannot be deleted by accident.
  const [freshEntry, setFreshEntry] = useState<string | null>(null);
  // TWO FLAGS, and the split is the whole of 23.7.
  //
  // `isMaster` is the old `editable`, unchanged: the document on screen IS the
  // saved master resume, so a write here changes the file the user keeps. It
  // still gates everything that touches the master — the draft restore bar, the
  // save/undo cluster, Replace — and everything that ADDS a claim, because a
  // claim typed after the tailor ran carries no fabrication-guard verdict while
  // the summary line and the drawer keep reporting `result.fabrication_flags`.
  //
  // `canEditDoc` is new and is simply "there is a document": the paper is typed
  // on either way. With a result up the writes do not go into `resume` at all —
  // they become per-application overrides resolved through the merge's source
  // anchors, which is the override layer the old comment here said would be
  // needed. So: master ⇒ edit the document; tailored ⇒ edit an overlay that is
  // discarded with the result.
  const isMaster = !result && !!resume;
  useEffect(() => {
    if (!hintSeen && editUndo.length > 0) dismissHint();
  }, [hintSeen, editUndo.length, dismissHint]);
  const canEditDoc = !!shown;
  // The paper's own direction, frozen from the resume rather than the UI: the
  // chrome follows the locale, the document follows its own language.
  const paperDir = shown && resumeLanguage(shown) === "he" ? ("rtl" as const) : ("ltr" as const);
  // `spot` carries a nonce for the same reason `focusEdit` below does: React
  // bails on an identical state value, so setSpot(samePath) was a no-op --
  // saving two edits to one block, or tapping one review row twice, neither
  // restarted the 2200ms window nor replayed the highlight.
  const [spot, setSpot] = useState<{ path: string; nonce: number } | null>(null);
  const markSpot = (path: string) => setSpot((s) => ({ path, nonce: (s?.nonce ?? 0) + 1 }));
  const [focusEdit, setFocusEdit] = useState<{ id: string; nonce: number } | null>(null);

  useEffect(() => {
    if (!spot) return;
    const timer = setTimeout(() => setSpot(null), 2200);
    return () => clearTimeout(timer);
    // Depends on the OBJECT, not the path: a fresh nonce is a fresh identity,
    // which is what restarts the window on a repeat spotlight.
  }, [spot]);

  // Close the panel whenever a decision changes while a result is up. A toggle
  // can shift an index UNDER an open sheet — `@exp.1` is Beta in one decision
  // state and Gamma in the other — and `onGone` cannot see it: the path still
  // resolves, just to a different job, so the sheet would quietly apply the
  // user's edits to the wrong entry.
  useEffect(() => {
    if (getTailorState().result) setEditPath(null);
  }, [rejectedSet]);

  // Disarm the moment there is nothing left to warn about. Without it, undoing
  // the last hand-edit from the list while the exit is armed leaves a red
  // "Discard my 1 edit and leave" standing over a document with none — a confirm
  // whose sentence is false, which is worse than no confirm at all. The same
  // holds once the lines reach the job's row (PLAN 31.3/4): leaving then costs
  // them nothing.
  useEffect(() => {
    if (!result || overrideCount === 0 || draftSave === "saved") setDiscardArmed(false);
  }, [result, overrideCount, draftSave]);

  /**
   * Warn before the tab closes, for exactly as long as there is something to
   * lose.
   *
   * Since PLAN 31.3/4 the draft is saved with its job a short pause after each
   * change (`syncDraft`), so what can be lost is only a change that has not
   * reached the row: one waiting out the pause, one on the wire, or one whose
   * save failed. A hidden page sends a waiting change at once (iOS discards a
   * backgrounded tab routinely), and so does a closing one, before it asks.
   *
   * REGISTERED CONDITIONALLY, never once for the page. A permanent
   * `beforeunload` makes every reload of an untouched document ask a question
   * with no stakes, and a browser that sees the prompt abused stops honouring
   * it. The string is the browser's own, so the honest copy lives where the user
   * can read it before that moment: the draft's save status under the paper.
   */
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") flushDraftSave();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  const unsent = !!result && (draftSave === "saving" || draftSave === "failed");
  // Lines typed on the draft that did not reach the job's row: the one case in
  // which leaving the review loses words (PLAN 31.3/4). "saving" is not it: the
  // exit sends a waiting change first, and a note that flickered for a second
  // after every keystroke would be noise.
  const unsavedLines = !!result && overrideCount > 0 && draftSave === "failed";
  useEffect(() => {
    if (!unsent) return;
    const warn = (e: BeforeUnloadEvent) => {
      flushDraftSave();
      e.preventDefault();
      // Still required by Chrome and Safari to show the prompt at all, despite
      // being deprecated in the spec; `preventDefault()` alone is Firefox-only.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsent]);

  const smooth = () =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? ("auto" as const)
      : ("smooth" as const);

  /** Bring one block into view. ONE implementation, shared by the review-row
   * jump and by "you already have that skill", so the two can never disagree
   * about where a pointed-at block lands. The rAF is for callers that have just
   * changed what is rendered — the view switch below, or an accepted edit. */
  function scrollToBlock(path: string) {
    requestAnimationFrame(() => {
      docRef.current
        ?.querySelector<HTMLElement>(`[data-block="${CSS.escape(path)}"]`)
        // `center`, not `start`: styles.css sets a global scroll-padding-top for
        // the marketing header, and a small target reads better centred anyway.
        ?.scrollIntoView({ block: "center", behavior: smooth() });
    });
  }

  /** Point the document at one BLOCK PATH — select the view, light the block
   * up, bring it into the middle of the screen.
   *
   * ONE implementation for every "show me that on the CV" in the app: the
   * tailor review's rows (through `showInDoc` below, which resolves an edit id
   * first) and the deterministic review panel's rows (which already carry a
   * path). Two copies would drift on the one line that is easy to forget —
   * `setDocView("screen")`, without which the whole thing is a silent no-op
   * whenever the user is on the PDF or ATS tab, because `scrollIntoView` on a
   * `display:none` node does nothing and reports nothing. */
  function jumpToBlock(path: string) {
    setDocView("screen");
    markSpot(path);
    scrollToBlock(path);
  }

  /** Review row → document. Below `lg` the drawer covers the paper, so the jump
   * closes it first, the rule the "Check my CV" rows already follow
   * (`review.md`); evaluated at tap time so a rotation is handled. */
  function showInDoc(id: string) {
    const path = editBlock[id];
    if (!path) return; // an accepted removal is not on the page — nothing to point at
    if (!window.matchMedia("(min-width: 1024px)").matches) setPane(null);
    jumpToBlock(path);
  }

  /** Document block → review row. The row lives in the drawer since PLAN
   * 31.3/3, so the drawer opens on the changes and the change list scrolls to
   * the row (`focusEdit`). */
  function selectBlock(path: string) {
    const id = merged?.blocks[path]?.[0];
    if (!id) return; // an untouched block has nothing to show
    setPane("changes");
    setFocusEdit({ id, nonce: Date.now() });
  }

  async function onParsed(r: ResumeModel, l: FactsLedger) {
    // ONE definition of "a new master arrived", shared with the Jobs page's
    // replace and restore paths. It used to be a hand-written reset here and
    // nothing at all there, which is precisely how the two drifted: this copy
    // never cleared `fit` / `checkedFor` / `scoredAt` either.
    adoptMaster({
      resume: r,
      ledger: l,
      label: masterResumeLabel(r),
      language: resumeLanguage(r),
      updated_at: new Date().toISOString(),
    });
    const m = await persistMaster(r, l); // best-effort — null when the backend is unreachable
    // resetMasterCache() is NOT optional here, and leaving it out is why a
    // freshly uploaded resume "didn't take": saveMasterResume calls
    // invalidateData("master","masters"), which clears the dataCache Map and
    // CANNOT reach useMasterResume's module-level binding. Jobs, Interview and
    // every tool read the master from that binding, so they kept painting AND
    // SENDING the resume this upload just replaced — until a full page reload.
    if (m) {
      resetMasterCache();
      setTailorState({ masterLabel: m.label });
    } else {
      // Same reason as JobsPage: the hook only toasts on success, so a failed
      // save would leave the page showing a resume the server never stored.
      toast("error", t("common:masterResume.saveFailed"));
    }
  }

  // Feedback loop (§26): the AI wording the user rejected becomes a stored
  // negative signal — future tailors receive it as an avoid-list. Fired when
  // the review's decisions are final: a download (the file leaves the app) and
  // Mark applied. It fired on Save until PLAN 31.3/4 made saving automatic; a
  // save a pause after every toggle would teach the list a decline the user
  // took back a second later. Best-effort, and deduped server-side.
  function persistRejectedPhrases() {
    // Rewrites only. A rejected TRUNCATION means "put the cut text back", not
    // "I dislike this wording" — posting its `after` would teach the avoid-list
    // to shun the user's own sentence, which is the opposite of the signal.
    // Removals filter themselves out (`after === ""`).
    const phrases = edits
      .filter((e) => rejectedSet.has(e.id) && e.after.trim() !== "" && classifyEdit(e) === "rewrite")
      .map((e) => e.after);
    recordRejectedPhrases(phrases).catch(() => {});
  }

  // A save's toast offers the next step, not only the news (PLAN 31.2/10).
  const viewTracker = { action: { label: tCommon("actions.view"), onClick: () => navigate("/tracker") } };

  /** The job this draft is for, as the tracker row names it. */
  // Whether the fit reading on the MASTER still includes its tailor (PLAN
  // 31.3/1), for the one line over the paper that offers it. Called on every
  // render, like every hook; the reading only matters while no draft is up.
  const fitRide = useUses("tailor", fit && !result ? fit.tailor_included_until : undefined);

  const posting = useMemo(
    () => ({
      job_title: jd?.job_title || jobTitle || "",
      company: jd?.company || company || "",
      jd_text: jdText,
      job_url: jobUrl || undefined,
    }),
    [jd, jobTitle, company, jdText, jobUrl],
  );

  /**
   * THE DRAFT, AS IT WILL BE SAVED WITH ITS JOB (PLAN 31.3/4, owner decision 2).
   *
   * `effectiveResume` — the document on screen, every decision and hand-edit in
   * it — with what was sent (PLAN 17.3), so the analytics can later say which
   * resume earned the replies. The fabrication count is UNKNOWN (null), not a
   * number, once the user has written into the document: the guard ran against
   * `result.tailored_resume`, and this has their own text over it, text no guard
   * has seen. Storing the AI version's count would let a hand-typed claim be
   * counted as guard-clean forever. The letter rides only once there is one, so
   * a draft saved before it cannot erase a letter the row already holds.
   */
  const draftSnap = useMemo<DraftSnapshot | null>(() => {
    if (!result || !jd || !effectiveResume || loading) return null;
    return {
      draft: {
        tailored_resume: effectiveResume,
        template,
        voice_score: result.voice_report?.human_voice_score ?? null,
        fabrication_flag_count: overrideCount > 0 ? null : result.fabrication_flags.length,
        overall_score: result.score_after.overall,
        ...(coverLetterText ? { cover_letter: coverLetterText } : {}),
      },
      job: posting,
    };
  }, [result, jd, effectiveResume, loading, template, overrideCount, coverLetterText, posting]);

  // One toast for the save that made the row, one for a failure (not one per
  // failed retry while offline); "Saved" beside the draft says the rest.
  const failToasted = useRef(false);
  const onDraftSaved = useCallback(
    (o: DraftOutcome) => {
      if (o === "created") toast("success", t("toasts.savedToTracker"), viewTracker);
      if (o === "failed" && !failToasted.current) toast("error", t("toasts.trackerError"));
      failToasted.current = o === "failed";
    },
    // `viewTracker` is rebuilt every render and closes over nothing that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast, t],
  );
  // Every change to the draft, saved with its job. The saver sends nothing
  // when the draft on screen is the one the row already has.
  useEffect(() => {
    if (draftSnap) void syncDraft(draftSnap).then(onDraftSaved);
  }, [draftSnap, onDraftSaved]);

  /** Try again, after a save that failed: now, without the pause. */
  function retrySave() {
    if (draftSnap) void syncDraft(draftSnap, true).then(onDraftSaved);
  }

  // A download from this draft, which is when "Mark applied" becomes the next
  // step (PLAN 31.2/2). Page state: a new result starts again from "Saved".
  const [downloaded, setDownloaded] = useState(false);
  useEffect(() => setDownloaded(false), [result]);
  function downloadDraft(fmt: "docx" | "pdf") {
    if (!effectiveResume) return;
    setDownloaded(true);
    persistRejectedPhrases();
    void downloadResume(effectiveResume, fmt, resumeFilename(effectiveResume.contact.name, jd?.company ?? ""), template);
  }
  // The bar is up while a draft is; its height is what the toast stack and the
  // page's last lines must clear below lg.
  const barUp = !!result && !!effectiveResume && !loading;
  useEffect(() => {
    if (!barUp) return;
    const root = document.documentElement;
    root.style.setProperty("--bottom-bar", BAR_HEIGHT);
    return () => {
      root.style.removeProperty("--bottom-bar");
    };
  }, [barUp]);

  /** The job's row moves to Applied. With a draft up, the row is the one the
   * draft is saved on: every change is sent first, so the row holds what was
   * sent. Without one (the posting was opened before any tailor), or if no save
   * could make the row, this makes it, and the review adopts it. */
  async function markApplied() {
    try {
      let id = savedAppId;
      if (draftSnap) {
        void syncDraft(draftSnap, true);
        id = (await settleDraft()).row;
      }
      if (id !== null) {
        await updateApplication(id, { status: "applied" });
      } else {
        const app = await saveApplication({
          ...posting,
          overall_score: result?.score_after.overall ?? 0,
          status: "applied",
          ...(draftSnap
            ? {
                tailored_resume: draftSnap.draft.tailored_resume,
                cover_letter: draftSnap.draft.cover_letter,
                template,
                voice_score: draftSnap.draft.voice_score ?? undefined,
                fabrication_flag_count: draftSnap.draft.fabrication_flag_count ?? undefined,
              }
            : {}),
        });
        bindDraftRow(app.id, jdText, draftSnap?.draft);
      }
      setTailorState({ applied: true });
      persistRejectedPhrases();
      toast("success", t("toasts.markedApplied"), viewTracker);
    } catch {
      toast("error", t("toasts.trackerError"));
    }
  }

  // --- the tailored draft's review, in the document's drawer (PLAN 31.3/3) ---
  //
  // The page was the document and then four cards for about 7,000 px: a score
  // card, a keyword report, a voice check and the change list, with the keywords
  // said three times and the claims twice. Now the page is the document and one
  // summary line over it, and all of this is the drawer's "Changes" pane, the
  // drawer "Check my CV" already opens.

  /** Which of the guard's flags the document still carries: the drawer's own
   * reading (`flagStates`), so the summary's "N claims to check" and the rows
   * in the drawer are one answer. */
  const flagView = useMemo(
    () => (result ? flagStates(result.fabrication_flags, edits, editBlock, effectiveResume) : []),
    [result, edits, editBlock, effectiveResume],
  );
  const claimsOpen = flagView.filter((f) => !f.resolved).length;
  /** Keywords the resume carried BEFORE the tailor, out of the same analysed
   * posting the live count uses: the server's `score_before`, counted the way
   * `/tools/coverage` counts (`covered` over every gap). */
  const beforeCounts = result
    ? {
        covered: result.score_before.gaps.filter((g) => g.status === "covered").length,
        total: result.score_before.gaps.length,
      }
    : null;

  /** The lines the user typed on this draft, beside the changes they outrank.
   * The count IS the reveal: an override that deleted a block has nothing to
   * mark on the paper and no change row to sit in, so a number whose members
   * cannot be found would be worse than no number. */
  const yoursBlock =
    overrideCount > 0 || clearedCount > 0 ? (
      <div className="mt-4 space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {overrideCount > 0 && (
            <>
              <button
                type="button"
                aria-expanded={yoursOpen}
                onClick={() => setYoursOpen((o) => !o)}
                className="font-medium text-mint hover:underline"
              >
                {t("edit.yours", { count: overrideCount })}
              </button>
              <button
                type="button"
                onClick={clearAllBlockOverrides}
                className="font-medium text-accent-soft hover:underline"
              >
                {t("edit.yoursClear")}
              </button>
            </>
          )}
          {/* The one-step undo for "Clear my edits", deliberately outside the
              block above: clearing takes `overrideCount` to zero and that block
              with it, so an offer rendered inside would vanish in the same frame
              as the thing it undoes. Restoring MERGES, so anything typed since
              the clear survives it. */}
          {clearedCount > 0 && (
            <button type="button" onClick={restoreClearedOverrides} className="font-medium text-mint hover:underline">
              {t("edit.yoursRestoreCleared", { count: clearedCount })}
            </button>
          )}
        </div>
        {/* A conditional render with `animate-fade-up`, never a height tween
            (check 11). */}
        {yoursOpen && overrideCount > 0 && (
          <div className="animate-fade-up rounded-lg border border-line bg-panel-2/60 p-2">
            <ul className="space-y-1">
              {myEdits.map((e) => (
                <li key={e.anchor} className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span dir="auto" className="min-w-0 flex-1 truncate text-ink-muted">
                      {e.text || "—"}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 font-medium",
                        e.state === "removed" ? "text-warn" : e.state === "hidden" ? "text-ink-faint" : "text-mint",
                      )}
                    >
                      {e.state === "removed"
                        ? t("edit.yoursDeletedLine")
                        : e.state === "hidden"
                          ? t("edit.yoursOff")
                          : t("edit.yoursOn")}
                    </span>
                    <button
                      type="button"
                      onClick={() => clearBlockOverride(e.anchor)}
                      className="shrink-0 rounded-md border border-line px-2 py-0.5 font-medium text-ink-muted transition hover:bg-panel-2 hover:text-ink"
                    >
                      {e.state === "removed" ? t("edit.yoursPutBack") : t("edit.yoursUndoOne")}
                    </button>
                  </div>
                  {/* WHAT THE BUTTON ABOVE WILL PUT BACK, read off the
                      pre-override merge through the row's own anchor, so it is
                      the block's real previous wording. */}
                  {e.was && e.was !== e.text && (
                    <p dir="auto" className="truncate text-[11px] text-ink-faint">
                      {t("edit.yoursWas", { text: e.was })}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    ) : null;

  const fitTime =
    scoredAt !== null
      ? new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(scoredAt)
      : "";
  const sectionHeading = "text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted";
  const reviewPane =
    result && jd && effectiveResume && !loading
      ? {
          count: edits.length,
          content: (
            <div className="space-y-8">
              {/* The changes: the claims first, then the lines the user typed,
                  then every change, flagged first and each section under the
                  reason the tailor gave for it. */}
              <ChangeLog
                variant="drawer"
                beforeGroups={yoursBlock}
                edits={edits}
                changelog={result.changelog}
                flags={result.fabrication_flags}
                jdKeywords={result.score_after.gaps.map((g) => g.keyword)}
                rejected={rejectedSet}
                onSetRejected={(ids) => setTailorState({ rejectedEdits: ids })}
                original={original}
                effective={effectiveResume}
                lengthReport={result.length_report}
                plan={result.plan}
                template={template}
                onShowInDoc={showInDoc}
                anchoredEdits={editBlock}
                focusEdit={focusEdit}
                overridden={overriddenEdits}
                overrideCount={overrideCount}
                onUseAi={(id) => resolveOverride(id, false)}
                onUseOriginal={(id) => resolveOverride(id, true)}
                onRestoreMine={restoreOverride}
              />

              {/* The keywords, of the document ON SCREEN: the live coverage
                  the summary's "after" reads, not the AI version's. Above them
                  the one recruiter-fit reading, with the minute it was taken
                  and no before/after: two samples at temperature 0.3 are not a
                  measurement of improvement (`scoring.md`). */}
              <section className="space-y-3">
                <h3 className={sectionHeading}>{t("report.title")}</h3>
                <p className="text-xs leading-relaxed text-ink-muted">
                  <span className="font-semibold tabular-nums text-ink">
                    {t("fit.recruiter")} {Math.round(result.score_after.fit_score)}
                  </span>{" "}
                  · {t("fit.asOf", { time: fitTime })}
                </p>
                {result.score_after.rationale && (
                  <p className="text-xs leading-relaxed text-ink-muted">{result.score_after.rationale}</p>
                )}
                <MatchReport bare gaps={coverage.data?.gaps ?? result.score_after.gaps} jdText={jdText} />
              </section>

              {result.voice_report && (
                <section className="space-y-2">
                  <h3 className={sectionHeading}>{t("voice.title")}</h3>
                  <VoicePanel bare report={result.voice_report} plan={result.plan} />
                </section>
              )}

              {/* "Left out of this version": its own card, whose summary line
                  is its heading. The same `rejected` set as every change above,
                  so Restore here and a decline there are one decision. */}
              <LeftOut
                edits={edits}
                rejected={rejectedSet}
                onSetRejected={(ids) => setTailorState({ rejectedEdits: ids })}
                original={original}
                lengthReport={result.length_report}
                plan={result.plan}
                overridden={overriddenEdits}
              />

              {/* `initialText`: the drawer remounts the card on every open, and
                  the letter the user paid for lives in the store, not in the
                  card. It rides the next draft save to the job's row, and moves
                  to the job's own page with 31.4. */}
              <CoverLetter
                resume={effectiveResume}
                jd={jd}
                initialText={coverLetterText}
                onGenerated={(letter) => setTailorState({ coverLetterText: letter })}
              />
            </div>
          ),
        }
      : undefined;

  const appliedPrompt = (
    <>
      {applyClicked && !applied && (
        <div className="animate-fade-up">
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-soft px-3 py-2">
            <span className="text-sm text-ink">{t("applyPrompt.question")}</span>
            <Button size="sm" onClick={markApplied}>
              {t("applyPrompt.yes")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setTailorState({ applyClicked: false })}>
              {t("applyPrompt.notYet")}
            </Button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="space-y-6">
      {/* No page heading and no subtitle any more: the document's own name is
          the <h1>, up in DocumentToolbar. Two lines of chrome that said less
          than the CV's name does were the cheapest thing on this page to cut. */}
      {/* Before a draft only: on one, the toolbar names the job ("For <company>")
          and a breadcrumb and a target card said it twice more (PLAN 31.3/3). */}
      {(jobTitle || company) && !result && (
        <div className="app-col flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Link
            to="/jobs"
            className="inline-flex items-center gap-1 text-accent-soft hover:underline"
          >
            <ArrowLeft size={14} className="rtl:-scale-x-100" /> {t("breadcrumb.back")}
          </Link>
          <span className="text-ink-faint">·</span>
          <span className="min-w-0 truncate text-ink-muted">
            <Trans
              t={t}
              i18nKey={company ? "breadcrumb.tailoringForAt" : "breadcrumb.tailoringFor"}
              values={{ title: jobTitle || t("breadcrumb.thisJob"), company }}
              components={[
                <span key="0" />,
                <span key="1" className="font-medium text-ink" />,
                <span key="2" />,
                <span key="3" className="font-medium text-ink" />,
              ]}
            />
          </span>
        </div>
      )}

      {jobUrl && !result && (
        <div className="app-col">
          <Card className="border-accent/40">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Briefcase size={16} className="shrink-0 text-accent-soft" />
              <p className="min-w-0 truncate text-sm font-semibold text-ink">
                {t("target.label", { title: jobTitle || t("target.fallback") })}
                {company ? ` · ${company}` : ""}
              </p>
              <a
                href={jobUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => setTailorState({ applyClicked: true })}
                className="inline-flex items-center gap-1 text-sm text-accent-soft hover:underline"
              >
                {t("target.open")} <ExternalLink size={13} />
              </a>
              {applied && <Badge tone="mint">{t("target.appliedBadge")}</Badge>}
            </div>
            {appliedPrompt}
          </Card>
        </div>
      )}

      {/* Page level, not inside the result gate. `startTailor` can swap the
          loaded resume for its paired-language master, and now that the document
          is always on screen that swap happens under the user's eyes — so the
          notice has to be visible before any result exists. */}
      {langSwitched && (
        <div className="app-col flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink">
          <BadgeCheck size={15} className="shrink-0 text-accent-soft" />
          <span className="min-w-0">
            {t(`langSwitch.${langSwitched}`, { label: masterLabel || t("langSwitch.fallbackLabel") })}
          </span>
        </div>
      )}

      {/* Gated on the MASTER: this restores a draft OF the master, and with a
          tailor result up the document on screen is not it. */}
      {draft && isMaster && (
        <div className="app-col">
          <DraftRestoreBar savedAt={draft.savedAt} onKeep={keepDraft} onDiscard={discardDraft} />
        </div>
      )}

      {/* ONE ROW over the document (PLAN 31.2/1): the name, a page chip and one
          primary on the master; the way back, the job and the changes on a
          tailored draft. It measured 139 px on the master and 241 on a draft at
          390 px, four rows and a three-line note stuck over the paper. What
          left it: the "tap to edit" hint (a one-time line above the paper), the
          "Review N changes" link (the changes chip), the draft's note and the
          list of your own edits (under the document, beside the changes), and,
          below lg, "Tailor for a different job" (the tool row's "⋯"). What
          stays whatever it costs: a failure, and what leaving a draft you typed
          on will cost, stated AT REST (23.5's rule for an irreversible action).
          Tailoring is still a thing you DO to the CV on screen, not a stage. */}
      <DocumentToolbar
        lead={
          !result ? undefined : overrideCount > 0 && discardArmed ? (
            // THE EXIT FROM REVIEW MODE, armed. Until 23.7 there was no exit:
            // `editable` is `!result`, and nothing set `result` back to null.
            // With hand-edits on the draft it deletes every sentence typed on
            // it, so it arms first; the consequence is in the notes below.
            <>
              <Button
                size="sm"
                variant="danger"
                icon={<ArrowLeft size={15} className="rtl:-scale-x-100" />}
                onClick={() => {
                  setDiscardArmed(false);
                  discardTailorResult();
                }}
              >
                {t("discard.confirm", { count: overrideCount })}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setDiscardArmed(false)}>
                {t("discard.keep")}
              </Button>
            </>
          ) : (
            // An icon below sm, its words from sm. The name stays the words, so
            // a screen reader hears the same thing at every width.
            <Button
              size="sm"
              variant="ghost"
              icon={<ArrowLeft size={15} className="rtl:-scale-x-100" />}
              // Typed lines are lost by leaving ONLY when they never reached the
              // job's row (PLAN 31.3/4): every change is sent first, and the exit
              // arms only if the row still does not have them.
              onClick={() => {
                if (overrideCount === 0) return discardTailorResult();
                void settleDraft().then(({ save }) => (save === "saved" ? discardTailorResult() : setDiscardArmed(true)));
              }}
              // Only on the harmless branch, and only because it is a
              // DESCRIPTION there rather than a warning.
              title={unsavedLines ? undefined : t("discard.title")}
              className={cn("shrink-0", unsavedLines && "text-warn")}
            >
              <span className="sr-only sm:not-sr-only">{t("discard.cta")}</span>
            </Button>
          )
        }
        title={result ? tailoredTitle : docTitle}
        badges={
          <>
            {/* The saved master's own label, from lg. On a phone the title
                already names the document, and saying it twice cost the row. */}
            {!result && resume && masterLabel && (
              <span className="hidden shrink-0 items-center gap-1 text-xs text-mint lg:inline-flex">
                <BadgeCheck size={13} aria-hidden /> {masterLabel}
              </span>
            )}
            {/* MEASURED, deterministic, uncapped and free, which is the whole
                reason it can sit on a toolbar at all, and it answers before a
                tailor is paid for. `!result` because ChangeLog mounts the same
                badge while a result is up, and two mounts would double every
                server render. Compact below lg: the count and the target. */}
            {!result && <PageBadge compact resume={shown} template={template} className="shrink-0" />}
            {/* The number of changes IS the way to them: it was a "Review N
                changes" link on a line of its own under the row. */}
            {result && edits.length > 0 && (
              <button
                type="button"
                // The changes live in the document's drawer (PLAN 31.3/3).
                onClick={() => setPane("changes")}
                aria-expanded={pane === "changes"}
                className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-semibold tabular-nums text-ink transition-colors hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              >
                {t("toolbar.changes", { count: edits.length })}
              </button>
            )}
            {/* The other live, deterministic number, in the coverage sentence's words
                from lg and as a bare count below it, where the sentence would
                cost the row. A COUNT, never a band and never `overall`: half of
                that blend is stale by construction and it is off this surface
                on purpose. */}
            {coverage.data && (
              <span
                title={t("fit.coverage")}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-ink-muted transition-opacity",
                  coverage.stale && "opacity-50",
                )}
              >
                <Target size={12} aria-hidden />
                <span aria-hidden className="lg:hidden">
                  {t("fit.coverageShort", { covered: coverage.data.covered, total: coverage.data.total })}
                </span>
                <span className="sr-only lg:not-sr-only">
                  {t("fit.coverageSub", {
                    covered: coverage.data.covered,
                    total: coverage.data.total,
                    partial: coverage.data.partial,
                  })}
                </span>
              </span>
            )}
          </>
        }
        actions={
          <>
            {/* MASTER only, and it must stay that way. Its Save writes
                `state.resume`, a different document from the one on screen
                while a result is up. */}
            {isMaster && shown && (
              <ResumeEditBar
                resume={shown}
                savedResume={savedResume}
                masterLabel={masterLabel}
                unsaved={editUndo.length}
                saving={editSaving}
                error={editError}
              />
            )}
            {/* ONE primary per row (PLAN 31.7): while there is work to save,
                Save is it and this goes quiet, an icon below sm. On a tailored
                draft it is "a different job", from lg; below lg it is under the
                tool row's "⋯", because the loudest thing on a draft belongs to
                review and download, not to starting over. */}
            <Button
              size="sm"
              variant={result || editUndo.length > 0 ? "secondary" : "primary"}
              loading={loading}
              icon={<Wand2 size={15} />}
              disabled={!canRun}
              title={!resume ? t("run.uploadFirst") : undefined}
              onClick={() => setTailorState({ overlayOpen: true })}
              className={cn("shrink-0", result && "hidden lg:inline-flex")}
            >
              {result ? (
                t("overlay.openDifferent")
              ) : (
                <span className={editUndo.length > 0 ? "sr-only sm:not-sr-only" : undefined}>
                  {/* The job title earns its place on a wide screen and costs the
                      row on a 390px one, where the target card above names it. */}
                  <span className="sm:hidden">{t("overlay.open")}</span>
                  <span className="hidden sm:inline">
                    {jd?.job_title ? t("overlay.openFor", { title: jd.job_title }) : t("overlay.open")}
                  </span>
                </span>
              )}
            </Button>
          </>
        }
        notes={
          loading || error || unsavedLines ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {loading && <span className="text-xs text-ink-muted">{t("run.keepsRunning")}</span>}
              {error && <span className="text-sm text-danger">{error}</span>}
              {/* THE CONSEQUENCE, AT REST. It says what leaving this review
                  costs before the way back is touched, the order 23.5 settled
                  for the danger zone: "read what it admits to once armed" is
                  the wrong order for something irreversible. It turns
                  danger-coloured once armed, so arming still changes something
                  visible. It is the one line a draft's row may grow by, and
                  since PLAN 31.3/4 only while the lines are NOT on the job's
                  row: saved, leaving costs them nothing. */}
              {unsavedLines && (
                <span className={cn("text-xs leading-relaxed", discardArmed ? "text-danger" : "text-ink-muted")}>
                  {t("discard.edited", { count: overrideCount })}
                </span>
              )}
            </div>
          ) : undefined
        }
      />

      {/* Everything under the toolbar is the centred column (`.app-col`). The
          toolbar is the one child that spans the window, like the header; the
          edit sheet and the tailor overlay below portal out of the page and
          stay outside this wrapper so nothing here can constrain them. */}
      <div className="app-col space-y-6">
        {isMaster && shown && !hintSeen && (
          <p className="animate-fade-up flex items-center gap-1.5 text-xs text-ink-faint">
            <Pencil size={12} aria-hidden className="shrink-0" />
            <span className="min-w-0 flex-1">{t("edit.hint")}</span>
            <button
              type="button"
              onClick={dismissHint}
              className="shrink-0 rounded-md px-2 py-1 font-medium text-accent-soft hover:bg-accent/10"
            >
              {t("edit.hintDismiss")}
            </button>
          </p>
        )}

        {/* A FIT READING ON THE MASTER IN ONE LINE (PLAN 31.3/1): the check is
            step one of tailoring, and a reading left on the page leads back to
            step two, the dialog with it and its Tailor. It replaced a three-tile
            score card whose third tile said the guard had not run yet. Only for
            the posting in `jdText`: the reading and its text are one thing. */}
        {fit && !result && shown && checkedFor !== null && checkedFor === jdText.trim() && (
          <button
            type="button"
            onClick={() => setTailorState({ overlayOpen: true })}
            className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-panel px-3 py-2 text-start text-xs text-ink-muted shadow-sm transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            <span className={cn("inline-flex items-center gap-1 tabular-nums text-ink", coverage.stale && "opacity-60")}>
              <Target size={13} aria-hidden className="shrink-0 text-accent-soft" />
              {t("review.summary.keywordsNow", {
                after: coverage.data?.covered ?? fit.covered,
                total: coverage.data?.total ?? fit.total,
              })}
            </span>
            {/* One model reading and the minute it was taken, its whole claim
                to honesty: it does not move as the resume is edited. */}
            <span className="tabular-nums">
              {t("review.summary.fitAt", {
                score: Math.round(fit.fit_score),
                time:
                  fitScoredAt !== null
                    ? new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(fitScoredAt)
                    : "",
              })}
            </span>
            <span className="ms-auto inline-flex items-center gap-0.5 font-semibold text-accent-soft">
              {fitRide.covered ? t("overlay.tailorIncluded") : t("overlay.tailor")}
              <ChevronRight size={14} aria-hidden className="rtl:-scale-x-100" />
            </span>
          </button>
        )}

        {/* A TAILORED DRAFT IN ONE LINE (PLAN 31.3/3): keywords before and
            after, the claims to check, the page count. Every part of it opens
            the drawer that holds the rest. */}
        {reviewPane && result && effectiveResume && (
          <DraftSummary
            before={beforeCounts}
            after={coverage.data ? { covered: coverage.data.covered, total: coverage.data.total } : null}
            stale={coverage.stale}
            claimsOpen={claimsOpen}
            claimsRaised={result.fabrication_flags.length}
            typed={overrideCount}
            resume={effectiveResume}
            template={template}
            onOpen={() => setPane("changes")}
          />
        )}

        {/* The document, or — with no resume yet — the one thing there is to do. */}
        {shown ? (
          <DocumentPanel
            ref={docRef}
            resume={shown}
            template={template}
            view={docView}
            onView={setDocView}
            // The rail owns the picker now, so the chosen template governs the
            // on-screen preview, the real PDF, the x-ray AND the download at all
            // times — not only once a tailor result exists.
            onTemplate={setTemplate}
            company={jd?.company ?? company}
            marks={marks}
            // The review's own vocabulary, kept apart from `marks` — see
            // ResumeView's Props note on why one Map cannot hold both.
            flags={reviewFlags}
            review={review.data}
            reviewStale={review.stale}
            reviewFailed={review.failed}
            // The tool's gate as well as its jump: no callback, no review panel.
            onJumpToBlock={jumpToBlock}
            // "Use this" goes through the SAME writer as a caret edit on the
            // paper, so the master/tailored split has exactly one implementation:
            // `applyBlockEdit` on the master, `setBlockOverride` on a tailored
            // draft, and never `writeDraft` on either. A private write path in
            // the panel would be the 23.7 defect on purpose — one keystroke
            // through `applyBlockEdit` while a result is up nulls `result`,
            // `tailoredFrom` and `rejectedEdits` and destroys the whole review.
            onUseRewrite={canEditDoc ? commitInline : undefined}
            activeBlock={spot?.path ?? null}
            activeNonce={spot?.nonce}
            onSelectBlock={selectBlock}
            // The paper is typed on in both modes; `commitInline` is what routes
            // a tailored edit into the override layer instead of the master.
            onEditBlock={canEditDoc ? setEditPath : undefined}
            onInlineCommit={canEditDoc ? commitInline : undefined}
            // ADDING stays master-only, and the reason is the fabrication guard,
            // not caution. It ran against `result.tailored_resume`; a claim typed
            // in afterwards carries no verdict at all, while the drawer goes
            // on rendering `result.fabrication_flags` as though it described the
            // document on screen. An added block also exists in neither the
            // original nor the tailored resume, so it has no source anchor to be
            // stored against. Adds belong in their own change, with their own
            // guard story.
            onAddSkill={isMaster ? addSkill : undefined}
            onAdd={isMaster ? addToResume : undefined}
            onAddNamed={isMaster ? addNamed : undefined}
            onAddBullet={isMaster ? addBullet : undefined}
            // In the add control's own place, so its absence is answered where
            // the question gets asked rather than in a toolbar three scrolls up.
            footNote={result ? t("edit.tailoredNoAdd") : undefined}
            // Master only: replacing the file under a tailor review would be
            // replacing the thing being reviewed. `onParsed` is the SAME handler
            // the empty state uses, so the cold start and the replacement are one
            // path.
            onReplace={isMaster ? onParsed : undefined}
            // On a draft, below lg, "Tailor for a different job" left the
            // toolbar's one row for the tool row's "⋯" (PLAN 31.2/1).
            moreItems={
              result && canRun
                ? [
                    {
                      key: "retailor",
                      label: t("overlay.openDifferent"),
                      Icon: Wand2,
                      onClick: () => setTailorState({ overlayOpen: true }),
                    },
                    // The posting, on a draft (PLAN 31.3/3): its target card
                    // left the page, and opening it is what makes Mark applied
                    // the bar's next step.
                    ...(jobUrl
                      ? [
                          {
                            key: "posting",
                            label: t("target.open"),
                            Icon: ExternalLink,
                            href: jobUrl,
                            onClick: () => setTailorState({ applyClicked: true }),
                          },
                        ]
                      : []),
                  ]
                : undefined
            }
            // A tailored draft's review is the drawer's second pane, opened from
            // the toolbar, the summary line and a changed block.
            changes={reviewPane}
            pane={pane}
            onPane={setPane}
          />
        ) : masterLoad === "loading" ? (
          // Where the paper will be, the height DocumentPanel's file view gives
          // its own loading state. Never the upload card: see `masterLoad`.
          <div role="status" aria-label={t("upload.loading")}>
            <Skeleton className="h-[70vh] w-full" />
          </div>
        ) : masterLoad === "failed" ? (
          // Not the upload card either: we could not look, so we cannot say
          // there is nothing there.
          <Card>
            <p role="alert" className="text-sm text-danger">
              {t("upload.loadFailed")}
            </p>
            <Button variant="secondary" className="mt-3" onClick={loadMaster}>
              {t("common:actions.retry")}
            </Button>
          </Card>
        ) : (
          <Card>
            <CardTitle>{t("upload.title")}</CardTitle>
            <div className="mt-3">
              <ResumeUpload onParsed={onParsed} />
            </div>
            {/* The cold start, and it is now the SAME surface as everything else:
                a blank page you type on. This replaced /builder — an 848-line
                wizard that was a second editor for one resume, and produced the
                "which one is my real CV" question it existed to avoid. */}
            <button
              type="button"
              onClick={startFromScratch}
              className="mt-3 inline-block text-sm text-accent-soft hover:underline"
            >
              {t("upload.buildLink")}
            </button>
          </Card>
        )}

        {loading && (
          <div className="space-y-4">
            <Skeleton className="h-44 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        )}

        <AnimatePresence>
          {result && jd && effectiveResume && !loading && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="space-y-4"
            >
              {/* The draft's own note, and where it is kept. The lines the user
                  typed and every change moved into the drawer (PLAN 31.3/3). */}
              <div className="space-y-1 text-xs">
                <p className="leading-relaxed text-ink-muted">{t("edit.tailoredHint")}</p>
                {/* WHERE THIS DRAFT IS KEPT, and whether the last change got
                    there (PLAN 31.3/4). It replaced "these edits live only for
                    this visit, in this tab", and it may say "saved" only when
                    the row has answered. */}
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 leading-relaxed">
                  {draftSave === "failed" ? (
                    <>
                      <span className="text-danger">{t("jobDraft.failed")}</span>
                      <button type="button" onClick={retrySave} className="font-medium text-accent-soft hover:underline">
                        {t("jobDraft.retry")}
                      </button>
                    </>
                  ) : draftSave === "saved" ? (
                    <>
                      <span className="text-mint">✓ {t("jobDraft.saved")}</span>
                      <Link to="/tracker" className="font-medium text-accent-soft hover:underline">
                        {tCommon("actions.view")}
                      </Link>
                    </>
                  ) : (
                    <span className="text-ink-faint">{t("jobDraft.saving")}</span>
                  )}
                </p>
              </div>

              {/* THE LAST STEP ON A DESKTOP, in one row: what the phone's bar on
                  the tab bar holds (Word, PDF and the one next step), plus the
                  posting. It was a card with a title, an ATS note and an x-ray
                  link; the views over the paper already switch to "What the ATS
                  reads", and the Word fallback of a two-column design is the one
                  note that still changes what the user gets. */}
              <div className="hidden space-y-2 lg:block">
                <div className="flex flex-wrap items-center gap-3">
                  <Button icon={<Download size={16} />} onClick={() => downloadDraft("docx")}>
                    {t("download.docx")}
                  </Button>
                  <Button variant="secondary" icon={<Download size={16} />} onClick={() => downloadDraft("pdf")}>
                    {t("download.pdf")}
                  </Button>
                  {jobUrl && (
                    <a
                      href={jobUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setTailorState({ applyClicked: true })}
                      className="inline-flex items-center gap-1 text-sm text-accent-soft hover:underline"
                    >
                      <ExternalLink size={14} /> {t("target.open")}
                    </a>
                  )}
                  <div className="flex-1" />
                  {/* The one next step, as on the phone's bar: Saved by itself
                      (a Save button only after a failure), Mark applied after a
                      download or opening the posting, then Applied. */}
                  {applied ? (
                    <Badge tone="mint">{t("target.appliedBadge")}</Badge>
                  ) : downloaded || applyClicked ? (
                    <Button onClick={markApplied}>{t("bar.markApplied")}</Button>
                  ) : draftSave === "failed" ? (
                    <Button variant="ghost" icon={<Save size={16} />} onClick={retrySave}>
                      {t("save.cta")}
                    </Button>
                  ) : (
                    <span className={cn("text-sm", draftSave === "saved" ? "text-mint" : "text-ink-faint")}>
                      {draftSave === "saved" ? t("save.saved") : t("save.saving")}
                    </span>
                  )}
                </div>
                {/* A two-column pick can't ship as .docx: the Word button above
                    sends the single-column fallback, and this says so. */}
                {isPdfOnlyTemplate(template) && (
                  <p className="text-xs text-ink-muted">
                    {t("download.docxFallback", { name: t(`download.templates.${template}.name`) })}
                  </p>
                )}
                {appliedPrompt}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {shown && (
        <BlockEditSheet
          path={editPath}
          resume={shown}
          paperDir={paperDir}
          onClose={closeEditSheet}
          // Exactly one of these two ever fires. With a result up the sheet
          // hands back raw VALUES and they become an override; without one it
          // hands back a resume and that resume becomes the master.
          onApplyValues={result ? commitBlockValues : undefined}
          onApply={(next, path) => {
            applyBlockEdit(next);
            setFreshEntry(null); // it has content now; it is a normal entry
            setEditPath(null);
            if (path) markSpot(path);
          }}
          onGone={() => {
            setEditPath(null);
            // The dismissal path that used to leave `freshEntry` set. It is a
            // coordinate in the MASTER, and a stale one becomes a coordinate in
            // the WRONG document the moment a tailor result arrives — see
            // `closeEditSheet`, which is the function that would act on it.
            setFreshEntry(null);
            toast("info", t("edit.gone"));
          }}
        />
      )}

      {/* THE LAST STEP, WHERE THE THUMB IS (PLAN 31.2/2). Download and the
          job's status sat about 6,580 px down a 7,168 px page at 390 px. Below
          lg this bar rides on the tab bar while a draft is up. The status is
          the NEXT step, one at a time: Saved (by itself since PLAN 31.3/4,
          and a Save button again only when that failed), then after a
          download or opening the posting "Mark applied", then Applied. Only
          an action is the primary. The result card further down keeps its
          buttons, for a desktop and for the notes beside them. */}
      {barUp && (
        <div
          role="region"
          aria-label={t("bar.label")}
          className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-line/70 bg-bg/95 px-4 py-2 backdrop-blur-xl lg:hidden"
        >
          <div className="mx-auto flex max-w-md items-center gap-2">
            <Button
              variant="secondary"
              icon={<Download size={16} />}
              aria-label={t("bar.wordName")}
              onClick={() => downloadDraft("docx")}
            >
              {t("bar.word")}
            </Button>
            <Button
              variant="secondary"
              icon={<Download size={16} />}
              aria-label={t("bar.pdfName")}
              onClick={() => downloadDraft("pdf")}
            >
              {t("bar.pdf")}
            </Button>
            <div className="ms-auto">
              {applied ? (
                <span className="text-sm font-semibold text-mint">{t("target.appliedBadge")}</span>
              ) : downloaded || applyClicked ? (
                <Button onClick={markApplied}>{t("bar.markApplied")}</Button>
              ) : draftSave === "failed" ? (
                <Button icon={<Save size={16} />} aria-label={t("save.cta")} onClick={retrySave}>
                  {t("bar.save")}
                </Button>
              ) : draftSave === "saved" ? (
                <span className="text-sm font-semibold text-mint">✓ {t("bar.saved")}</span>
              ) : (
                <span className="text-sm text-ink-faint">{t("bar.saving")}</span>
              )}
            </div>
          </div>
        </div>
      )}
      {/* The bar's height again, so the page's last lines scroll clear of it. */}
      {barUp && <div aria-hidden className="h-[3.75rem] lg:hidden" />}

      {resume && (
        <TailorOverlay
          open={overlayOpen}
          onClose={() => setTailorState({ overlayOpen: false })}
          resume={resume}
          jdText={jdText}
          checkedFor={checkedFor}
          fit={fit}
          tailoring={loading}
          hasResult={!!result}
          // The overlay's Tailor button can destroy these, so it is the overlay
          // that has to arm-then-confirm and to name the count in its own
          // "this starts again from your master resume" note. Since PLAN
          // 31.3/4 it destroys them only for the same posting, whose new draft
          // replaces the saved one, or when they never reached the job's row.
          overrideCount={overrideCount}
          savedFor={savedFor}
          draftSaved={draftSave === "saved"}
          onChecked={(text, f) =>
            // `fitScoredAt`, never `scoredAt`: this stamp belongs to THIS
            // reading. `scoredAt` is the tailor's, written by `startTailor`'s
            // success branch beside `result.score_after`.
            setTailorState({ jdText: text, jd: f.jd, fit: f, checkedFor: text, fitScoredAt: Date.now() })
          }
          onTailor={(text, held) => {
            // The Jobs-page handoff (`setTargetJob`) sets jobUrl/jobTitle/company
            // alongside jdText. Tailoring for a DIFFERENT posting must not leave
            // the breadcrumb, the target card and `save()`'s `job_url` naming the
            // old one. This is the ONE place the rule inverts `adoptMaster`'s
            // ("the target job survives — which posting you are aiming at has
            // nothing to do with which file your resume is in"): here the posting
            // is precisely what changed.
            //
            // Trimmed on BOTH sides: `setTargetJob` stores the JD untrimmed and
            // the overlay hands back `draft.trim()`, so a bare comparison would
            // wipe a correct target on a trailing newline — a guard firing on
            // legitimate input.
            const changed = text !== jdText.trim();
            setTailorState({
              ...(changed
                ? { jdText: text, jobUrl: undefined, jobTitle: undefined, company: undefined }
                : { jdText: text }),
              // A fit check taken in the dialog while a draft was up becomes
              // this posting's reading NOW, before `startTailor` reads it: the
              // same four fields `onChecked` writes, so the tailor reuses its
              // analysed JD and claims the ride that check opened (PLAN 31.3/1:
              // one use for the check and the tailor, whichever way in).
              ...(held ? { jd: held.fit.jd, fit: held.fit, checkedFor: text, fitScoredAt: held.at } : {}),
              overlayOpen: false,
            });
            startTailor();
          }}
        />
      )}
    </div>
  );
}
