import { useRef, type HTMLAttributes } from "react";
import { useReducedMotion } from "framer-motion";
import { cn } from "../../lib/cn";

/**
 * Card with a cursor-following radial glow (ReactBits-style spotlight) — a more
 * premium replacement for the flat blue hover-glow. The pointer position feeds
 * two CSS vars; reduced-motion skips the tracking (the card still lifts/borders
 * on hover). Wrap in a Link/button for navigation; it stays presentational.
 */
export default function SpotlightCard({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    if (reduce || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    ref.current.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
    ref.current.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
  }

  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      className={cn(
        "group relative overflow-hidden rounded-xl2 border border-line bg-gradient-to-b from-panel to-panel/70 shadow-card",
        "transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-glow",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            "radial-gradient(220px circle at var(--mx, 50%) var(--my, 0%), rgb(var(--accent) / 0.16), transparent 60%)",
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
