import { useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";

interface Props {
  /** Rendered inside the trigger button — badges, counts, a title. */
  summary: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Accessible name for the trigger when `summary` is not plain text. */
  label?: string;
  children: ReactNode;
  className?: string;
  /** Trigger padding — `tight` for rows inside a card, `roomy` standalone. */
  density?: "tight" | "roomy";
}

/**
 * A controlled disclosure row.
 *
 * DELIBERATELY NOT ANIMATED, and that is the second attempt. The first version
 * copied `marketing/FAQ.tsx`'s `AnimatePresence` + `height: 0 → "auto"` tween.
 * Driving the real review panel showed the failure: a group that mounts already
 * open renders correctly (AnimatePresence skips the enter animation), but any
 * group the user OPENS BY CLICKING wedges at `height: 0px` with its content
 * present underneath — `scrollHeight` 1,987 px, `getBoundingClientRect().height`
 * zero. Not reduced-motion (verified off) and not an HMR artifact (reproduced on
 * a clean load).
 *
 * A collapsed-forever disclosure is a total failure of the one panel whose job
 * is revealing what the AI did, so this trades the slide for content that is
 * always in the layout. It reuses the house `fade-up`, which touches only
 * opacity and transform and therefore cannot wedge a height — and which
 * `styles.css`'s reduced-motion rule already neutralises, so the
 * `useReducedMotion` special-casing goes with it.
 *
 * `open` is owned by the caller on purpose: the review panel re-renders on every
 * accept/decline, and local state would either reset what the user opened or
 * need a key dance to avoid it.
 *
 * A plain `<button>`, never the `Button` component — that one fires a
 * `SparkBurst` on pointer-down, which is wrong for a row that expands. The
 * chevron rotates and is never mirrored: `rotate-180` reads correctly in both
 * directions, and `-scale-x` on a chevron is how you get an up-arrow in RTL.
 */
export default function Disclosure({
  summary,
  open,
  onToggle,
  label,
  children,
  className,
  density = "tight",
}: Props) {
  const id = useId();
  return (
    <div className={cn("overflow-hidden rounded-xl2 border border-line", className)}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        aria-label={label}
        id={`${id}-button`}
        className={cn(
          "flex w-full items-center justify-between gap-3 text-start transition",
          "hover:bg-panel-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70",
          // 44 px at least (the third tap-target pass): a tight one is ~41.
          density === "tight" ? "min-h-11 px-3 py-2.5" : "px-5 py-4",
        )}
      >
        <span className="min-w-0 flex-1">{summary}</span>
        <ChevronDown
          size={16}
          aria-hidden
          className={cn("shrink-0 text-ink-faint transition-transform duration-200", open && "rotate-180")}
        />
      </button>
      {open && (
        <div
          id={`${id}-panel`}
          role="region"
          aria-labelledby={`${id}-button`}
          className="animate-fade-up"
        >
          {children}
        </div>
      )}
    </div>
  );
}
