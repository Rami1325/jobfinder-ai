import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Wand2, Download, Save, BadgeCheck, Briefcase, ExternalLink, ArrowLeft } from "lucide-react";
import {
  downloadResume,
  resumeFilename,
  getMasterResume,
  saveApplication,
  updateApplication,
} from "../api/client";
import ChangeLog from "../components/ChangeLog";
import CoverLetter from "../components/CoverLetter";
import GapList from "../components/GapList";
import JDPaste from "../components/JDPaste";
import ResumeUpload from "../components/ResumeUpload";
import ScoreCard from "../components/ScoreCard";
import { useSaveMasterResume } from "../hooks/useSaveMasterResume";
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
    loading,
    error,
    saved,
    savedAppId,
    applyClicked,
    applied,
    coverLetterText,
    jobUrl,
    jobTitle,
    company,
  } = useSyncExternalStore(subscribeTailor, getTailorState);
  const toast = useToast();
  const persistMaster = useSaveMasterResume();

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

  async function onParsed(r: ResumeModel, l: FactsLedger) {
    setTailorState({ resume: r, ledger: l, result: null, saved: false });
    const m = await persistMaster(r, l); // best-effort — null when the backend is unreachable
    if (m) setTailorState({ masterLabel: m.label });
  }

  async function save() {
    if (!result || !jd) return;
    if (savedAppId !== null) {
      // Already created (by Save or "Yes, applied") — never double-create.
      setTailorState({ saved: true });
      toast("success", "Already in your tracker");
      return;
    }
    const app = await saveApplication({
      job_title: jd.job_title,
      company: jd.company,
      jd_text: jdText,
      tailored_resume: result.tailored_resume,
      cover_letter: coverLetterText,
      overall_score: result.score_after.overall,
      job_url: jobUrl || undefined,
    });
    setTailorState({ savedAppId: app.id, saved: true });
    toast("success", "Saved to tracker");
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
          tailored_resume: result?.tailored_resume as ResumeModel,
          cover_letter: coverLetterText,
          overall_score: result?.score_after.overall ?? 0,
          status: "applied",
          job_url: jobUrl,
        });
        setTailorState({ savedAppId: app.id, saved: true, applied: true });
      }
      toast("success", "Marked as applied — added to tracker");
    } catch {
      toast("error", "Could not update the tracker. Is the backend running?");
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
            <span className="text-sm text-ink">Did you apply to this job?</span>
            <Button size="sm" onClick={markApplied}>
              Yes, applied
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setTailorState({ applyClicked: false })}>
              Not yet
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
              <ArrowLeft size={14} /> Back to jobs
            </Link>
            <span className="text-ink-faint">·</span>
            <span className="min-w-0 truncate text-ink-muted">
              Tailoring for: <span className="font-medium text-ink">{jobTitle || "this job"}</span>
              {company && (
                <>
                  {" "}at <span className="font-medium text-ink">{company}</span>
                </>
              )}
            </span>
          </div>
        )}
        <h1 className="text-2xl font-bold text-ink">Tailor your résumé</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Rewrite for a specific job — verified against your real experience.
        </p>
      </div>

      <Card>
        <Stepper steps={["Résumé", "Job description", "Results"]} current={step} />
      </Card>

      {jobUrl && (
        <Card className="border-accent/40">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Briefcase size={16} className="shrink-0 text-accent-soft" />
            <p className="min-w-0 truncate text-sm font-semibold text-ink">
              Target job: {jobTitle || "Job posting"}
              {company ? ` · ${company}` : ""}
            </p>
            <a
              href={jobUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() => setTailorState({ applyClicked: true })}
              className="inline-flex items-center gap-1 text-sm text-accent-soft hover:underline"
            >
              Open job posting <ExternalLink size={13} />
            </a>
            {applied && <Badge tone="mint">✓ Applied</Badge>}
          </div>
          {!result && appliedPrompt}
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>1 · Your résumé</CardTitle>
            {masterLabel && resume && (
              <span className="inline-flex items-center gap-1 text-xs text-mint">
                <BadgeCheck size={13} /> {masterLabel}
              </span>
            )}
          </div>
          <div className="mt-3">
            <ResumeUpload onParsed={onParsed} savedLabel={resume ? masterLabel || undefined : undefined} />
          </div>
        </Card>

        <Card>
          <CardTitle>2 · Target job description</CardTitle>
          <p className="mt-1 text-sm text-ink-muted">Paste the full posting from any job site.</p>
          <div className="mt-3">
            <JDPaste value={jdText} onChange={(v) => setTailorState({ jdText: v })} />
          </div>
        </Card>
      </div>

      <Card className="flex flex-wrap items-center gap-3">
        <Button size="lg" loading={loading} icon={<Wand2 size={18} />} disabled={!canRun} onClick={startTailor}>
          {loading ? "Tailoring…" : "Tailor my résumé"}
        </Button>
        {!resume && <span className="text-sm text-ink-muted">Upload a résumé to begin.</span>}
        {resume && jdText.trim().length <= 30 && (
          <span className="text-sm text-ink-muted">Paste a job description.</span>
        )}
        {loading && (
          <span className="text-sm text-ink-muted">
            Keeps running if you switch tabs — come back anytime.
          </span>
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
        {result && jd && !loading && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="space-y-6"
          >
            <ScoreCard before={result.score_before} after={result.score_after} />
            <GapList gaps={result.score_after.gaps} />
            <ChangeLog changelog={result.changelog} flags={result.fabrication_flags} />

            <Card>
              <CardTitle>Download tailored résumé</CardTitle>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  icon={<Download size={16} />}
                  onClick={() =>
                    downloadResume(
                      result.tailored_resume,
                      "docx",
                      resumeFilename(result.tailored_resume.contact.name, jd?.company ?? ""),
                    )
                  }
                >
                  Download .docx
                </Button>
                <Button
                  variant="secondary"
                  icon={<Download size={16} />}
                  onClick={() =>
                    downloadResume(
                      result.tailored_resume,
                      "pdf",
                      resumeFilename(result.tailored_resume.contact.name, jd?.company ?? ""),
                    )
                  }
                >
                  Download .pdf
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
                    <ExternalLink size={14} /> Open job posting
                  </a>
                )}
                {applied && <Badge tone="mint">✓ Applied</Badge>}
                <Button variant="ghost" icon={<Save size={16} />} disabled={saved} onClick={save}>
                  {saved ? "✓ Saved to tracker" : "Save to tracker"}
                </Button>
              </div>
              {appliedPrompt}
              <p className="mt-3 text-xs text-ink-muted">
                Output is single-column, ATS-safe (no tables, columns, or images).
              </p>
            </Card>

            <CoverLetter
              resume={result.tailored_resume}
              jd={jd}
              onGenerated={(t) => setTailorState({ coverLetterText: t, saved: false })}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
