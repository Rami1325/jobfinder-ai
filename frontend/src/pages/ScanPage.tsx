import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  FileCheck2,
  Loader2,
  Minus,
  ScanSearch,
  ShieldCheck,
  UploadCloud,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { scanResume } from "../api/client";
import type { FreeScanResult } from "../types";
import ToolShell from "../components/ToolShell";
import { Button, Card, CardTitle, ProgressRing, SectionLabel } from "../components/ui";
import { apiErrorMessage } from "../lib/apiError";
import { cn } from "../lib/cn";

const chipTone: Record<string, string> = {
  covered: "border-mint/50 bg-mint/15 text-mint",
  partial: "border-warn/50 bg-warn/15 text-warn",
  missing: "border-danger/50 bg-danger/12 text-danger",
};
const groupMeta = {
  covered: { icon: <Check size={12} />, labelKey: "results.matched" },
  partial: { icon: <Minus size={12} />, labelKey: "results.partial" },
  missing: { icon: <X size={12} />, labelKey: "results.missing" },
} as const;

/**
 * The CV scan (PLAN 6): deterministic keyword coverage and a few resume checks
 * against a pasted job description, with no model call and nothing stored. An
 * app tool since Phase 30 (A2): it sits behind AppLayout's sign-in guard like
 * every other feature, posts to /tools/scan and uses 1 of the month's uses (a
 * file the server refuses or cannot read gives the use back), and /scan
 * redirects to sign-up. The chrome it had as a public page, the marketing footer
 * and the "no signup" kicker, is gone; it wears the tools' own shell instead.
 */
export default function ScanPage() {
  const { t } = useTranslation("scan");
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [jd, setJd] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<FreeScanResult | null>(null);

  const canScan = !!file && jd.trim().length > 0 && !loading;

  async function scan() {
    if (!file || !canScan) return;
    setLoading(true);
    setError("");
    try {
      const res = await scanResume(file, jd);
      setResult(res);
    } catch (e) {
      setResult(null);
      setError(apiErrorMessage(e, t("error")));
    } finally {
      setLoading(false);
    }
  }

  const ringTone = (result?.coverage ?? 0) >= 65 ? "mint" : "accent";

  return (
    <ToolShell title={t("title")} subtitle={t("sub")} icon={<ScanSearch className="text-accent-soft" />}>
      <div className="grid gap-4 md:grid-cols-2">
        {/* Resume drop zone */}
        <Card>
          <SectionLabel className="mb-2">{t("resumeLabel")}</SectionLabel>
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
              if (f) setFile(f);
            }}
            className={cn(
              "flex h-44 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
              drag ? "border-accent bg-accent/5" : file ? "border-mint/50 bg-mint/5" : "border-line hover:border-accent/50",
            )}
          >
            {file ? (
              <>
                <FileCheck2 className="mb-2 text-mint" />
                <span className="text-sm text-ink">{file.name}</span>
                <span className="mt-1 text-xs text-ink-muted">{t("fileReady")}</span>
              </>
            ) : (
              <>
                <UploadCloud className="mb-2 text-ink-muted" />
                <span className="text-sm text-ink">{t("drop")}</span>
                <span className="mt-1 text-xs text-ink-faint">{t("fileTypes")}</span>
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
              if (f) setFile(f);
            }}
          />
        </Card>

        {/* JD paste */}
        <Card>
          <SectionLabel className="mb-2">{t("jdLabel")}</SectionLabel>
          <textarea
            dir="auto"
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            placeholder={t("jdPlaceholder")}
            className="h-44 w-full resize-none rounded-xl border border-line bg-bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
          />
        </Card>
      </div>

      <div>
        <div className="flex flex-wrap items-center gap-4">
          <Button size="lg" disabled={!canScan} onClick={scan} icon={loading ? <Loader2 size={18} className="animate-spin" /> : <ScanSearch size={18} />}>
            {loading ? t("scanning") : t("scan")}
          </Button>
          <p className="inline-flex items-center gap-1.5 text-xs text-ink-faint">
            <ShieldCheck size={14} className="text-mint" /> {t("privacy")}
          </p>
        </div>
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </div>

      {/* Results */}
      {result && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="space-y-4"
        >
          <Card>
            <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
              <ProgressRing value={result.coverage} size={128} stroke={11} tone={ringTone} label={t("results.coverage")} />
              <div className="min-w-0 flex-1">
                <CardTitle>{t("results.coverage")}</CardTitle>
                <p className="mt-1 text-sm text-ink-muted">{t("results.coverageHint")}</p>
                {result.keywords.length === 0 && (
                  <p className="mt-3 text-sm text-warn">{t("results.noKeywords")}</p>
                )}
                <div className="mt-4 space-y-3">
                  {(Object.keys(groupMeta) as (keyof typeof groupMeta)[]).map((status) => {
                    const group = result.keywords.filter((k) => k.status === status);
                    if (!group.length) return null;
                    return (
                      <div key={status}>
                        <SectionLabel className="mb-1.5">
                          {t(groupMeta[status].labelKey, { count: group.length })}
                        </SectionLabel>
                        <div className="flex flex-wrap gap-1.5">
                          {group.map((k) => (
                            <span
                              key={k.keyword}
                              dir="auto"
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
                                chipTone[k.status],
                              )}
                            >
                              {groupMeta[status].icon}
                              {k.keyword}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <CardTitle>{t("results.checks")}</CardTitle>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {result.checks.map((c) => (
                <li
                  key={c.id}
                  className={cn(
                    "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
                    c.severity === "good" ? "border-mint/30 bg-mint/5 text-ink-muted" : "border-warn/40 bg-warn/10 text-ink-muted",
                  )}
                >
                  {c.severity === "good" ? (
                    <Check size={15} className="mt-0.5 shrink-0 text-mint" />
                  ) : (
                    <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
                  )}
                  {t(`results.check.${c.id}.${c.severity}`, { value: c.value })}
                </li>
              ))}
            </ul>
          </Card>

          {/* The next step: have the missing keywords worked into the resume */}
          <Card className="border-accent/40">
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>{t("cta.title")}</CardTitle>
                <p className="mt-1 max-w-xl text-sm text-ink-muted">{t("cta.body")}</p>
              </div>
              <Link to="/jobs" className="shrink-0">
                <Button size="lg" icon={<ArrowRight size={18} className="rtl:-scale-x-100" />}>
                  {t("cta.button")}
                </Button>
              </Link>
            </div>
          </Card>
        </motion.div>
      )}
    </ToolShell>
  );
}
