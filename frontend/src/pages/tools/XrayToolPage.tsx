import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScanEye, Sparkles } from "lucide-react";
import { atsXray, RESUME_TEMPLATES, type ResumeTemplate } from "../../api/client";
import ResumeGate from "../../components/ResumeGate";
import ToolShell from "../../components/ToolShell";
import TemplateThumb from "../../components/TemplateThumb";
import XrayResult from "../../components/XrayResult";
import { useMasterResume } from "../../hooks/useMasterResume";
import { Button, Card, CardTitle, Skeleton } from "../../components/ui";
import { cn } from "../../lib/cn";
import type { ATSXrayResult } from "../../types";

export default function XrayToolPage() {
  const { t } = useTranslation("tools");
  const { master, loading } = useMasterResume();
  const [template, setTemplate] = useState<ResumeTemplate>("classic");
  const [fmt, setFmt] = useState<"pdf" | "docx">("pdf");
  const [result, setResult] = useState<ATSXrayResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    if (!master?.resume) return;
    setRunning(true);
    setResult(null);
    setError("");
    try {
      setResult(await atsXray(master.resume, template, fmt));
    } catch {
      // Before this, a failed x-ray left an unhandled rejection and a screen
      // identical to "you never pressed the button".
      setError(t("xray.error"));
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!master?.resume) return <ResumeGate feature={t("xray.gateFeature")} />;

  return (
    <ToolShell
      title={t("cards.xray.title")}
      subtitle={t("xray.subtitle")}
      icon={<ScanEye className="text-accent-soft" />}
    >
      <Card>
        <CardTitle>{t("xray.pickTitle")}</CardTitle>
        <p className="mt-1 text-sm text-ink-muted">{t("xray.pickHint")}</p>

        {/* Scrolls itself on a phone — the page must never scroll sideways. */}
        <div className="-mx-5 mt-4 flex snap-x gap-3 overflow-x-auto px-5 pb-2 sm:mx-0 sm:grid sm:grid-cols-4 sm:overflow-visible sm:px-0 lg:grid-cols-6">
          {RESUME_TEMPLATES.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTemplate(id)}
              aria-pressed={template === id}
              className={cn(
                "w-[104px] shrink-0 snap-start rounded-xl border p-2 text-start transition sm:w-auto",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                template === id
                  ? "border-accent bg-accent/10"
                  : "border-line bg-panel hover:border-accent/40",
              )}
            >
              <TemplateThumb id={id} className="w-full" />
              <span className="mt-1.5 block truncate text-[11px] font-medium text-ink">
                {t(`download.templates.${id}.name`, { ns: "tailor", defaultValue: id })}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-line" role="group" aria-label={t("xray.fmtLabel")}>
            {(["pdf", "docx"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFmt(f)}
                aria-pressed={fmt === f}
                className={cn(
                  "px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition",
                  fmt === f ? "bg-accent text-white" : "bg-panel text-ink-muted hover:text-ink",
                )}
              >
                {f}
              </button>
            ))}
          </div>
          <Button loading={running} icon={<Sparkles size={16} />} onClick={run}>
            {t("xray.run")}
          </Button>
        </div>
      </Card>

      {running && <Skeleton className="h-64 w-full" />}

      {error && !running && (
        <Card>
          <p className="text-sm text-danger">{error}</p>
          <Button variant="ghost" className="mt-3" onClick={run}>
            {t("xray.retry")}
          </Button>
        </Card>
      )}

      {result && !running && <XrayResult result={result} template={template} />}

    </ToolShell>
  );
}
