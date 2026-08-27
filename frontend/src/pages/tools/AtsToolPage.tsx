import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ScanLine, CheckCircle2, AlertTriangle, XCircle, Sparkles } from "lucide-react";
import { analyzeJD, atsScan } from "../../api/client";
import { apiErrorMessage } from "../../lib/apiError";
import ResumeGate from "../../components/ResumeGate";
import ToolShell from "../../components/ToolShell";
import { useMasterResume } from "../../hooks/useMasterResume";
import { Badge, Button, Card, CardTitle, CountUp, ProgressRing, Skeleton, useToast } from "../../components/ui";
import type { ATSScanResult } from "../../types";

const sev = {
  good: { icon: <CheckCircle2 size={16} className="text-mint" />, cls: "text-mint" },
  warn: { icon: <AlertTriangle size={16} className="text-warn" />, cls: "text-warn" },
  bad: { icon: <XCircle size={16} className="text-danger" />, cls: "text-danger" },
};

export default function AtsToolPage() {
  const { t } = useTranslation("tools");
  const { master, loading } = useMasterResume();
  const [jdText, setJdText] = useState("");
  const [result, setResult] = useState<ATSScanResult | null>(null);
  const [running, setRunning] = useState(false);
  const toast = useToast();

  async function run() {
    if (!master?.resume) return;
    setRunning(true);
    setResult(null);
    try {
      // Two hops on purpose. /tools/ats-scan is uncapped BECAUSE it is
      // deterministic, so reading the posting has to happen here, on the capped
      // /jd/analyze — the scan itself must never be handed job-ad text.
      // Failing loudly matters: a swallowed error here would silently downgrade
      // to a format-only scan and quietly report 0% coverage.
      const jd = jdText.trim() ? await analyzeJD(jdText) : null;
      setResult(await atsScan(master.resume, jd));
    } catch (e) {
      toast("error", apiErrorMessage(e, t("ats.error")));
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!master?.resume) return <ResumeGate feature={t("ats.gateFeature")} />;

  return (
    <ToolShell
      title={t("cards.ats.title")}
      subtitle={t("ats.subtitle")}
      icon={<ScanLine className="text-accent-soft" />}
    >
      <Card>
        <CardTitle>{t("ats.jdTitle")}</CardTitle>
        <textarea
          value={jdText}
          onChange={(e) => setJdText(e.target.value)}
          placeholder={t("ats.jdPlaceholder")}
          className="mt-3 min-h-[120px] w-full resize-y rounded-xl border border-line bg-bg-soft p-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
        />
        <Button className="mt-3" loading={running} icon={<Sparkles size={16} />} onClick={run}>
          {t("ats.scan")}
        </Button>
      </Card>

      {running && <Skeleton className="h-40 w-full" />}

      {result && !running && (
        <Card className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <ProgressRing value={result.score} size={120} label={t("ats.scoreLabel")} />
          <div className="flex-1 space-y-2">
            {result.keyword_coverage > 0 && (
              <p className="text-sm text-ink-muted">
                <Trans
                  t={t}
                  i18nKey="ats.coverage"
                  values={{ pct: Math.round(result.keyword_coverage) }}
                  components={[
                    <span key="0" />,
                    // CountUp animates the number itself; the "{{pct}}%" the
                    // template puts inside <1> is dropped (no children prop).
                    <CountUp
                      key="1"
                      to={Math.round(result.keyword_coverage)}
                      suffix="%"
                      duration={0.9}
                      className="font-semibold tabular-nums text-ink"
                    />,
                  ]}
                />
              </p>
            )}
            {result.issues.map((iss, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                {sev[iss.severity].icon}
                <span>
                  <span className={sev[iss.severity].cls}>{iss.label}</span>
                  {iss.detail && <span className="text-ink-muted"> — {iss.detail}</span>}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {result && result.gaps.length > 0 && !running && (
        <Card>
          <CardTitle>{t("ats.missing")}</CardTitle>
          <div className="mt-3 flex flex-wrap gap-2">
            {result.gaps
              .filter((g) => g.status !== "covered")
              .map((g) => (
                <Badge key={g.keyword} tone={g.status as "partial" | "missing"}>
                  {g.keyword}
                </Badge>
              ))}
          </div>
        </Card>
      )}
    </ToolShell>
  );
}
