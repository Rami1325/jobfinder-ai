import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Tone = "neutral" | "accent" | "covered" | "partial" | "missing" | "danger" | "mint";

const tones: Record<Tone, string> = {
  neutral: "border-line bg-panel-2 text-ink-muted",
  accent: "border-accent/50 bg-accent/15 text-accent-soft",
  mint: "border-mint/50 bg-mint/15 text-mint",
  covered: "border-mint/50 bg-mint/15 text-mint",
  partial: "border-warn/50 bg-warn/15 text-warn",
  missing: "border-danger/50 bg-danger/10 text-danger",
  danger: "border-danger/50 bg-danger/15 text-danger",
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export default function Badge({ tone = "neutral", className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
