import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
import CoverLetter from "../components/CoverLetter";
import MatchReport from "../components/MatchReport";
import JDPaste from "../components/JDPaste";
import ResumeUpload from "../components/ResumeUpload";
import ScoreCard from "../components/ScoreCard";
import VoicePanel from "../components/VoicePanel";
import { useSaveMasterResume } from "../hooks/useSaveMasterResume";
import { applyEditDecisions, diffResumes } from "../lib/resumeDiff";
import { Badge, Button, Card, CardTitle, Skeleton, Stepper, useToast } from "../components/ui";
import {
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
          setTailorState({ resume: m.resume, ledger: m.ledger ?? null, masterLabel: m.label });
        }
      } catch {
        /* no saved résumé yet */
      }
    })();
  }, []);

  const step = !resume ? 0 : !result ? 1 : 2;
  const canRun = !!resume && jdText.trim().length > 30 && !loading;

  // Per-bullet accept/reject: diff the tailored résumé against the one it was
  // tailored from, and build the effective résumé the user actually ships.
  const original = tailoredFrom ?? resume;
  const edits = useMemo(
    () => (result && original ? diffResumes(original, result.tailored_resume) : []),
    [original, result],
  );
  const rejectedSet = useMemo(() => new Set(rejectedEdits), [rejectedEdits]);
  const effectiveResume = useMemo(() => {
    if (!result) return null;
    if (!original || rejectedSet.size === 0) return result.tailored_resume;
    return applyEditDecisions(original, result.tailored_resume, rejectedSet);
  }, [original, result, rejectedSet]);

  async function onParsed(r: ResumeModel, l: FactsLedger) {
    setTailorState({ resume: r, ledger: l, result: null, tailoredFrom: null, rejectedEdits: [], saved: false, langSwitched: null });
    const m = await persistMaster(r, l); // best-effort — null when the backend is unreachable
    if (m) setTailorState({ masterLabel: m.label });
  }

  // Feedback loop (§26): the AI wording the user rejected becomes a stored
  // negative signal — future tailors receive it as an avoid-list. Fired on
  // save/apply (the moment the review decisions are final), best-effort.
  function persistRejectedPhrases() {
    const phrases = edits
      .filter((e) => rejectedSet.has(e.id) && e.after.trim() !== "")
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

      <Card>
        <Stepper steps={[t("steps.resume"), t("steps.jd"), t("steps.results")]} current={step} />
      </Card>

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

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>{t("upload.title")}</CardTitle>
            {masterLabel && resume && (
              <span className="inline-flex items-center gap-1 text-xs text-mint">
                <BadgeCheck size={13} /> {masterLabel}
              </span>
            )}
          </div>
          <div className="mt-3">
            <ResumeUpload onParsed={onParsed} savedLabel={resume ? masterLabel || undefined : undefined} />
          </div>
          {/* PLAN 15.3: cold-start path — no file to upload yet. */}
          {!resume && (
            <Link to="/builder" className="mt-3 inline-block text-sm text-accent-soft hover:underline">
              {t("upload.buildLink")}
            </Link>
          )}
        </Card>

        <Card>
          <CardTitle>{t("jd.title")}</CardTitle>
          <p className="mt-1 hidden text-sm text-ink-muted sm:block">{t("jd.hint")}</p>
          <div className="mt-3">
            <JDPaste value={jdText} onChange={(v) => setTailorState({ jdText: v })} />
          </div>
        </Card>
      </div>

      <Card className="flex flex-wrap items-center gap-3">
        <Button size="lg" loading={loading} icon={<Wand2 size={18} />} disabled={!canRun} onClick={startTailor}>
          {loading ? t("run.loading") : t("run.cta")}
        </Button>
        {!resume && <span className="text-sm text-ink-muted">{t("run.uploadFirst")}</span>}
        {resume && jdText.trim().length <= 30 && (
          <span className="text-sm text-ink-muted">{t("run.pasteJd")}</span>
        )}
        {loading && (
          <span className="text-sm text-ink-muted">{t("run.keepsRunning")}</span>
        )}
        {error && <span className="text-sm text-danger">{error}</span>}
      </Card>

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
            {langSwitched && (
              <div className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink">
                <BadgeCheck size={15} className="shrink-0 text-accent-soft" />
                <span className="min-w-0">
                  {t(`langSwitch.${langSwitched}`, { label: masterLabel || t("langSwitch.fallbackLabel") })}
                </span>
              </div>
            )}
            <ScoreCard before={result.score_before} after={result.score_after} flags={result.fabrication_flags} />
            <VoicePanel
              report={result.voice_report}
              plan={result.plan}
              credibility={result.credibility_flags ?? []}
            />
            <MatchReport gaps={result.score_after.gaps} jdText={jdText} resume={effectiveResume} />
            <ChangeLog
              edits={edits}
              changelog={result.changelog}
              flags={result.fabrication_flags}
              jdKeywords={result.score_after.gaps.map((g) => g.keyword)}
              rejected={rejectedSet}
              onSetRejected={(ids) => setTailorState({ rejectedEdits: ids })}
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
                  that a parser might interleave them — let the user go and SEE
                  what one actually reads back from this exact file. */}
              <Link
                to="/tools/xray"
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-accent-soft underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                <ScanEye size={13} />
                {t("download.xrayLink")}
              </Link>
            </Card>

            <CoverLetter
              resume={effectiveResume}
              jd={jd}
              onGenerated={(letter) => setTailorState({ coverLetterText: letter, saved: false })}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
