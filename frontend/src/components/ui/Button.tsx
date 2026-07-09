import { forwardRef, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import { cn } from "../../lib/cn";
import Spinner from "./Spinner";
import SparkBurst from "./ClickSpark";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-white shadow-glow hover:bg-accent-soft border border-transparent",
  secondary:
    "bg-panel-2 text-ink border border-line hover:border-accent/60 hover:bg-panel-2/80",
  ghost: "bg-transparent text-ink-muted border border-line hover:text-ink hover:border-accent/50",
  danger: "bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25",
};

const sizes: Record<Size, string> = {
  sm: "px-3 py-1.5 text-[13px] rounded-lg gap-1.5",
  md: "px-4 py-2.5 text-sm rounded-lg gap-2",
  lg: "px-6 py-3 text-[15px] rounded-xl gap-2",
};

type Burst = { id: number; x: number; y: number };

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading,
    icon,
    className,
    children,
    disabled,
    onPointerDown,
    ...rest
  },
  ref,
) {
  const reduce = useReducedMotion();
  const [bursts, setBursts] = useState<Burst[]>([]);
  const burstId = useRef(0);

  // Micro-feedback on primary actions only: a small radial spark burst at the
  // click point. Feedback, not confetti — pointer clicks, enabled state only.
  function handlePointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    onPointerDown?.(e);
    if (reduce || variant !== "primary" || disabled || loading) return;
    const r = e.currentTarget.getBoundingClientRect();
    const id = ++burstId.current;
    setBursts((b) => [...b, { id, x: e.clientX - r.left, y: e.clientY - r.top }]);
    window.setTimeout(() => setBursts((b) => b.filter((s) => s.id !== id)), 450);
  }

  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      onPointerDown={handlePointerDown}
      className={cn(
        "relative inline-flex items-center justify-center font-semibold transition-all duration-150 select-none",
        // Lift on hover, press back down on click (enabled buttons only).
        "will-change-transform enabled:hover:-translate-y-0.5 enabled:active:translate-y-0",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {bursts.map((b) => (
        <SparkBurst key={b.id} x={b.x} y={b.y} color="rgb(255 255 255 / 0.9)" />
      ))}
    </button>
  );
});

export default Button;
