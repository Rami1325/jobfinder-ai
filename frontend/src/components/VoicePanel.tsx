import { Sparkles, CheckCircle2, AlertTriangle, Compass, ShieldQuestion } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CredibilityFlag, CVPlan, VoiceReport } from "../types";
import { Card, CardTitle } from "./ui";
import { cn } from "../lib/cn";

/**
 * The humanization audit surfaced next to the scores: the positioning story
 * the tailor followed, which AI tells were detected/rewritten, and any
 * true-but-overstated claims worth softening before an interview. Absent
 * report (older saved results) renders nothing.
 */
export default function VoicePanel({
  report,
  plan,
  credibility = [],
}: {
  report?: VoiceReport;
  plan?: CVPlan | null;
  credibility?: CredibilityFlag[];
}) {
  const { t } = useTranslation("tailor");
  if (!report) return null;
  const clean = report.issues.length === 0;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>{t("voice.title")}</CardTitle>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
            clean ? "bg-mint/10 text-mint" : "bg-warn/10 text-warn",
          )}
        >
          {clean ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
          {t("voice.score", { value: Math.round(report.human_voice_score) })}
        </span>
      </div>

      {plan?.positioning && (
        <p className="mt-2 flex items-start gap-2 text-sm leading-relaxed text-ink-muted">
          <Compass size={15} className="mt-0.5 shrink-0 text-accent-soft" />
          <span>
            <span className="font-semibold text-ink">{t("voice.positioning")}</span>{" "}
            {plan.positioning}
          </span>
        </p>
      )}

      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        {clean ? t("voice.cleanNote") : t("voice.issuesNote", { count: report.issues.length })}
      </p>

      {report.revised && report.fixed.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-mint">
            <Sparkles size={13} className="shrink-0" />
            {t("voice.fixed", { count: report.fixed.length })}
          </span>
          {report.fixed.map((i) => (
            <span
              key={`${i.category}:${i.value}`}
              className="rounded-full bg-bg-soft px-2 py-0.5 text-xs text-ink-faint line-through"
            >
              {i.value}
            </span>
          ))}
        </div>
      )}

      {!clean && (
        <ul className="mt-3 space-y-2">
          {report.issues.map((i) => (
            <li key={`${i.category}:${i.value}:${i.location}`} className="flex items-start gap-2 text-sm">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
              <span className="min-w-0 leading-snug">
                <span className="font-semibold text-ink">"{i.value}"</span>{" "}
                <span className="text-ink-faint">
                  {t(`voice.cat.${i.category}`)}
                  {i.location ? ` — ${i.location}` : ""}
                </span>
                <span className="block text-ink-muted">{i.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {credibility.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <ShieldQuestion size={15} className="shrink-0 text-warn" />
            {t("voice.credTitle", { count: credibility.length })}
          </p>
          <p className="mt-1 text-xs leading-snug text-ink-faint">{t("voice.credNote")}</p>
          <ul className="mt-2 space-y-2.5">
            {credibility.map((f) => (
              <li key={f.text} className="text-sm leading-snug">
                <span className="text-ink-muted">"{f.text}"</span>
                <span className="mt-0.5 block text-xs text-ink-faint">
                  {t(`voice.risk.${f.risk}`)} · {f.detail}
                </span>
                {f.suggestion && (
                  <span className="mt-0.5 block text-xs text-mint">
                    {t("voice.credSuggestion")} {f.suggestion}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
