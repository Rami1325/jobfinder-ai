import { useRef, useState } from "react";
import { uploadResume } from "../api/client";
import type { ResumeModel } from "../types";

interface Props {
  onParsed: (resume: ResumeModel) => void;
}

export default function ResumeUpload({ onParsed }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleFile(file: File) {
    setError("");
    setLoading(true);
    setFileName(file.name);
    try {
      const res = await uploadResume(file);
      onParsed(res.resume);
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Failed to parse resume.");
      setFileName("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel">
      <h2>1 · Your résumé</h2>
      <div
        className={`dropzone ${fileName ? "has-file" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
      >
        {loading ? (
          <span>
            <span className="spinner" /> Parsing résumé…
          </span>
        ) : fileName ? (
          <span>✓ {fileName} — parsed. Click to replace.</span>
        ) : (
          <span>Drop your résumé here, or click to choose (.docx / .pdf / .txt)</span>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".docx,.pdf,.txt"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
      {error && <p className="error">{error}</p>}
    </div>
  );
}
