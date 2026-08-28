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
import { useSaveMasterResume } from "../hooks/useSaveMasterResume";
import { blocksByEdit, mergeForReview } from "../lib/resumeDiff";
import {
  inlineField,
  insertBlock,
  insertBullet,
  insertSkill,
  readBlock,
  removeBlock,
  writeBlock,
  type InsertKind,
} from "../lib/resumeBlocks";
import { resumeLanguage } from "../lib/lang";
import { clearDraft, draftOver, offerDraft, readDraft, type ResumeDraft } from "../lib/draft";
import { classifyEdit } from "../lib/editGroups";
import { cn } from "../lib/cn";
import { Badge, Button, Card, CardTitle, Skeleton, useToast } from "../components/ui";
import {
  applyBlockEdit,
  getTailorState,
  setTailorState,
  setTargetJob,
  startTailor,
  subscribeTailor,
} from "../state/tailorStore";
import type { FactsLedger, ResumeModel } from "../types";

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
   * `writeBlock` stays the only writer and `applyBlockEdit` the only way in, so
   * the undo stack and the 22.11 local draft keep working untouched.
   */
  function commitInline(path: string, text: string) {
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
   */
  function closeEditSheet() {
    const path = editPath;
    setEditPath(null);
    if (!path || path !== freshEntry) return;
    setFreshEntry(null);
    const base = getTailorState().resume;
    const draft = base ? readBlock(base, path) : null;
    if (!draft || draft.fields.some((f) => f.value.trim())) return;
    const res = removeBlock(base!, path);
    if (res.ok) applyBlockEdit(res.resume);
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
  const merged = useMemo(
    () => (result && original ? mergeForReview(original, result.tailored_resume, rejectedSet) : null),
    [original, result, rejectedSet],
  );
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
   * declined, the user's original. The second is the one worth seeing. */
  const marks = useMemo(() => {
    const m = new Map<string, "changed" | "restored">();
    if (merged) {
      for (const [path, ids] of Object.entries(merged.blocks)) {
        m.set(path, ids.every((id) => rejectedSet.has(id)) ? "restored" : "changed");
      }
    }
    return m;
  }, [merged, rejectedSet]);

  // The document ↔ review jump. `spot` is the block lit up right now; `focusEdit`
  // carries a nonce so clicking the same block twice re-fires the effect.
  const docRef = useRef<HTMLDivElement>(null);
  const [docView, setDocView] = useState<DocView>("screen");
  const [editPath, setEditPath] = useState<string | null>(null);
  // The entry THIS session just added, so an abandoned add can be undone and a
  // pre-existing blank entry cannot be deleted by accident.
  const [freshEntry, setFreshEntry] = useState<string | null>(null);
  // The document is EDITABLE only when it is your master. With a tailor result
  // up, `shown` is a memo recomputed and thrown away on every accept/decline,
  // so writing into it would need an override layer that survives the re-merge
  // — and the decision was that tailoring is a review layer that never writes
  // back to the master. So: master => edit, tailored => review.
  const editable = !result && !!resume;
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
    setTailorState({ resume: r, savedResume: r, ledger: l, result: null, tailoredFrom: null, rejectedEdits: [], saved: false, langSwitched: null, editUndo: [], editError: "" });
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
      fabrication_flag_count: result?.fabrication_flags.length,
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

      {/* Gated on `editable` for the same reason onEditBlock is: with a tailor
          result up the document is a memo recomputed on every accept/decline,
          so restoring into it would be written over on the next click. */}
      {draft && editable && (
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
            {editable && shown && (
              <ResumeEditBar
                resume={shown}
                savedResume={savedResume}
                masterLabel={masterLabel}
                unsaved={editUndo.length}
                saving={editSaving}
                error={editError}
              />
            )}
            <Button
              loading={loading}
              icon={<Wand2 size={17} />}
              disabled={!canRun}
              title={!resume ? t("run.uploadFirst") : undefined}
              onClick={() => setTailorState({ overlayOpen: true })}
            >
              {/* The job title earns its place on a wide screen and costs a
                  whole extra row on a 390px one, where the target card above
                  already names the job. */}
              <span className="sm:hidden">{t("overlay.open")}</span>
              <span className="hidden sm:inline">
                {jd?.job_title ? t("overlay.openFor", { title: jd.job_title }) : t("overlay.open")}
              </span>
            </Button>
          </>
        }
        notes={
          loading || error || edits.length > 0 ? (
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
            </div>
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
          onEditBlock={editable ? setEditPath : undefined}
          onInlineCommit={editable ? commitInline : undefined}
          onAddSkill={editable ? addSkill : undefined}
          onAdd={editable ? addToResume : undefined}
          onAddBullet={editable ? addBullet : undefined}
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
          scoredAt={scoredAt}
          flags={result?.fabrication_flags ?? []}
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
              credibility={result.credibility_flags ?? []}
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

      {editable && shown && (
        <BlockEditSheet
          path={editPath}
          resume={shown}
          paperDir={paperDir}
          onClose={closeEditSheet}
          onApply={(next, path) => {
            applyBlockEdit(next);
            setFreshEntry(null); // it has content now; it is a normal entry
            setEditPath(null);
            if (path) markSpot(path);
          }}
          onGone={() => {
            setEditPath(null);
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
          onChecked={(text, f) =>
            setTailorState({ jdText: text, jd: f.jd, fit: f, checkedFor: text, scoredAt: Date.now() })
          }
          onTailor={(text) => {
            setTailorState({ jdText: text, overlayOpen: false });
            startTailor();
          }}
        />
      )}
    </div>
  );
}
