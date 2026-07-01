import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Wand2, Download, Save, BadgeCheck } from "lucide-react";
import {
  analyzeJD,
  downloadResume,
  getMasterResume,
  saveApplication,
  saveMasterResume,
  tailor,
} from "../api/client";
import ChangeLog from "../components/ChangeLog";
import CoverLetter from "../components/CoverLetter";
import GapList from "../components/GapList";
import JDPaste from "../components/JDPaste";
import ResumeUpload from "../components/ResumeUpload";
import ScoreCard from "../components/ScoreCard";
import { Button, Card, CardTitle, Skeleton, Stepper, useToast } from "../components/ui";
import type { FactsLedger, JDModel, ResumeModel, TailorResult } from "../types";

export default function TailorPage() {
  const loc = useLocation() as { state?: { jdText?: string } };
  const [resume, setResume] = useState<ResumeModel | null>(null);
  const [, setLedger] = useState<FactsLedger | null>(null);
  const [masterLabel, setMasterLabel] = useState("");
  const [jdText, setJdText] = useState(loc.state?.jdText ?? "");
  const [jd, setJd] = useState<JDModel | null>(null);
  const [result, setResult] = useState<TailorResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [coverLetterText, setCoverLetterText] = useState("");
  const toast = useToast();

  useEffect(() => {
    (async () => {
      try {
        const m = await getMasterResume();
        if (m?.resume) {
          setResume(m.resume);
          setLedger(m.ledger ?? null);
          setMasterLabel(m.label);
        }
      } catch {
        /* no saved résumé yet */
      }
    })();
  }, []);

  const step = !resume ? 0 : !result ? 1 : 2;
  const canRun = !!resume && jdText.trim().length > 30 && !loading;

  async function onParsed(r: ResumeModel, l: FactsLedger) {
    setResume(r);
    setLedger(l);
    setResult(null);
    setSaved(false);
    const label = r.contact.name ? `${r.contact.name}'s résumé` : "My résumé";
    try {
      const m = await saveMasterResume({ resume: r, ledger: l, label });
      setMasterLabel(m.label);
      toast("success", "Saved as your master résumé");
    } catch {
      /* persistence is best-effort */
    }
  }

  async function run() {
    if (!resume) return;
    setError("");
    setLoading(true);
    setResult(null);
    setSaved(false);
    setCoverLetterText("");
    try {
      const analyzed = await analyzeJD(jdText);
      setJd(analyzed);
      const r = await tailor(resume, analyzed);
      setResult(r);
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Something went wrong. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!result || !jd) return;
    await saveApplication({
      job_title: jd.job_title,
      company: jd.company,
      jd_text: jdText,
      tailored_resume: result.tailored_resume,
      cover_letter: coverLetterText,
      overall_score: result.score_after.overall,
    });
    setSaved(true);
    toast("success", "Saved to tracker");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Tailor your résumé</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Rewrite for a specific job — verified against your real experience.
        </p>
      </div>

      <Card>
        <Stepper steps={["Résumé", "Job description", "Results"]} current={step} />
      </Card>

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
            <JDPaste value={jdText} onChange={setJdText} />
          </div>
        </Card>
      </div>

      <Card className="flex flex-wrap items-center gap-3">
        <Button size="lg" loading={loading} icon={<Wand2 size={18} />} disabled={!canRun} onClick={run}>
          {loading ? "Tailoring…" : "Tailor my résumé"}
        </Button>
        {!resume && <span className="text-sm text-ink-muted">Upload a résumé to begin.</span>}
        {resume && jdText.trim().length <= 30 && (
          <span className="text-sm text-ink-muted">Paste a job description.</span>
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
                <Button icon={<Download size={16} />} onClick={() => downloadResume(result.tailored_resume, "docx")}>
                  Download .docx
                </Button>
                <Button
                  variant="secondary"
                  icon={<Download size={16} />}
                  onClick={() => downloadResume(result.tailored_resume, "pdf")}
                >
                  Download .pdf
                </Button>
                <div className="flex-1" />
                <Button variant="ghost" icon={<Save size={16} />} disabled={saved} onClick={save}>
                  {saved ? "✓ Saved to tracker" : "Save to tracker"}
                </Button>
              </div>
              <p className="mt-3 text-xs text-ink-muted">
                Output is single-column, ATS-safe (no tables, columns, or images).
              </p>
            </Card>

            <CoverLetter
              resume={result.tailored_resume}
              jd={jd}
              onGenerated={(t) => {
                setCoverLetterText(t);
                setSaved(false);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
