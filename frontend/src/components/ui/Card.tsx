import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  glow?: boolean;
  glass?: boolean;
}

/** Elevated surface. Replaces the old `.panel` class with a premium finish. */
export default function Card({ glow, glass, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-xl2 border border-line p-5",
        glass
          ? "bg-panel/60 backdrop-blur-xl"
          : "bg-gradient-to-b from-panel to-panel/80",
        glow ? "shadow-glow" : "shadow-card",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2 className={cn("text-base font-semibold text-ink", className)} {...rest}>
      {children}
    </h2>
  );
}

export function SectionLabel({ className, children, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        "text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted",
        className,
      )}
      {...rest}
    >
      {children}
    </p>
  );
}
