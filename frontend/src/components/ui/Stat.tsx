import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import { cn } from "../../lib/cn";

interface StatProps {
  value: string | number;
  label: string;
  delta?: number; // positive = improvement
  suffix?: string;
}

export default function Stat({ value, label, delta, suffix }: StatProps) {
  const up = delta !== undefined && delta > 0;
  const down = delta !== undefined && delta < 0;
  return (
    <div className="text-center">
      <div className="flex items-baseline justify-center gap-1">
        <span className="text-3xl font-bold tabular-nums text-ink">{value}</span>
        {suffix && <span className="text-sm text-ink-muted">{suffix}</span>}
      </div>
      <div className="mt-0.5 text-xs text-ink-muted">{label}</div>
      {delta !== undefined && delta !== 0 && (
        <div
          className={cn(
            "mt-1 inline-flex items-center gap-0.5 text-xs font-semibold",
            up && "text-mint",
            down && "text-danger",
          )}
        >
          {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
          {Math.abs(delta).toFixed(0)}
        </div>
      )}
    </div>
  );
}
