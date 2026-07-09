import { cn } from "../../lib/cn";

/**
 * One radial spark burst (ReactBits ClickSpark, DOM/CSS port — no canvas).
 * Purely presentational: position it absolutely at the point of impact inside
 * a `relative` container and unmount it after ~450 ms. `Button` spawns these
 * on primary-action clicks; success toasts fire one on entry.
 *
 * The `animate-spark` keyframes live in tailwind.config.js; the global
 * reduced-motion killswitch in styles.css collapses them to nothing.
 */
const SPARK_COUNT = 6;

interface SparkBurstProps {
  /** Offset from the container's top-left, in px. */
  x: number;
  y: number;
  /** Any CSS color; defaults to the soft accent. */
  color?: string;
  className?: string;
}

export default function SparkBurst({ x, y, color, className }: SparkBurstProps) {
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute", className)}
      style={{ left: x, top: y }}
    >
      {Array.from({ length: SPARK_COUNT }, (_, i) => (
        <span
          key={i}
          className="absolute -ms-px -mt-1 block h-2 w-0.5 origin-center animate-spark rounded-full"
          style={{
            ["--a" as string]: `${(360 / SPARK_COUNT) * i}deg`,
            background: color ?? "rgb(var(--accent-soft))",
          }}
        />
      ))}
    </span>
  );
}
