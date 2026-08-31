import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import { Wand2, Download, Save, BadgeCheck, Briefcase, ExternalLink, ArrowLeft, ScanEye, Target } from "lucide-react";
import {
  downloadResume,
  resumeFilename,
  getApplication,
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
import ChangeLog from "../components/ChangeLog";
import DocumentPanel, { type DocView } from "../components/DocumentPanel";
import TailorOverlay from "../components/TailorOverlay";
import BlockEditSheet from "../components/BlockEditSheet";
import ResumeEditBar from "../components/ResumeEditBar";
import { useCoverage } from "../hooks/useCoverage";
import CoverLetter from "../components/CoverLetter";
import MatchReport from "../components/MatchReport";
import ResumeUpload from "../components/ResumeUpload";
import ScoreCard from "../components/ScoreCard";
import VoicePanel from "../components/VoicePanel";
import { resetMasterCache } from "../hooks/useMasterResume";
import { masterResumeLabel, useSaveMasterResume } from "../hooks/useSaveMasterResume";
import { blocksByEdit, mergeForReview } from "../lib/resumeDiff";
import { applyOverrides, blockText, movedPath } from "../lib/resumeOverrides";
import {
  inlineField,
  insertBlock,
  insertBullet,
  insertSkill,
  readBlock,
  removeBlock,
  writeBlock,
  type InsertKind,
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
  clearAllBlockOverrides,
  clearBlockOverride,
  discardTailorResult,
  getTailorState,
  restoreClearedOverrides,
  setBlockOverride,
  setTailorState,
  setTargetJob,
  startTailor,
  subscribeTailor,
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

export default function TailorPage() {
  const { t } = useTranslation("tailor");
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
    saved,
    savedAppId,
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
    jobUrl,
    jobTitle,
    company,
  } = useSyncExternalStore(subscribeTailor, getTailorState);
  const toast = useToast();
  // Download-card template choice (visual only — every option is ATS-safe).
  const [template, setTemplate] = useState<ResumeTemplate>("classic");
  const persistMaster = useSaveMasterResume();

  // Deep handoff from the Chrome extension ("Save & tailor"): ?tailor_app=<id>
  // loads that tracker application's JD into the target-job slot. The param is
  // stripped immediately so reloads don't re-apply it over in-progress work.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const raw = searchParams.get("tailor_app");
    if (!raw) return;
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

  useEffect(() => {
    if (getTailorState().resume) return; // already loaded (or uploaded) this session
    (async () => {
      try {
        const m = await getMasterResume();
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
      } catch {
        /* no saved résumé yet */
      }
    })();
  }, []);

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
   * same string everywhere: a nameless CV renders the "Résumé" placeholder over
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
    // tailored CV back as the user's real résumé on their next visit.
    //
    // Stored against the block's SOURCE ANCHOR, never its path. Committed on
    // BLUR, like the master path, and that is what keeps the caret alive: the
    // merged memo now depends on `tailorOverrides`, so a commit produces a new
    // résumé object and re-renders the sheet. On input it would kill the caret
    // on the first keystroke.
    //
    // `if (result)` FIRST, then the null check INSIDE it, and the nesting is the
    // point. As `if (result && merged)` the fallthrough was the MASTER writer:
    // with a result up and `merged` somehow null, a keystroke on the tailored
    // document would resolve a TAILORED path against the master résumé, call
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

  /** Add something and put the caret (or the panel) on it straight away. An
   * added thing you then have to hunt for is not an add control. */
  function addToResume(kind: InsertKind) {
    const base = getTailorState().resume;
    if (!base) return;
    const res = insertBlock(base, kind);
    if (!res.ok) return;
    applyBlockEdit(res.resume);
    // Compound kinds have no single field to type into, so they open the panel;
    // the single-field kinds get a caret, on the next frame, once rendered.
    if (inlineField(res.resume, res.path)) focusBlockSoon(res.path);
    else {
      setFreshEntry(res.path);
      setEditPath(res.path);
    }
  }

  /** A finished skill, typed straight onto the chip row of the group the user
   * was reading — no placeholder chip to rename, and the field stays open so
   * the next one can follow. `insertSkill` writes BOTH `skills` and the group,
   * for the reason `writeSkill` documents.
   *
   * A skill you already have is not an edit: `insertSkill` hands back the SAME
   * résumé object, so the identity check keeps it off the undo stack. It is
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
   * panel would delete a role from the saved résumé and take the review with it
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

  // The document is always on screen when a résumé exists, so there is no
  // stepper any more: `step` gated nothing and described a flow that no
  // longer happens. Tailoring is an action ON the document, not a stage.
  const canRun = !!resume && !loading;

  // Per-bullet accept/reject: diff the tailored résumé against the one it was
  // tailored from, and build the effective résumé the user actually ships.
  const original = tailoredFrom ?? resume;
  const rejectedSet = useMemo(() => new Set(rejectedEdits), [rejectedEdits]);
  // ONE walk for all three: the edit list, the résumé the user ships, and where
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
  // What the page shows: the tailored résumé once there is one, the master
  // before that. This one expression is the whole of "the page always has a CV".
  const shown = effectiveResume ?? resume;
  // The document names its own page. The fallback is safe HERE and nowhere on
  // the paper: a heading is not `contentEditable`, so unlike the sheet's
  // placeholder it can never be committed into `contact.name` by a tap.
  const docTitle = shown?.contact?.name?.trim() || t("sections.fallbackName");

  // The live, deterministic half of the match — recomputed from the document as
  // it stands, on every accept and decline. The other half cannot move without
  // spending, so it is not here.
  const coverage = useCoverage(shown, jd);

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
  // Ephemeral, per session: the enumeration of the user's own edits is an answer
  // to a question they just asked, not a preference to remember. It needs no
  // reset either — the list is gated on `overrideCount`, so clearing the edits
  // takes the panel with them.
  const [yoursOpen, setYoursOpen] = useState(false);
  // "Back to my résumé" is armed, having been tapped once while there were
  // hand-edits to lose. State on THIS page and not shared with the overlay's own
  // arming, for the Settings danger zone's reason: two destructive controls
  // sharing one flag lets a user who armed one confirm under the other — and
  // here the two sit side by side in the same toolbar row.
  const [discardArmed, setDiscardArmed] = useState(false);
  const [editPath, setEditPath] = useState<string | null>(null);
  // The entry THIS session just added, so an abandoned add can be undone and a
  // pre-existing blank entry cannot be deleted by accident.
  const [freshEntry, setFreshEntry] = useState<string | null>(null);
  // TWO FLAGS, and the split is the whole of 23.7.
  //
  // `isMaster` is the old `editable`, unchanged: the document on screen IS the
  // saved master résumé, so a write here changes the file the user keeps. It
  // still gates everything that touches the master — the draft restore bar, the
  // save/undo cluster, Replace — and everything that ADDS a claim, because a
  // claim typed after the tailor ran carries no fabrication-guard verdict while
  // ScoreCard below keeps rendering `result.fabrication_flags` beside it.
  //
  // `canEditDoc` is new and is simply "there is a document": the paper is typed
  // on either way. With a result up the writes do not go into `resume` at all —
  // they become per-application overrides resolved through the merge's source
  // anchors, which is the override layer the old comment here said would be
  // needed. So: master ⇒ edit the document; tailored ⇒ edit an overlay that is
  // discarded with the result.
  const isMaster = !result && !!resume;
  const canEditDoc = !!shown;
  // The paper's own direction, frozen from the résumé rather than the UI: the
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
  // whose sentence is false, which is worse than no confirm at all.
  useEffect(() => {
    if (!result || overrideCount === 0) setDiscardArmed(false);
  }, [result, overrideCount]);

  /**
   * Warn before the tab closes, for exactly as long as there is something to
   * lose.
   *
   * `tailorOverrides` lives in module memory and nowhere else — no draft mirror
   * (correct: the 22.11 draft is the MASTER's) and no sessionStorage — and iOS
   * discards a backgrounded tab routinely. Re-tailoring the same posting is not
   * a recovery either: `temperature=0.3` returns different text, so the
   * sentences are gone for good.
   *
   * REGISTERED CONDITIONALLY, never once for the page. A permanent
   * `beforeunload` makes every reload of an untouched document ask a question
   * with no stakes, and a browser that sees the prompt abused stops honouring
   * it. The string is the browser's own — none of them has let a page choose it
   * for years — so the honest copy has to live where the user can read it before
   * that moment, which is `edit.tailoredHint` on the toolbar.
   */
  useEffect(() => {
    if (!result || overrideCount === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Still required by Chrome and Safari to show the prompt at all, despite
      // being deprecated in the spec; `preventDefault()` alone is Firefox-only.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [result, overrideCount]);

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

  /** Review row → document. */
  function showInDoc(id: string) {
    const path = editBlock[id];
    if (!path) return; // an accepted removal is not on the page — nothing to point at
    // The file and ATS views hide the screen document, and scrollIntoView on a
    // display:none node is a silent no-op — so select it before scrolling.
    setDocView("screen");
    markSpot(path);
    scrollToBlock(path);
  }

  /** Document block → review row. */
  function selectBlock(path: string) {
    const id = merged?.blocks[path]?.[0];
    if (!id) return; // an untouched block has nothing to show
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
    // freshly uploaded résumé "didn't take": saveMasterResume calls
    // invalidateData("master","masters"), which clears the dataCache Map and
    // CANNOT reach useMasterResume's module-level binding. Jobs, Interview and
    // every tool read the master from that binding, so they kept painting AND
    // SENDING the résumé this upload just replaced — until a full page reload.
    if (m) {
      resetMasterCache();
      setTailorState({ masterLabel: m.label });
    } else {
      // Same reason as JobsPage: the hook only toasts on success, so a failed
      // save would leave the page showing a résumé the server never stored.
      toast("error", t("common:masterResume.saveFailed"));
    }
  }

  // Feedback loop (§26): the AI wording the user rejected becomes a stored
  // negative signal — future tailors receive it as an avoid-list. Fired on
  // save/apply (the moment the review decisions are final), best-effort.
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

  /** What was actually sent, recorded on the tracker row so the analytics can
   * later say which résumé earned the replies (PLAN 17.3). */
  function sentSignals() {
    return {
      template,
      voice_score: result?.voice_report?.human_voice_score,
      // UNKNOWN, not a number, once the user has written into the document. The
      // guard ran against `result.tailored_resume`; what this row records is
      // `effectiveResume`, which has their own text over it — text no guard has
      // ever seen. A row that predates the field means unknown and the analytics
      // drops it from that dimension, which is exactly the right treatment here;
      // storing 0 would let a hand-typed claim be counted as guard-clean forever.
      fabrication_flag_count: overrideCount > 0 ? undefined : result?.fabrication_flags.length,
    };
  }

  async function save() {
    if (!result || !jd) return;
    if (savedAppId !== null) {
      // Already created (by Save or "Yes, applied") — never double-create.
      setTailorState({ saved: true });
      toast("success", t("toasts.alreadyInTracker"));
      return;
    }
    const app = await saveApplication({
      job_title: jd.job_title,
      company: jd.company,
      jd_text: jdText,
      tailored_resume: effectiveResume ?? result.tailored_resume,
      cover_letter: coverLetterText,
      overall_score: result.score_after.overall,
      job_url: jobUrl || undefined,
      ...sentSignals(),
    });
    setTailorState({ savedAppId: app.id, saved: true });
    persistRejectedPhrases();
    toast("success", t("toasts.savedToTracker"));
  }

  async function markApplied() {
    try {
      if (savedAppId !== null) {
        await updateApplication(savedAppId, { status: "applied" });
        setTailorState({ saved: true, applied: true });
      } else {
        const app = await saveApplication({
          job_title: jd?.job_title || jobTitle || "",
          company: jd?.company || company || "",
          jd_text: jdText,
          // Backend accepts a missing tailored_resume; axios drops undefined fields.
          tailored_resume: effectiveResume as ResumeModel,
          cover_letter: coverLetterText,
          overall_score: result?.score_after.overall ?? 0,
          status: "applied",
          job_url: jobUrl,
          ...sentSignals(),
        });
        setTailorState({ savedAppId: app.id, saved: true, applied: true });
      }
      persistRejectedPhrases();
      toast("success", t("toasts.markedApplied"));
    } catch {
      toast("error", t("toasts.trackerError"));
    }
  }

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
      {(jobTitle || company) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
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

      {jobUrl && (
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
          {!result && appliedPrompt}
        </Card>
      )}

      {/* Page level, not inside the result gate. `startTailor` can swap the
          loaded résumé for its paired-language master, and now that the document
          is always on screen that swap happens under the user's eyes — so the
          notice has to be visible before any result exists. */}
      {langSwitched && (
        <div className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink">
          <BadgeCheck size={15} className="shrink-0 text-accent-soft" />
          <span className="min-w-0">
            {t(`langSwitch.${langSwitched}`, { label: masterLabel || t("langSwitch.fallbackLabel") })}
          </span>
        </div>
      )}

      {/* Gated on the MASTER: this restores a draft OF the master, and with a
          tailor result up the document on screen is not it. */}
      {draft && isMaster && (
        <DraftRestoreBar savedAt={draft.savedAt} onKeep={keepDraft} onDiscard={discardDraft} />
      )}

      {/* One row of chrome over the document: who this is, what has been
          measured about it, and what you can do to it. Tailoring is a thing you
          DO to the CV on screen, not a stage you pass through. */}
      <DocumentToolbar
        title={docTitle}
        badges={
          <>
            {resume && masterLabel && (
              <span className="inline-flex items-center gap-1 text-xs text-mint">
                <BadgeCheck size={13} aria-hidden /> {masterLabel}
              </span>
            )}
            {/* MEASURED, deterministic, uncapped and free — which is the whole
                reason it can sit on a toolbar at all. It also answers the
                question at the moment it can still be acted on: the count used
                to appear only inside the review panel, so you learned your CV
                was three pages after paying to tailor it. `!result` because
                ChangeLog mounts the same badge while a result is up, and two
                mounts would double every server render. */}
            {!result && <PageBadge resume={shown} template={template} />}
            {/* The other live, deterministic number, in ScoreCard's own words
                rather than a second phrasing — the toolbar and the score card
                must not be able to describe one measurement two ways, which is
                exactly what PageBadge was extracted to prevent. A COUNT, never
                a band and never `overall`: half of that blend is stale by
                construction and it is off this surface on purpose. */}
            {coverage.data && (
              <span
                title={t("fit.coverage")}
                className={cn(
                  "inline-flex items-center gap-1 text-xs tabular-nums text-ink-muted transition-opacity",
                  coverage.stale && "opacity-50",
                )}
              >
                <Target size={12} aria-hidden />
                {t("fit.coverageSub", {
                  covered: coverage.data.covered,
                  total: coverage.data.total,
                  partial: coverage.data.partial,
                })}
              </span>
            )}
          </>
        }
        actions={
          <>
            {/* MASTER only, and it must stay that way. Its `edit.hint` says
                "your résumé", and its Save writes `state.resume` — a different
                document from the one on screen while a result is up. */}
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
            {/* THE EXIT FROM REVIEW MODE, and until 23.7 there was none:
                `editable` is `!result`, so a tailor result made the document
                non-editable AND took the Replace tool with it, and nothing on
                this page ever set `result` back to null. Tailoring once locked
                /app into review for the rest of the session, short of a full
                reload — which is also why "just hide Tailor while a result is
                up" was the wrong answer to the confusing affordance. */}
            {/* ARMED ONLY WHEN THERE IS SOMETHING TO LOSE. With no hand-edits
                this discards a memo and one tap is right; with hand-edits it
                deletes every sentence the user typed on this CV, with no undo
                and no mirror anywhere — and it sits directly beside "Tailor for
                a different job", which destroys the same map. Two adjacent
                one-tap buttons that both silently delete the user's own writing
                is the shape this splits up. The consequence is stated AT REST in
                the notes row below (23.5's rule: what an irreversible action
                admits to may not be held back until it is armed), never in a
                `title` — a tooltip does not exist on the phone this is used
                on. */}
            {result && overrideCount > 0 && discardArmed ? (
              <>
                <Button
                  variant="danger"
                  icon={<ArrowLeft size={16} className="rtl:-scale-x-100" />}
                  onClick={() => {
                    setDiscardArmed(false);
                    discardTailorResult();
                  }}
                >
                  {t("discard.confirm", { count: overrideCount })}
                </Button>
                <Button variant="secondary" onClick={() => setDiscardArmed(false)}>
                  {t("discard.keep")}
                </Button>
              </>
            ) : (
              result && (
                <Button
                  variant="ghost"
                  icon={<ArrowLeft size={16} className="rtl:-scale-x-100" />}
                  onClick={() => (overrideCount > 0 ? setDiscardArmed(true) : discardTailorResult())}
                  // Only on the harmless branch, and only because it is a
                  // DESCRIPTION there rather than a warning.
                  title={overrideCount > 0 ? undefined : t("discard.title")}
                >
                  {t("discard.cta")}
                </Button>
              )
            )}
            <Button
              // With a result up the loudest control on the page belongs to
              // review + download below, not to starting over. Same button,
              // demoted — a re-aim is a secondary action here.
              variant={result ? "secondary" : "primary"}
              loading={loading}
              icon={<Wand2 size={17} />}
              disabled={!canRun}
              title={!resume ? t("run.uploadFirst") : undefined}
              onClick={() => setTailorState({ overlayOpen: true })}
            >
              {result ? (
                // No sm/lg split here: there is no title to interpolate, so the
                // one label fits a 390px row beside the ghost exit above.
                // Naming the job ALREADY tailored for is what read as "tailor
                // the tailored one again" — the complaint this replaces.
                t("overlay.openDifferent")
              ) : (
                <>
                  {/* The job title earns its place on a wide screen and costs a
                      whole extra row on a 390px one, where the target card above
                      already names the job. */}
                  <span className="sm:hidden">{t("overlay.open")}</span>
                  <span className="hidden sm:inline">
                    {jd?.job_title ? t("overlay.openFor", { title: jd.job_title }) : t("overlay.open")}
                  </span>
                </>
              )}
            </Button>
          </>
        }
        notes={
          loading || error || edits.length > 0 || result ? (
            <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {loading && <span className="text-xs text-ink-muted">{t("run.keepsRunning")}</span>}
              {error && <span className="text-sm text-danger">{error}</span>}
              {edits.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    document.getElementById("trust-panel")?.scrollIntoView({ behavior: smooth(), block: "start" })
                  }
                  className="text-xs font-medium text-accent-soft hover:underline"
                >
                  {t("toolbar.review", { count: edits.length })}
                </button>
              )}
              {/* The tailored document is typed on and nothing said so. It
                  cannot ride ResumeEditBar's `edit.hint`: that bar stays
                  master-only, and its "your résumé" plus a Save button would
                  both be about a different document from the one on screen. */}
              {result && <span className="text-xs text-ink-muted">{t("edit.tailoredHint")}</span>}
              {result && overrideCount > 0 && (
                <>
                  {/* The count IS the reveal. It was a plain span, and a number
                      whose members cannot be found is worse than no number: an
                      override that DELETED a block has nothing to mark on the
                      paper and no review row to sit in, so "3 edits of your own"
                      could stand beside one mint bar and one badge with the only
                      recovery being "Clear my edits" — which reverts all three. */}
                  <button
                    type="button"
                    aria-expanded={yoursOpen}
                    onClick={() => setYoursOpen((o) => !o)}
                    className="text-xs font-medium text-mint hover:underline"
                  >
                    {t("edit.yours", { count: overrideCount })}
                  </button>
                  <button
                    type="button"
                    onClick={clearAllBlockOverrides}
                    className="text-xs font-medium text-accent-soft hover:underline"
                  >
                    {t("edit.yoursClear")}
                  </button>
                  {/* THE CONSEQUENCE, AT REST. It says what leaving this review
                      costs before the button beside it is touched, which is the
                      order 23.5 settled for the danger zone: "read what it
                      admits to once armed" is the wrong order for something
                      irreversible. It turns danger-coloured once armed, so
                      arming still changes something visible. */}
                  <span
                    className={cn(
                      "basis-full text-xs leading-relaxed sm:basis-auto",
                      discardArmed ? "text-danger" : "text-ink-muted",
                    )}
                  >
                    {t("discard.edited", { count: overrideCount })}
                  </span>
                </>
              )}
              {/* The one-step undo for "Clear my edits", and it is deliberately
                  OUTSIDE the block above: clearing takes `overrideCount` to zero
                  and that block with it, so an offer rendered inside would
                  vanish in the same frame as the thing it undoes. Restoring
                  MERGES, so anything typed since the clear survives it. */}
              {result && clearedCount > 0 && (
                <button
                  type="button"
                  onClick={restoreClearedOverrides}
                  className="text-xs font-medium text-mint hover:underline"
                >
                  {t("edit.yoursRestoreCleared", { count: clearedCount })}
                </button>
              )}
            </div>
            {/* A conditional render with `animate-fade-up`, never a height tween:
                this bar re-renders on every keystroke and every coverage
                response, and an element mid-tween is left frozen at its
                interpolated px with `overflow-hidden` clipping it (check 11,
                seven shipped instances). Capped and scrollable because it sits
                inside a sticky bar — a long list would push the document off the
                screen it is stuck to. */}
            {result && yoursOpen && overrideCount > 0 && (
              <div className="animate-fade-up mt-2 max-h-40 overflow-y-auto rounded-lg border border-line bg-panel-2/60 p-2">
                <ul className="space-y-1">
                  {myEdits.map((e) => (
                    <li key={e.anchor} className="space-y-0.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <span dir="auto" className="min-w-0 flex-1 truncate text-ink-muted">
                        {e.text || "—"}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 font-medium",
                          e.state === "removed"
                            ? "text-warn"
                            : e.state === "hidden"
                              ? "text-ink-faint"
                              : "text-mint",
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
                    {/* WHAT THE BUTTON ABOVE WILL PUT BACK. Read off the
                        pre-override merge through the row's own anchor, so it is
                        the block's real previous wording rather than a guess —
                        and without it the undo replaces the text on this line
                        with something that appears nowhere on the page. Its own
                        line, not a fourth item in the flex row: at 390px in
                        Hebrew that row already wraps. */}
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
            </>
          ) : undefined
        }
      />

      {/* The document, or — with no résumé yet — the one thing there is to do. */}
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
          activeBlock={spot?.path ?? null}
          activeNonce={spot?.nonce}
          onSelectBlock={selectBlock}
          // The paper is typed on in both modes; `commitInline` is what routes
          // a tailored edit into the override layer instead of the master.
          onEditBlock={canEditDoc ? setEditPath : undefined}
          onInlineCommit={canEditDoc ? commitInline : undefined}
          // ADDING stays master-only, and the reason is the fabrication guard,
          // not caution. It ran against `result.tailored_resume`; a claim typed
          // in afterwards carries no verdict at all, while ScoreCard below goes
          // on rendering `result.fabrication_flags` as though it described the
          // document on screen. An added block also exists in neither the
          // original nor the tailored résumé, so it has no source anchor to be
          // stored against. Adds belong in their own change, with their own
          // guard story.
          onAddSkill={isMaster ? addSkill : undefined}
          onAdd={isMaster ? addToResume : undefined}
          onAddBullet={isMaster ? addBullet : undefined}
          // In the add control's own place, so its absence is answered where
          // the question gets asked rather than in a toolbar three scrolls up.
          footNote={result ? t("edit.tailoredNoAdd") : undefined}
          // Master only: replacing the file under a tailor review would be
          // replacing the thing being reviewed. `onParsed` is the SAME handler
          // the empty state uses, so the cold start and the replacement are one
          // path.
          onReplace={isMaster ? onParsed : undefined}
        />
      ) : (
        <Card>
          <CardTitle>{t("upload.title")}</CardTitle>
          <div className="mt-3">
            <ResumeUpload onParsed={onParsed} />
          </div>
          {/* The cold start, and it is now the SAME surface as everything else:
              a blank page you type on. This replaced /builder — an 848-line
              wizard that was a second editor for one résumé, and produced the
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

      {/* The two numbers, as soon as either exists — a fit check produces one
          before any tailoring. */}
      {(fit || result) && shown && (
        <ScoreCard
          coverage={coverage.data}
          coverageStale={coverage.stale}
          fitScore={result ? result.score_after.fit_score : (fit?.fit_score ?? null)}
          rationale={result ? result.score_after.rationale : fit?.rationale}
          // THE STAMP THAT BELONGS TO THE NUMBER ABOVE IT, picked by the same
          // condition and on the same line as the number, so the two cannot
          // drift. One field served both readings until 23.8: the tailor's
          // success branch re-stamped it, so after "Back to my résumé" the tile
          // paired the PRE-tailor fit reading with the TAILOR's clock — and the
          // timestamp is the entire honesty mechanism of that tile, which
          // deliberately shows one reading with no before/after and no delta.
          scoredAt={result ? scoredAt : fitScoredAt}
          flags={result?.fabrication_flags ?? []}
          // The guard ran on the AI's rewrite; the document beside this tile —
          // and in the PDF preview, the x-ray, both downloads and the tracker row
          // — is `effectiveResume`, with the user's own sentences over it. The
          // count is how the tile says which of the two it is describing.
          overrideCount={overrideCount}
        />
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
            className="space-y-6"
          >
            <VoicePanel
              report={result.voice_report}
              plan={result.plan}
            />
            <MatchReport gaps={result.score_after.gaps} jdText={jdText} />

            <ChangeLog
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

            <Card>
              <CardTitle>{t("download.title")}</CardTitle>
              {/* The picker moved to the document's own tool rail (PLAN 6:
                  every option is ATS-safe by construction — no tables, text
                  boxes or images in any of them). It was locked in here, which
                  meant the design could only be chosen after a tailor had been
                  paid for and never governed the master document at all. The
                  note under the buttons still says what the .docx does. */}
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  icon={<Download size={16} />}
                  onClick={() =>
                    downloadResume(
                      effectiveResume,
                      "docx",
                      resumeFilename(effectiveResume.contact.name, jd?.company ?? ""),
                      template,
                    )
                  }
                >
                  {t("download.docx")}
                </Button>
                <Button
                  variant="secondary"
                  icon={<Download size={16} />}
                  onClick={() =>
                    downloadResume(
                      effectiveResume,
                      "pdf",
                      resumeFilename(effectiveResume.contact.name, jd?.company ?? ""),
                      template,
                    )
                  }
                >
                  {t("download.pdf")}
                </Button>
                <div className="flex-1" />
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
                {applied && <Badge tone="mint">{t("target.appliedBadge")}</Badge>}
                <Button variant="ghost" icon={<Save size={16} />} disabled={saved} onClick={save}>
                  {saved ? t("save.saved") : t("save.cta")}
                </Button>
              </div>
              {appliedPrompt}
              {/* A two-column pick can't ship as .docx, so the ATS line is
                  replaced (not stacked) by the plain-language fallback note —
                  "single-column" would otherwise be false for its PDF. */}
              <p className="mt-3 text-xs text-ink-muted">
                {isPdfOnlyTemplate(template)
                  ? t("download.docxFallback", { name: t(`download.templates.${template}.name`) })
                  : t("download.atsNote")}
              </p>
              {/* The honest half of shipping two-column designs: don't just warn
                  that a parser might interleave them — let the user SEE what one
                  actually reads back from this exact file. It used to navigate to
                  /tools/xray, which meant leaving the review to check the review;
                  now it opens the ATS view in place, on the résumé as it stands
                  right now rather than on the saved master. */}
              <button
                type="button"
                onClick={() => {
                  setDocView("ats");
                  requestAnimationFrame(() =>
                    docRef.current?.scrollIntoView({ block: "start", behavior: smooth() }),
                  );
                }}
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-accent-soft underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                <ScanEye size={13} />
                {t("download.xrayLink")}
              </button>
            </Card>

            <CoverLetter
              resume={effectiveResume}
              jd={jd}
              onGenerated={(letter) => setTailorState({ coverLetterText: letter, saved: false })}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {shown && (
        <BlockEditSheet
          path={editPath}
          resume={shown}
          paperDir={paperDir}
          onClose={closeEditSheet}
          // Exactly one of these two ever fires. With a result up the sheet
          // hands back raw VALUES and they become an override; without one it
          // hands back a résumé and that résumé becomes the master.
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
          // The overlay's Tailor button destroys these, so it is the overlay
          // that has to arm-then-confirm and to name the count in its own
          // "this starts again from your master résumé" note.
          overrideCount={overrideCount}
          onChecked={(text, f) =>
            // `fitScoredAt`, never `scoredAt`: this stamp belongs to THIS
            // reading. `scoredAt` is the tailor's, written by `startTailor`'s
            // success branch beside `result.score_after`.
            setTailorState({ jdText: text, jd: f.jd, fit: f, checkedFor: text, fitScoredAt: Date.now() })
          }
          onTailor={(text) => {
            // The Jobs-page handoff (`setTargetJob`) sets jobUrl/jobTitle/company
            // alongside jdText. Tailoring for a DIFFERENT posting must not leave
            // the breadcrumb, the target card and `save()`'s `job_url` naming the
            // old one. This is the ONE place the rule inverts `adoptMaster`'s
            // ("the target job survives — which posting you are aiming at has
            // nothing to do with which file your résumé is in"): here the posting
            // is precisely what changed.
            //
            // Trimmed on BOTH sides: `setTargetJob` stores the JD untrimmed and
            // the overlay hands back `draft.trim()`, so a bare comparison would
            // wipe a correct target on a trailing newline — a guard firing on
            // legitimate input.
            const changed = text !== jdText.trim();
            setTailorState(
              changed
                ? {
                    jdText: text,
                    overlayOpen: false,
                    jobUrl: undefined,
                    jobTitle: undefined,
                    company: undefined,
                  }
                : { jdText: text, overlayOpen: false },
            );
            startTailor();
          }}
        />
      )}
    </div>
  );
}
