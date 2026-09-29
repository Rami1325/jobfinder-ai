import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";

interface Props {
  /** The one line that is always shown. */
  line: ReactNode;
  /** The rest, shown under "Why?". */
  why: ReactNode;
  className?: string;
}

/**
 * A line, and the paragraph behind it under "Why?" (PLAN 31.7).
 *
 * Several notes were a paragraph at 12 px under the thing they explain, four
 * lines of it on a phone, read once and scrolled past every visit after. The
 * line says what is true; "Why?" says the rest where it is asked for. The rest
 * is REVEALED, never height-animated (check-mirrors 11's rule, and
 * `Disclosure`'s reason): it mounts with the house `fade-up`, which touches only
 * opacity and transform. A plain `<button>`, not the `Button` component, whose
 * spark burst is wrong for a word inside a sentence.
 *
 * "Why?" is a 44 px target at its old size (the second tap-target pass,
 * 2026-09-29): the word stays a word in the sentence, and `tap-44` (styles.css)
 * lays a transparent 44 x 44 layer over it, which reaches about 12 px above and
 * below its 20 px line and 7 px each side. It was a 30 x 20 target; a box would
 * have grown every line that ends in "Why?" to 44 px. Nothing here may clip the
 * layer (no `truncate`, no overflow), and where the note sits the layer must lie
 * over words or a gap, never a control: measured under the paper and under the
 * search card's worldwide line, whose presets keep their label first for this
 * (check-mirrors 112, 113).
 */
export default function WhyNote({ line, why, className }: Props) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={cn("text-xs leading-relaxed text-ink-faint", className)}>
      <p>
        {line}{" "}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="tap-44 font-medium text-accent-soft underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          {open ? t("why.hide") : t("why.show")}
        </button>
      </p>
      {open && (
        <p id={id} className="mt-1 animate-fade-up">
          {why}
        </p>
      )}
    </div>
  );
}
