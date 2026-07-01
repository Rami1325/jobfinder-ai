import { Check } from "lucide-react";
import { cn } from "../../lib/cn";

interface StepperProps {
  steps: string[];
  current: number; // 0-based index of the active step
}

/** Horizontal progress stepper for the tailor flow. */
export default function Stepper({ steps, current }: StepperProps) {
  return (
    <ol className="flex items-center gap-2">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                  done && "border-mint bg-mint/20 text-mint",
                  active && "border-accent bg-accent/20 text-accent-soft shadow-glow",
                  !done && !active && "border-line bg-panel-2 text-ink-faint",
                )}
              >
                {done ? <Check size={14} /> : i + 1}
              </span>
              <span
                className={cn(
                  "text-sm font-medium",
                  active ? "text-ink" : done ? "text-ink-muted" : "text-ink-faint",
                )}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                className={cn(
                  "hidden h-px flex-1 sm:block",
                  i < current ? "bg-mint/50" : "bg-line",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
