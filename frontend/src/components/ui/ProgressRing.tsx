import { useEffect } from "react";
import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { cn } from "../../lib/cn";

interface ProgressRingProps {
  value: number; // 0-100
  size?: number;
  stroke?: number;
  label?: string;
  sublabel?: string;
  tone?: "accent" | "mint" | "gradient";
}

/** Animated circular score gauge. */
export default function ProgressRing({
  value,
  size = 120,
  stroke = 10,
  label,
  sublabel,
  tone = "gradient",
}: ProgressRingProps) {
  const v = Math.max(0, Math.min(100, value));
  // Count the center number up in sync with the ring sweep.
  const mv = useMotionValue(0);
  const rounded = useTransform(mv, (x) => Math.round(x));
  useEffect(() => {
    const controls = animate(mv, v, { duration: 1.1, ease: [0.22, 1, 0.36, 1] });
    return () => controls.stop();
  }, [mv, v]);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (v / 100) * c;
  const strokeColor =
    tone === "mint" ? "rgb(var(--mint))" : tone === "accent" ? "rgb(var(--accent))" : "url(#ringGrad)";

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgb(var(--accent))" />
            <stop offset="100%" stopColor="rgb(var(--mint))" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--ring-track))" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={strokeColor}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <motion.span className="text-2xl font-bold tabular-nums text-ink">{rounded}</motion.span>
        {label && <span className={cn("text-[10px] uppercase tracking-wider text-ink-muted")}>{label}</span>}
        {sublabel && <span className="mt-0.5 text-[10px] text-ink-faint">{sublabel}</span>}
      </div>
    </div>
  );
}
