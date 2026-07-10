import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "../../lib/cn";

interface TypeTextProps {
  text: string;
  /** Milliseconds per character. */
  speed?: number;
  /** Milliseconds before the first character — for staggering lists. */
  delay?: number;
  className?: string;
}

/**
 * ReactBits-style typewriter (Text Type): renders `text` character by
 * character with a blinking caret that hides once typing finishes. Clicking
 * the text completes it instantly; reduced motion renders the final state at
 * once. Characters are emitted in string order, so RTL text (Hebrew) builds
 * correctly from its natural reading side. The full text is exposed to
 * assistive tech immediately via `aria-label`.
 *
 * Not exported from ui/index — import directly: `components/ui/TypeText`.
 */
export default function TypeText({ text, speed = 20, delay = 0, className }: TypeTextProps) {
  const reduce = useReducedMotion();
  // Array.from keeps surrogate pairs (emoji) intact while slicing.
  const chars = useMemo(() => Array.from(text), [text]);
  const [count, setCount] = useState(() => (reduce ? chars.length : 0));
  const done = count >= chars.length;

  // Restart when the text itself changes (regeneration reuses the same key).
  useEffect(() => {
    setCount(reduce ? chars.length : 0);
  }, [chars, reduce]);

  // One timeout per character: self-stopping, and a click-skip cancels it
  // naturally by jumping `count` past the loop condition.
  useEffect(() => {
    if (reduce || done) return;
    const id = window.setTimeout(
      () => setCount((c) => Math.min(c + 1, chars.length)),
      count === 0 ? delay : speed,
    );
    return () => window.clearTimeout(id);
  }, [count, done, chars.length, speed, delay, reduce]);

  return (
    <span aria-label={text} onClick={() => setCount(chars.length)} className={cn("cursor-default", className)}>
      <span aria-hidden="true">{chars.slice(0, count).join("")}</span>
      {!done && (
        <motion.span
          aria-hidden="true"
          animate={{ opacity: [1, 1, 0, 0] }}
          transition={{ duration: 0.8, times: [0, 0.5, 0.5, 1], repeat: Infinity }}
          className="mx-0.5 inline-block h-[1em] w-0.5 translate-y-[0.15em] rounded-full bg-accent-soft"
        />
      )}
    </span>
  );
}
