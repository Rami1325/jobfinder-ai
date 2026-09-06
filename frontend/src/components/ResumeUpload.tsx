import { useRef, useState } from "react";
import { UploadCloud, FileCheck2, Loader2, Import, ChevronDown, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { uploadResume } from "../api/client";
import type { FactsLedger, ResumeModel } from "../types";
import { apiErrorMessage } from "../lib/apiError";
import { cn } from "../lib/cn";

interface Props {
  onParsed: (resume: ResumeModel, ledger: FactsLedger) => void;
  /** Label of an already-loaded saved resume, shown until a new file is chosen. */
  savedLabel?: string;
}

export default function ResumeUpload({ onParsed, savedLabel }: Props) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState("");
  const [liOpen, setLiOpen] = useState(false);

  async function handleFile(file: File) {
    setError("");
    setLoading(true);
    setFileName(file.name);
    try {
      const res = await uploadResume(file);
      onParsed(res.resume, res.ledger);
    } catch (e: any) {
      setError(apiErrorMessage(e, t("resumeUpload.error")));
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

      {/* LinkedIn profile import: the export is just a PDF, so it rides the
          same upload path — this is the no-resume cold-start escape hatch. */}
      <button
        type="button"
        onClick={() => setLiOpen((v) => !v)}
        className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-accent-soft hover:underline"
      >
        <Import size={13} />
        {t("resumeUpload.linkedin.toggle")}
        <ChevronDown size={13} className={cn("transition-transform", liOpen && "rotate-180")} />
      </button>
      {liOpen && (
        <ol className="mt-2 list-decimal space-y-1 ps-5 text-xs text-ink-muted">
          <li>
            {t("resumeUpload.linkedin.step1")}{" "}
            <a
              href="https://www.linkedin.com/in/me"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-accent-soft hover:underline"
            >
              {t("resumeUpload.linkedin.step1Link")} <ExternalLink size={11} />
            </a>
          </li>
          <li>{t("resumeUpload.linkedin.step2")}</li>
          <li>{t("resumeUpload.linkedin.step3")}</li>
        </ol>
      )}
    </div>
  );
}
