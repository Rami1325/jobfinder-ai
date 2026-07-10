import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  HeartPulse,
  Lightbulb,
  Sparkles,
  XCircle,
} from "lucide-react";
import { resumeHealth } from "../../api/client";
import ResumeGate from "../../components/ResumeGate";
import ToolShell from "../../components/ToolShell";
import { useMasterResume } from "../../hooks/useMasterResume";
import { apiErrorMessage } from "../../lib/apiError";
import { Button, Card, CardTitle, ProgressRing, Skeleton, useToast } from "../../components/ui";
import type { HealthCheck, ResumeHealthResult } from "../../types";

const sev = {
  good: { icon: <CheckCircle2 size={16} className="text-mint" />, cls: "text-mint" },
  warn: { icon: <AlertTriangle size={16} className="text-warn" />, cls: "text-warn" },
  bad: { icon: <XCircle size={16} className="text-danger" />, cls: "text-danger" },
};

export default function ResumeHealthToolPage() {
  const { t } = useTranslation("tools");
  const { master, loading } = useMasterResume();
  const [result, setResult] = useState<ResumeHealthResult | null>(null);
  const [running, setRunning] = useState(false);
  const toast = useToast();

  async function run() {
    if (!master?.resume) return;
    setRunning(true);
    setResult(null);
    try {
      setResult(await resumeHealth(master.resume));
    } catch (e) {
      toast("error", apiErrorMessage(e, t("health.error")));
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!master?.resume) return <ResumeGate feature={t("health.gateFeature")} />;

  return (
    <ToolShell
      title={t("cards.health.title")}
      subtitle={t("health.subtitle")}
      icon={<HeartPulse className="text-accent-soft" />}
    >
      <Card>
        <Button loading={running} icon={<Sparkles size={16} />} onClick={run}>
          {t("health.run")}
        </Button>
      </Card>

      {running && <Skeleton className="h-56 w-full" />}

      {result && !running && (
        <>
          <Card className="flex flex-col gap-5 sm:flex-row sm:items-start">
            <ProgressRing value={result.score} size={120} label={t("health.scoreLabel")} />
            <div className="min-w-0 flex-1 space-y-2.5">
              {result.checks.map((c) => (
                <CheckRow key={c.id} check={c} />
              ))}
              <p className="pt-1 text-xs text-ink-faint">{t("health.scoreNote")}</p>
            </div>
          </Card>

          {(result.strengths.length > 0 || result.improvements.length > 0) && (
            <div className="grid gap-4 md:grid-cols-2">
              {result.strengths.length > 0 && (
                <Card>
                  <CardTitle>{t("health.strengths")}</CardTitle>
                  <ul className="mt-2 space-y-1.5">
                    {result.strengths.map((s, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-ink" dir="auto">
                        <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-mint" /> {s}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {result.improvements.length > 0 && (
                <Card>
                  <CardTitle>{t("health.improvements")}</CardTitle>
                  <ul className="mt-2 space-y-1.5">
                    {result.improvements.map((s, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-ink" dir="auto">
                        <Lightbulb size={14} className="mt-0.5 shrink-0 text-warn" /> {s}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          )}

          {result.rewrites.length > 0 && (
            <Card>
              <CardTitle>{t("health.rewrites")}</CardTitle>
              <p className="mt-1 text-xs text-ink-faint">{t("health.rewriteNote")}</p>
              <div className="mt-3 space-y-3">
                {result.rewrites.map((r, i) => (
                  <div key={i} className="rounded-xl border border-line bg-bg-soft p-3 text-sm">
                    <p className="text-ink-muted line-through decoration-danger/50" dir="auto">
                      {r.before}
                    </p>
                    <p className="mt-1.5 flex items-start gap-2 text-ink" dir="auto">
                      <ArrowRight size={14} className="mt-0.5 shrink-0 text-mint rtl:-scale-x-100" />
                      {r.after}
                    </p>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </ToolShell>
  );
}

function CheckRow({ check }: { check: HealthCheck }) {
  const { t } = useTranslation("tools");
  const s = sev[check.severity];
  const copyKey = check.severity === "good" ? "ok" : "issue";
  return (
    <div className="flex items-start gap-2 text-sm">
      {s.icon}
      <span className="min-w-0">
        <span className={s.cls}>{t(`health.checks.${check.id}.label`)}</span>{" "}
        <span className="text-ink-muted">
          {/* `n`, not `count` — count would trigger i18next plural-key resolution */}
          {t(`health.checks.${check.id}.${copyKey}`, {
            n: check.count,
            total: check.total,
          })}
        </span>
        {check.examples.length > 0 && check.severity !== "good" && (
          <span className="mt-1 flex flex-wrap gap-1.5">
            {check.examples.map((ex, i) => (
              <span
                key={i}
                dir="auto"
                className="rounded-md border border-line bg-bg-soft px-1.5 py-0.5 text-xs text-ink-muted"
              >
                {ex}
              </span>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}
