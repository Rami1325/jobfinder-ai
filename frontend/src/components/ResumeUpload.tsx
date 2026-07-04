import { useRef, useState } from "react";
import { UploadCloud, FileCheck2, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { uploadResume } from "../api/client";
import type { FactsLedger, ResumeModel } from "../types";
import { cn } from "../lib/cn";

interface Props {
  onParsed: (resume: ResumeModel, ledger: FactsLedger) => void;
  /** Label of an already-loaded saved résumé, shown until a new file is chosen. */
  savedLabel?: string;
}

export default function ResumeUpload({ onParsed, savedLabel }: Props) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState("");

  async function handleFile(file: File) {
    setError("");
    setLoading(true);
    setFileName(file.name);
    try {
      const res = await uploadResume(file);
      onParsed(res.resume, res.ledger);
    } catch (e: any) {
      setError(e?.response?.data?.detail || t("resumeUpload.error"));
      setFileName("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
          drag
            ? "border-accent bg-accent/5"
            : fileName || savedLabel
              ? "border-mint/50 bg-mint/5"
              : "border-line hover:border-accent/50",
        )}
      >
        {loading ? (
          <>
            <Loader2 className="mb-2 animate-spin text-accent" />
            <span className="text-sm text-ink-muted">{t("resumeUpload.parsing")}</span>
          </>
        ) : fileName ? (
          <>
            <FileCheck2 className="mb-2 text-mint" />
            <span className="text-sm text-ink">{fileName}</span>
            <span className="mt-1 text-xs text-ink-muted">{t("resumeUpload.parsedReplace")}</span>
          </>
        ) : savedLabel ? (
          <>
            <FileCheck2 className="mb-2 text-mint" />
            <span className="text-sm text-ink">{t("resumeUpload.using", { label: savedLabel })}</span>
            <span className="mt-1 text-xs text-ink-muted">{t("resumeUpload.dropReplace")}</span>
          </>
        ) : (
          <>
            <UploadCloud className="mb-2 text-ink-muted" />
            <span className="text-sm text-ink">{t("resumeUpload.drop")}</span>
            <span className="mt-1 text-xs text-ink-faint">.docx · .pdf · .txt</span>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".docx,.pdf,.txt"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
