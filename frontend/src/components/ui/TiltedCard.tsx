import { useRef, type ReactNode } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring } from "framer-motion";
import { cn } from "../../lib/cn";
import SpotlightCard from "./SpotlightCard";

/**
 * Premium clickable card: a ReactBits-style 3D tilt that follows the cursor
 * (https://reactbits.dev/components/tilted-card) wrapped around our existing
 * SpotlightCard surface (border + gradient + cursor glow). An optional
 * `caption` — the card's name — floats near the pointer over the card, like
 * the ReactBits figcaption.
 *
 * Wrap in a Link/button for navigation; it stays presentational. Pointer-only
 * by design: the tilt needs mouse events (touch taps never fire them) and the
 * caption is desktop-only; reduced-motion users get the flat SpotlightCard.
 */
const TILT = { stiffness: 120, damping: 30, mass: 1.2 } as const;
const FLOAT = { stiffness: 350, damping: 30, mass: 1 } as const;
const AMPLITUDE = 10; // max tilt in degrees at the card edges
const SCALE_ON_HOVER = 1.03;

interface Props {
  /** The card's name, shown floating near the cursor while hovering. */
  caption?: ReactNode;
  /** Forwarded to the inner SpotlightCard surface (padding, layout, etc.). */
  className?: string;
  children: ReactNode;
}

export default function TiltedCard({ caption, className, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const lastY = useRef(0);
  const reduce = useReducedMotion();

  const rotateX = useSpring(useMotionValue(0), TILT);
  const rotateY = useSpring(useMotionValue(0), TILT);
  const scale = useSpring(1, TILT);

  // Cursor-following name caption.
  const capX = useMotionValue(0);
  const capY = useMotionValue(0);
  const capOpacity = useSpring(0, FLOAT);
  const capRotate = useSpring(0, FLOAT);

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    if (reduce || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const offX = e.clientX - r.left - r.width / 2;
    const offY = e.clientY - r.top - r.height / 2;
    rotateX.set((offY / (r.height / 2)) * -AMPLITUDE);
    rotateY.set((offX / (r.width / 2)) * AMPLITUDE);
    capX.set(e.clientX - r.left + 14);
    capY.set(e.clientY - r.top + 12);
    // Tilt the caption a touch based on vertical velocity, clamped so it never spins.
    capRotate.set(Math.max(-8, Math.min(8, -(offY - lastY.current) * 0.4)));
    lastY.current = offY;
  }

  function onEnter() {
    if (reduce) return;
    scale.set(SCALE_ON_HOVER);
    capOpacity.set(1);
  }

  function onLeave() {
    rotateX.set(0);
    rotateY.set(0);
    scale.set(1);
    capOpacity.set(0);
    capRotate.set(0);
  }

  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="relative h-full [perspective:1000px]"
    >
      <motion.div
        style={{ rotateX, rotateY, scale, transformStyle: "preserve-3d" }}
        className="h-full will-change-transform"
      >
        <SpotlightCard className={cn("h-full", className)}>{children}</SpotlightCard>
      </motion.div>

      {caption != null && (
        <motion.span
          aria-hidden
          style={{ x: capX, y: capY, opacity: capOpacity, rotate: capRotate }}
          className="pointer-events-none absolute left-0 top-0 z-10 hidden whitespace-nowrap rounded-md bg-ink px-2.5 py-1 text-[11px] font-semibold text-bg shadow-lg sm:block"
        >
          {caption}
        </motion.span>
      )}
    </div>
  );
}
