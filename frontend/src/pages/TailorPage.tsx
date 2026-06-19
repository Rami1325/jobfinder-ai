import { useState } from "react";
import { analyzeJD, downloadResume, saveApplication, tailor } from "../api/client";
import ChangeLog from "../components/ChangeLog";
import CoverLetter from "../components/CoverLetter";
import GapList from "../components/GapList";
import JDPaste from "../components/JDPaste";
import ResumeUpload from "../components/ResumeUpload";
import ScoreCard from "../components/ScoreCard";
import type { JDModel, ResumeModel, TailorResult } from "../types";

export default function TailorPage() {
  const [resume, setResume] = useState<ResumeModel | null>(null);
  const [jdText, setJdText] = useState("");
  const [jd, setJd] = useState<JDModel | null>(null);
  const [result, setResult] = useState<TailorResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [coverLetterText, setCoverLetterText] = useState("");

  const canRun = !!resume && jdText.trim().length > 30 && !loading;

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
  }

  return (
    <>
      <div className="grid-2">
        <ResumeUpload onParsed={setResume} />
        <JDPaste value={jdText} onChange={setJdText} />
      </div>

      <div className="panel">
        <div className="row">
          <button className="btn" onClick={run} disabled={!canRun}>
            {loading ? <><span className="spinner" /> Tailoring…</> : "Tailor my résumé →"}
          </button>
          {!resume && <span className="muted">Upload a résumé to begin.</span>}
          {resume && jdText.trim().length <= 30 && <span className="muted">Paste a job description.</span>}
          {error && <span className="error">{error}</span>}
        </div>
      </div>

      {result && jd && (
        <>
          <ScoreCard before={result.score_before} after={result.score_after} />
          <GapList gaps={result.score_after.gaps} />
          <ChangeLog changelog={result.changelog} flags={result.fabrication_flags} />

          <div className="panel">
            <h2>Download tailored résumé</h2>
            <div className="row">
              <button className="btn" onClick={() => downloadResume(result.tailored_resume, "docx")}>
                Download .docx
              </button>
              <button className="btn secondary" onClick={() => downloadResume(result.tailored_resume, "pdf")}>
                Download .pdf
              </button>
              <div className="spacer" />
              <button className="btn ghost" onClick={save} disabled={saved}>
                {saved ? "✓ Saved to tracker" : "Save to tracker"}
              </button>
            </div>
            <p className="muted" style={{ marginTop: 10 }}>
              Output is single-column, ATS-safe (no tables, columns, or images).
            </p>
          </div>

          <CoverLetter
            resume={result.tailored_resume}
            jd={jd}
            onGenerated={(t) => {
              setCoverLetterText(t);
              setSaved(false); // allow re-saving so the cover letter is captured in history
            }}
          />
        </>
      )}
    </>
  );
}
