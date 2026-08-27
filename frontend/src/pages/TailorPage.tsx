import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import { Wand2, Download, Save, BadgeCheck, Briefcase, ExternalLink, ArrowLeft, ScanEye } from "lucide-react";
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
import TemplatePicker, { isPdfOnlyTemplate } from "../components/TemplatePicker";
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
import { useSaveMasterResume } from "../hooks/useSaveMasterResume";
import { blocksByEdit, mergeForReview } from "../lib/resumeDiff";
import { resumeLanguage } from "../lib/lang";
import { classifyEdit } from "../lib/editGroups";
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
        }
      } catch {
        /* no saved résumé yet */
      }
    })();
  }, []);

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
  // The document is EDITABLE only when it is your master. With a tailor result
  // up, `shown` is a memo recomputed and thrown away on every accept/decline,
  // so writing into it would need an override layer that survives the re-merge
  // — and the decision was that tailoring is a review layer that never writes
  // back to the master. So: master => edit, tailored => review.
  const editable = !result && !!resume;
  // The paper's own direction, frozen from the résumé rather than the UI: the
  // chrome follows the locale, the document follows its own language.
  const paperDir = shown && resumeLanguage(shown) === "he" ? ("rtl" as const) : ("ltr" as const);
  const [spot, setSpot] = useState<string | null>(null);
  const [focusEdit, setFocusEdit] = useState<{ id: string; nonce: number } | null>(null);

  useEffect(() => {
    if (!spot) return;
    const timer = setTimeout(() => setSpot(null), 2200);
    return () => clearTimeout(timer);
  }, [spot]);

  const smooth = () =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? ("auto" as const)
      : ("smooth" as const);

  /** Review row → document. */
  function showInDoc(id: string) {
    const path = editBlock[id];
    if (!path) return; // an accepted removal is not on the page — nothing to point at
    // The file and ATS views hide the screen document, and scrollIntoView on a
    // display:none node is a silent no-op — so select it before scrolling.
    setDocView("screen");
    setSpot(path);
    requestAnimationFrame(() => {
      docRef.current
        ?.querySelector<HTMLElement>(`[data-block="${CSS.escape(path)}"]`)
        // `center`, not `start`: styles.css sets a global scroll-padding-top for
        // the marketing header, and a small target reads better centred anyway.
        ?.scrollIntoView({ block: "center", behavior: smooth() });
    });
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
    if (m) setTailorState({ masterLabel: m.label });
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
    <AnimatePresence initial={false}>
      {applyClicked && !applied && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="overflow-hidden"
        >
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-soft px-3 py-2">
            <span className="text-sm text-ink">{t("applyPrompt.question")}</span>
            <Button size="sm" onClick={markApplied}>
              {t("applyPrompt.yes")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setTailorState({ applyClicked: false })}>
              {t("applyPrompt.notYet")}
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className="space-y-6">
      <div>
        {(jobTitle || company) && (
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
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
        <h1 className="text-2xl font-bold text-ink">{t("title")}</h1>
        <p className="mt-1 hidden text-sm text-ink-muted sm:block">{t("sub")}</p>
      </div>

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

      {/* One row of actions over the document. Tailoring is a thing you DO to
          the CV on screen, not a stage you pass through. */}
      <Card className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {resume && masterLabel && (
          <span className="inline-flex items-center gap-1 text-xs text-mint">
            <BadgeCheck size={13} /> {masterLabel}
          </span>
        )}
        {loading && <span className="text-sm text-ink-muted">{t("run.keepsRunning")}</span>}
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
        <Button
          className="ms-auto"
          loading={loading}
          icon={<Wand2 size={17} />}
          disabled={!canRun}
          title={!resume ? t("run.uploadFirst") : undefined}
          onClick={() => setTailorState({ overlayOpen: true })}
        >
          {jd?.job_title ? t("overlay.openFor", { title: jd.job_title }) : t("overlay.open")}
        </Button>
      </Card>

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

      {/* The document, or — with no résumé yet — the one thing there is to do. */}
      {shown ? (
        <DocumentPanel
          ref={docRef}
          resume={shown}
          template={template}
          view={docView}
          onView={setDocView}
          company={jd?.company ?? company}
          marks={marks}
          activeBlock={spot}
          onSelectBlock={selectBlock}
          onEditBlock={editable ? setEditPath : undefined}
        />
      ) : (
        <Card>
          <CardTitle>{t("upload.title")}</CardTitle>
          <div className="mt-3">
            <ResumeUpload onParsed={onParsed} />
          </div>
          {/* PLAN 15.3: cold-start path — no file to upload yet. */}
          <Link to="/builder" className="mt-3 inline-block text-sm text-accent-soft hover:underline">
            {t("upload.buildLink")}
          </Link>
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
              {/* Template picker (PLAN 6): every option is ATS-safe by
                  construction — no tables, text boxes or images in any of them.
                  The two-column designs are PDF-only; TemplatePicker badges
                  them and the note under the buttons says what the .docx does. */}
              <TemplatePicker
                className="mt-2"
                value={template}
                onChange={setTemplate}
                label={t("download.templateLabel")}
              />
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
          onClose={() => setEditPath(null)}
          onApply={(next, path) => {
            applyBlockEdit(next);
            setEditPath(null);
            if (path) setSpot(path);
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
