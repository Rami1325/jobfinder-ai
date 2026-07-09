import { motion } from "framer-motion";
import { cn } from "../../lib/cn";

/**
 * Tiny inline trend line for dense metric rows (Helios-style "dense but
 * legible"). Stroke follows `currentColor` — set the tone with a text-*
 * class on the parent. Draws itself once on mount; time flows with the
 * reading direction (mirrored under RTL like the app's arrows).
 */
interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  strokeWidth?: number;
  className?: string;
}

export default function Sparkline({
  values,
  width = 96,
  height = 28,
  strokeWidth = 2,
  className,
}: SparklineProps) {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const pad = strokeWidth;
  const d = values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (width - pad * 2);
      const y = height - pad - ((v - min) / span) * (height - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      className={cn("shrink-0 overflow-visible rtl:-scale-x-100", className)}
    >
      <motion.path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
      />
    </svg>
  );
}
