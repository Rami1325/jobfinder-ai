import { Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";

/**
 * How excited the person is about a job, 1 to 5 stars, as ONE tappable control
 * (the phone polish pass, 2026-09-28), on a tracker card and on a job's page.
 *
 * It was five star buttons, 17 px each on a card (28 x 36 on the job page),
 * side by side: a hit area cannot grow past a neighbour's, so five 44 px
 * targets would need 220 px, more than a board card has (149 px inside at
 * `xl`). So the stars only SHOW the rating now, at their old size, and a native
 * select lies over them, transparent, 44 px tall and as wide as the stars (the
 * status chip's pattern, `tracker.md`): a phone opens its own picker, a screen
 * reader hears "Excitement, 3 stars", and "No rating" clears it. The select is
 * centred on the stars and overhangs a 17 px row, so a card keeps its height.
 */
export default function RatingSelect({
  value,
  onRate,
  className,
}: {
  value: number;
  onRate: (n: number) => void;
  className?: string;
}) {
  const { t } = useTranslation("tracker");
  const rating = Math.max(0, Math.min(5, Math.round(value || 0)));
  return (
    <span
      className={cn(
        "relative inline-flex items-center rounded-md has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/70",
        className,
      )}
    >
      <span aria-hidden className="flex items-center gap-0.5 p-0.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <Star
            key={n}
            size={13}
            fill={n <= rating ? "currentColor" : "none"}
            className={n <= rating ? "text-warn" : "text-ink-faint/60"}
          />
        ))}
      </span>
      <select
        value={rating}
        aria-label={t("excitement.label")}
        title={t("excitement.title")}
        onChange={(e) => onRate(Number(e.target.value))}
        className="absolute inset-x-0 top-1/2 h-11 w-full -translate-y-1/2 cursor-pointer opacity-0"
      >
        <option value={0}>{t("excitement.none")}</option>
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={n}>
            {t("excitement.stars", { count: n })}
          </option>
        ))}
      </select>
    </span>
  );
}
