import { ArrowRight, ArrowUpRight, ArrowDownRight, Minus, ShieldCheck, ShieldAlert } from "lucide-react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import type { FabricationFlag, Score } from "../types";
import { Card, CardTitle, ProgressRing } from "./ui";
import { cn } from "../lib/cn";

function DeltaPill({ before, after }: { before: number; after: number }) {
  const { t } = useTranslation("tailor");
  const d = Math.round((after - before) * 10) / 10;
  const up = d > 0;
  return (
    <motion.span
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.95, duration: 0.35 }}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        d === 0 && "bg-bg-soft text-ink-faint",
        d !== 0 && up && "bg-mint/10 text-mint",
        d !== 0 && !up && "bg-danger/10 text-danger",
      )}
    >
      {d === 0 ? <Minus size={12} /> : up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {d === 0 ? t("score.noChange") : t("score.delta", { sign: up ? "+" : "−", value: Math.abs(d) })}
    </motion.span>
  );
}

/**
 * The fabrication guard surfaced as a first-class score next to the rings —
 * no competitor can show this number. Clicking scrolls to the trust panel.
 */
function GuardTile({ flags }: { flags: FabricationFlag[] }) {
  const { t } = useTranslation("tailor");
  const clean = flags.length === 0;
  return (
    <button
      type="button"
      onClick={() => document.getElementById("trust-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
      className="group flex flex-col items-center gap-3"
      title={t("score.guardDetail")}
    >
      <div
        className={cn(
          "flex h-28 w-28 flex-col items-center justify-center rounded-full border-[6px] transition-transform group-hover:scale-105",
          clean ? "border-mint/60 bg-mint/10" : "border-danger/60 bg-danger/10",
        )}
      >
        {clean ? <ShieldCheck size={24} className="text-mint" /> : <ShieldAlert size={24} className="text-danger" />}
        <span className="mt-0.5 text-2xl font-bold tabular-nums text-ink">{flags.length}</span>
      </div>
      <p className="text-sm font-semibold text-ink">{t("score.guard")}</p>
      <motion.span
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.95, duration: 0.35 }}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
          clean ? "bg-mint/10 text-mint" : "bg-danger/10 text-danger",
        )}
      >
        {clean ? t("score.guardClean") : t("score.guardFlags", { count: flags.length })}
      </motion.span>
    </button>
  );
}

export default function ScoreCard({
  before,
  after,
  flags,
}: {
  before: Score;
  after: Score;
  flags: FabricationFlag[];
}) {
  const { t } = useTranslation("tailor");
  const rings = [
    { label: t("score.overall"), tone: "gradient" as const, b: before.overall, a: after.overall },
    { label: t("score.ats"), tone: "accent" as const, b: before.keyword_coverage, a: after.keyword_coverage },
    { label: t("score.fit"), tone: "mint" as const, b: before.fit_score, a: after.fit_score },
  ];
  return (
    <Card>
      <CardTitle>{t("score.title")}</CardTitle>
      <div className="mt-5 grid grid-cols-1 gap-8 sm:grid-cols-2 sm:gap-6 xl:grid-cols-4 xl:gap-4">
        {rings.map((r) => (
          <div key={r.label} className="flex flex-col items-center gap-3">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <div className="flex flex-col items-center gap-1 opacity-50">
                <ProgressRing value={r.b} size={72} stroke={6} tone={r.tone} />
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                  {t("score.before")}
                </span>
              </div>
              <ArrowRight size={18} className="shrink-0 text-ink-faint rtl:-scale-x-100" />
              <div className="flex flex-col items-center gap-1">
                <ProgressRing value={r.a} size={112} tone={r.tone} />
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink">
                  {t("score.after")}
                </span>
              </div>
            </div>
            <p className="text-sm font-semibold text-ink">{r.label}</p>
            <DeltaPill before={r.b} after={r.a} />
          </div>
        ))}
        <GuardTile flags={flags} />
      </div>
      {after.rationale && <p className="mt-6 text-sm leading-relaxed text-ink-muted">{after.rationale}</p>}
    </Card>
  );
}
