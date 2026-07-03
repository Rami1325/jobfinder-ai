import { ArrowRight, ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import type { Score } from "../types";
import { Card, CardTitle, ProgressRing } from "./ui";
import { cn } from "../lib/cn";

function DeltaPill({ before, after }: { before: number; after: number }) {
  const d = Math.round((after - before) * 10) / 10;
  const up = d > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        d === 0 && "bg-bg-soft text-ink-faint",
        d !== 0 && up && "bg-mint/10 text-mint",
        d !== 0 && !up && "bg-danger/10 text-danger",
      )}
    >
      {d === 0 ? <Minus size={12} /> : up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {d === 0 ? "no change" : `${up ? "+" : "−"}${Math.abs(d)} pts`}
    </span>
  );
}

export default function ScoreCard({ before, after }: { before: Score; after: Score }) {
  const rings = [
    { label: "Overall", tone: "gradient" as const, b: before.overall, a: after.overall },
    { label: "ATS", tone: "accent" as const, b: before.keyword_coverage, a: after.keyword_coverage },
    { label: "Fit", tone: "mint" as const, b: before.fit_score, a: after.fit_score },
  ];
  return (
    <Card>
      <CardTitle>Match score — before vs. after</CardTitle>
      <div className="mt-5 grid grid-cols-1 gap-8 sm:grid-cols-3 sm:gap-4">
        {rings.map((r) => (
          <div key={r.label} className="flex flex-col items-center gap-3">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <div className="flex flex-col items-center gap-1 opacity-50">
                <ProgressRing value={r.b} size={72} stroke={6} tone={r.tone} />
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                  Before
                </span>
              </div>
              <ArrowRight size={18} className="shrink-0 text-ink-faint" />
              <div className="flex flex-col items-center gap-1">
                <ProgressRing value={r.a} size={112} tone={r.tone} />
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink">
                  After
                </span>
              </div>
            </div>
            <p className="text-sm font-semibold text-ink">{r.label}</p>
            <DeltaPill before={r.b} after={r.a} />
          </div>
        ))}
      </div>
      {after.rationale && <p className="mt-6 text-sm leading-relaxed text-ink-muted">{after.rationale}</p>}
    </Card>
  );
}
