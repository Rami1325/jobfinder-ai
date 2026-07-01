import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import type { Score } from "../types";
import { Card, CardTitle, ProgressRing } from "./ui";
import { cn } from "../lib/cn";

function Delta({ before, after }: { before: number; after: number }) {
  const d = Math.round((after - before) * 10) / 10;
  if (d === 0) return <span className="text-xs text-ink-faint">no change (was {Math.round(before)})</span>;
  const up = d > 0;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-semibold", up ? "text-mint" : "text-danger")}>
      {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {Math.abs(d)} <span className="font-normal text-ink-faint">(was {Math.round(before)})</span>
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
      <CardTitle>Match score</CardTitle>
      <div className="mt-4 grid grid-cols-3 gap-4">
        {rings.map((r) => (
          <div key={r.label} className="flex flex-col items-center gap-2">
            <ProgressRing value={r.a} size={112} label={r.label} tone={r.tone} />
            <Delta before={r.b} after={r.a} />
          </div>
        ))}
      </div>
      {after.rationale && <p className="mt-5 text-sm leading-relaxed text-ink-muted">{after.rationale}</p>}
    </Card>
  );
}
