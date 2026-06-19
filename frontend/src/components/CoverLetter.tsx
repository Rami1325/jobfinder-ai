import { useState } from "react";
import { coverLetter } from "../api/client";
import type { JDModel, ResumeModel } from "../types";

interface Props {
  resume: ResumeModel;
  jd: JDModel;
  onGenerated?: (text: string) => void;
}

export default function CoverLetter({ resume, jd, onGenerated }: Props) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function generate() {
    setError("");
    setLoading(true);
    try {
      const t = await coverLetter(resume, jd);
      setText(t);
      onGenerated?.(t);
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Failed to generate cover letter.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel">
      <h2>Cover letter</h2>
      <div className="row">
        <button className="btn secondary" onClick={generate} disabled={loading}>
          {loading ? <><span className="spinner" /> Writing…</> : text ? "Regenerate" : "Generate cover letter"}
        </button>
        {text && (
          <button className="btn ghost" onClick={() => navigator.clipboard.writeText(text)}>
            Copy
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {text && <div className="cover-letter" style={{ marginTop: 12 }}>{text}</div>}
    </div>
  );
}
