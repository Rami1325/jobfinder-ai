import { Sparkles, CheckCircle2, AlertTriangle, Compass } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CVPlan, VoiceReport } from "../types";
import { Card, CardTitle } from "./ui";
import { cn } from "../lib/cn";

/**
 * The humanization audit surfaced next to the scores: the positioning story
 * the tailor followed and which AI tells were detected/rewritten. Absent
 * report (older saved results) renders nothing.
 *
 * It used to carry a third block, the CREDIBILITY reviewer's advisory flags.
 * That stage was REMOVED, not deferred -- 7-18 flags a tailor for 31% of the
 * wall clock, and the owner never read them. Old kits still hold their flags in
 * `result_json`; nothing rewrites that column, so the data is recoverable.
 */
export default function VoicePanel({
  report,
  plan,
  bare = false,
}: {
  report?: VoiceReport;
  plan?: CVPlan | null;
  /** Without the card and its title (PLAN 31.3/3): the drawer's section heading
   * names it, and the score chip stands alone. */
  bare?: boolean;
}) {
  const { t } = useTranslation("tailor");
  if (!report) return null;
  const clean = report.issues.length === 0;

  const Shell = bare ? "div" : Card;
  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {!bare && <CardTitle>{t("voice.title")}</CardTitle>}
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

    </Shell>
  );
}
