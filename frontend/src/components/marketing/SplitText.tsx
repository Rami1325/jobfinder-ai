import { Fragment } from "react";
import { motion, useReducedMotion } from "framer-motion";

interface SplitTextProps {
  text: string;
  className?: string;
  /** Seconds before the first word starts. */
  delay?: number;
  /** Seconds between word starts. */
  stagger?: number;
}

/**
 * ReactBits-style Split/Blur Text: each word rises 14px, unblurs (8px → 0)
 * and fades in, staggered in string order — which is what makes Hebrew (RTL)
 * read naturally too: the first word is always the inline-start word.
 * Runs once on mount; reduced motion renders the plain string.
 *
 * Screen readers get the unsplit string (sr-only); the animated word spans
 * are aria-hidden. Words are inline-block with normal spaces between them,
 * so line wrapping stays natural.
 */
export default function SplitText({ text, className, delay = 0, stagger = 0.08 }: SplitTextProps) {
  const reduce = useReducedMotion();
  if (reduce) return <span className={className}>{text}</span>;
  const words = text.trim().split(/\s+/);
  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {words.map((word, i) => (
          <Fragment key={`${word}-${i}`}>
            <motion.span
              className="inline-block will-change-[transform,filter]"
              initial={{ opacity: 0, y: 14, filter: "blur(8px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1], delay: delay + i * stagger }}
            >
              {word}
            </motion.span>
            {i < words.length - 1 && " "}
          </Fragment>
        ))}
      </span>
    </span>
  );
}
