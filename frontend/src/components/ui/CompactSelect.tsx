import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * A small select that is a 44 px target (the third tap-target pass, 2026-10-01):
 * the sort above the saved matches and above the tracker's phone list.
 *
 * A select cannot wear `tap-44` (a replaced element draws no `::after`), and a
 * 44 px box would grow the row it sits in by 14-18 px, moving the first job or
 * the first application down. So it is RatingSelect's and the status chip's
 * pattern: a small face shows the choice, and the native select lies over it,
 * transparent, 44 px tall and centred, overhanging the face by 9 px above and
 * below. A phone opens its own picker and a screen reader hears the select.
 * The face reserves the widest option (every label stacked in one grid cell,
 * only the chosen one visible), so changing the sort never moves its row.
 *
 * Name it from outside: wrap it in a `<label>` with the visible words, as both
 * callers do.
 */
export default function CompactSelect<V extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: V;
  onChange: (value: V) => void;
  options: { value: V; label: string }[];
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex items-center gap-1 rounded-lg border border-line bg-bg-soft px-2 py-1 text-xs text-ink",
        "has-[:focus-visible]:border-accent/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/70",
        className,
      )}
    >
      <span aria-hidden className="grid">
        {options.map((o) => (
          <span key={o.value} className={cn("col-start-1 row-start-1 whitespace-nowrap", o.value !== value && "invisible")}>
            {o.label}
          </span>
        ))}
      </span>
      <ChevronDown size={12} aria-hidden className="shrink-0 text-ink-faint" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as V)}
        className="absolute inset-x-0 top-1/2 h-11 w-full -translate-y-1/2 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}
