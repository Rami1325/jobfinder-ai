import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";

/**
 * Text that resolves out of a scramble, start to finish (ReactBits
 * "Decrypted Text"). Used the first time a machine-rewritten line appears —
 * it honestly dramatizes "the model wrote this" — never on static copy.
 *
 * Script-agnostic: the scramble pool is the text's own characters, so Hebrew
 * scrambles as Hebrew. Whitespace is preserved so the word-shape stays put
 * and layout never shifts. Reduced motion renders the plain text.
 */
interface DecryptTextProps {
  text: string;
  /** Total resolve time in ms. */
  duration?: number;
  /** Delay before resolving starts, in ms (text scrambles while waiting). */
  delay?: number;
  className?: string;
}

export default function DecryptText({
  text,
  duration = 400,
  delay = 0,
  className,
}: DecryptTextProps) {
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(() => (reduce ? text : scramble(text, 0)));

  useEffect(() => {
    if (reduce) {
      setDisplay(text);
      return;
    }
    let raf = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - start) / duration));
      setDisplay(scramble(text, p));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, duration, delay, reduce]);

  return (
    <span className={className} aria-label={text}>
      <span aria-hidden>{display}</span>
    </span>
  );
}

/** First `progress` share of chars resolved; the rest shuffled from the text's own pool. */
function scramble(text: string, progress: number): string {
  const pool = text.replace(/\s/g, "");
  if (!pool) return text;
  const resolved = Math.floor(progress * text.length);
  let out = text.slice(0, resolved);
  for (let i = resolved; i < text.length; i++) {
    const ch = text[i];
    out += /\s/.test(ch) ? ch : pool[(Math.random() * pool.length) | 0];
  }
  return out;
}
