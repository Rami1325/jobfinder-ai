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
          className="font-medium text-accent-soft underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
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
