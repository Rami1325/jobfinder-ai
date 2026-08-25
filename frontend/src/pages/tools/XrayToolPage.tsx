import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScanEye, Sparkles, AlertTriangle, CheckCircle2, WrapText, FileWarning } from "lucide-react";
import { atsXray, RESUME_TEMPLATES, type ResumeTemplate } from "../../api/client";
import ResumeGate from "../../components/ResumeGate";
import ToolShell from "../../components/ToolShell";
import TemplateThumb from "../../components/TemplateThumb";
import { useMasterResume } from "../../hooks/useMasterResume";
import { Badge, Button, Card, CardTitle, Skeleton } from "../../components/ui";
import { cn } from "../../lib/cn";
import type { ATSXrayFact, ATSXrayResult } from "../../types";

/** Statuses in the order a reader cares about them: problems first. */
const ORDER: ATSXrayFact["status"][] = ["missing", "polluted", "split", "clean"];

const STATUS = {
  clean: { icon: CheckCircle2, cls: "text-mint", tone: "covered" },
  split: { icon: WrapText, cls: "text-ink-muted", tone: "partial" },
  polluted: { icon: AlertTriangle, cls: "text-warn", tone: "partial" },
  missing: { icon: FileWarning, cls: "text-danger", tone: "missing" },
} as const;

export default function XrayToolPage() {
  const { t } = useTranslation("tools");
  const { master, loading } = useMasterResume();
  const [template, setTemplate] = useState<ResumeTemplate>("classic");
  const [fmt, setFmt] = useState<"pdf" | "docx">("pdf");
  const [result, setResult] = useState<ATSXrayResult | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    if (!master?.resume) return;
    setRunning(true);
    setResult(null);
    try {
      setResult(await atsXray(master.resume, template, fmt));
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!master?.resume) return <ResumeGate feature={t("xray.gateFeature")} />;

  const problems = result?.facts.filter((f) => f.status === "polluted" || f.status === "missing") ?? [];

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

      {result && !running && (
        <>
          <Card>
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
              {(["clean", "split", "polluted", "missing"] as const).map((k) => (
                <span key={k} className="flex items-baseline gap-1.5">
                  <span
                    className={cn(
                      "text-2xl font-bold tabular-nums",
                      k === "missing" && result.missing > 0 && "text-danger",
                      k === "polluted" && result.polluted > 0 && "text-warn",
                      k === "clean" && "text-mint",
                    )}
                  >
                    {result[k]}
                  </span>
                  <span className="text-sm text-ink-muted">{t(`xray.count.${k}`)}</span>
                </span>
              ))}
            </div>
            <p className="mt-3 text-sm text-ink-muted">
              {result.docx_fallback
                ? t("xray.verdict.fallback", { template: result.docx_fallback })
                : result.polluted > 0
                  ? t("xray.verdict.polluted")
                  : t("xray.verdict.clean")}
            </p>
          </Card>

          {problems.length > 0 && (
            <Card>
              <CardTitle>{t("xray.problemsTitle")}</CardTitle>
              <ul className="mt-3 space-y-3">
                {problems.map((f, i) => {
                  const S = STATUS[f.status];
                  return (
                    <li key={i} className="flex items-start gap-2.5 text-sm">
                      <S.icon size={16} className={cn("mt-0.5 shrink-0", S.cls)} />
                      <div className="min-w-0">
                        <p className="text-ink">
                          <span className="font-semibold">{t(`xray.kind.${f.kind}`, { defaultValue: f.kind })}</span>
                          <span className="text-ink-muted"> — “{f.value}”</span>
                        </p>
                        {f.status === "polluted" && (
                          <p className="mt-0.5 text-xs text-warn">
                            {t("xray.collided", { value: f.collided_with })}
                          </p>
                        )}
                        {f.line && (
                          <p className="mt-1 truncate rounded bg-bg-soft px-2 py-1 font-mono text-xs text-ink-muted" dir="auto">
                            {f.line}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          <Card>
            <CardTitle>{t("xray.textTitle")}</CardTitle>
            <p className="mt-1 text-sm text-ink-muted">{t("xray.textHint")}</p>
            {/* Verbatim, monospaced, and horizontally scrollable in its own box —
                this is evidence, so it is never reflowed or prettified. */}
            <pre
              dir="auto"
              className="mt-3 max-h-[26rem] overflow-auto rounded-xl border border-line bg-bg-soft p-3 font-mono text-xs leading-relaxed text-ink-muted"
            >
              {result.text}
            </pre>
          </Card>

          <Card>
            <CardTitle>{t("xray.legendTitle")}</CardTitle>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {ORDER.map((k) => {
                const S = STATUS[k];
                return (
                  <p key={k} className="flex items-start gap-2 text-sm text-ink-muted">
                    <S.icon size={15} className={cn("mt-0.5 shrink-0", S.cls)} />
                    <span>
                      <Badge tone={S.tone as "covered" | "partial" | "missing"}>{t(`xray.count.${k}`)}</Badge>{" "}
                      {t(`xray.legend.${k}`)}
                    </span>
                  </p>
                );
              })}
            </div>
          </Card>
        </>
      )}
    </ToolShell>
  );
}
