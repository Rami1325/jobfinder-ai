import { cn } from "../../lib/cn";

/** Shimmering placeholder for loading states. */
export default function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg bg-panel-2/70",
        "after:absolute after:inset-0 after:-translate-x-full after:animate-shimmer",
        "after:bg-gradient-to-r after:from-transparent after:via-ink/10 after:to-transparent",
        className,
      )}
    />
  );
}
