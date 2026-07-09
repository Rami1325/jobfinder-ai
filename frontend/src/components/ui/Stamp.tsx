import { type ReactNode } from "react";
import { motion } from "framer-motion";
import { cn } from "../../lib/cn";

/**
 * A rubber ink stamp that lands with a thunk — the guard's verdict made
 * physical (inspired by Fable-25's Form 27-B/6 "APPROVED, in triplicate").
 *
 * Spring: high stiffness, low-ish damping → one squash-and-settle
 * oscillation, like a stamp hitting paper. Under reduced motion the root
 * MotionConfig turns the transform into a plain crossfade automatically.
 *
 * Decorative by nature — always pair it with the textual state it echoes
 * (the GuardTile count, the kit status chip), never as the only signal.
 */
type Tone = "mint" | "danger" | "accent";

const tones: Record<Tone, string> = {
  mint: "border-mint text-mint",
  danger: "border-danger text-danger",
  accent: "border-accent text-accent",
};

interface StampProps {
  tone?: Tone;
  /** Seconds to hold before the stamp lands. */
  delay?: number;
  /** Resting rotation in degrees. */
  angle?: number;
  className?: string;
  children: ReactNode;
}

export default function Stamp({
  tone = "mint",
  delay = 0,
  angle = -6,
  className,
  children,
}: StampProps) {
  return (
    <motion.span
      aria-hidden
      initial={{ opacity: 0, scale: 1.7, rotate: angle - 9 }}
      animate={{ opacity: 0.92, scale: 1, rotate: angle }}
      transition={{ type: "spring", stiffness: 520, damping: 21, mass: 0.9, delay }}
      className={cn(
        "pointer-events-none inline-flex select-none items-center gap-1.5 whitespace-nowrap",
        "rounded-md border-[3px] border-double px-2.5 py-1",
        "text-[11px] font-extrabold uppercase leading-none tracking-[0.16em]",
        tones[tone],
        className,
      )}
    >
      {children}
    </motion.span>
  );
}
