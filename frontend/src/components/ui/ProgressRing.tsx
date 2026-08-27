import { useEffect, useRef } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "framer-motion";
import { cn } from "../../lib/cn";

/** The house curve. Same tuple as everywhere else in the app. */
const EASE = [0.22, 1, 0.36, 1] as const;
/** First paint earns a reveal; a recomputed value gets a settle. */
const REVEAL_S = 0.9;
const SETTLE_S = 0.25;

interface ProgressRingProps {
  /** 0-100, or `null` when there is nothing to measure yet.
   *
   * `null` is not a styling nicety. 0/0 is undefined, not zero, and rendering
   * it as "0%" states a measurement nobody took: a user in their first week
   * with no applications sent was being told their response rate was 0%. */
  value: number | null;
  size?: number;
  stroke?: number;
  label?: string;
  sublabel?: string;
  tone?: "accent" | "mint" | "gradient";
  /** Seconds before the sweep + count start — lets callers sequence rings into one beat. */
  delay?: number;
}

/** Animated circular score gauge. */
export default function ProgressRing({
  value,
  size = 120,
  stroke = 10,
  label,
  sublabel,
  tone = "gradient",
  delay = 0,
}: ProgressRingProps) {
  const known = value !== null && Number.isFinite(value);
  const v = known ? Math.max(0, Math.min(100, value as number)) : 0;

  // Reduced motion means REDUCED MOTION, not a shorter wait for the same
  // motion. It used to zero only the choreography delay, so a user who asked
  // their phone for less movement still got a 1.1s sweep and a spinning
  // counter — it just started sooner.
  const reduced = useReducedMotion();
  const wait = reduced ? 0 : delay;
  // A ring that replays its full reveal every time the number changes turns a
  // recomputed value into a wait. Coverage recomputes on every accept and
  // every decline, so that was 1.1s of spinning to land two digits the server
  // had already sent. Reveal once; settle thereafter.
  const firstRef = useRef(true);
  const dur = reduced ? 0 : firstRef.current ? REVEAL_S : SETTLE_S;
  useEffect(() => {
    firstRef.current = false;
  }, []);

  // Count the center number up in sync with the ring sweep.
  const mv = useMotionValue(0);
  const rounded = useTransform(mv, (x) => Math.round(x));
  useEffect(() => {
    if (!known) {
      mv.set(0);
      return;
    }
    const controls = animate(mv, v, { duration: dur, ease: EASE, delay: wait });
    return () => controls.stop();
  }, [mv, v, wait, dur, known]);

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
        {/* Nothing measured, nothing drawn — the bare track carries "no data"
            without a value-coloured arc implying one. */}
        {known && (
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
            transition={{ duration: dur, ease: EASE, delay: wait }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {known ? (
          <motion.span className="text-2xl font-bold tabular-nums text-ink">{rounded}</motion.span>
        ) : (
          <span aria-label={sublabel} className="text-2xl font-bold text-ink-faint">
            —
          </span>
        )}
        {label && <span className={cn("text-[10px] uppercase tracking-wider text-ink-muted")}>{label}</span>}
        {sublabel && <span className="mt-0.5 text-[10px] text-ink-faint">{sublabel}</span>}
      </div>
    </div>
  );
}
