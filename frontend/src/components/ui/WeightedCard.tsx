import { useRef, type ReactNode } from "react";
import { motion, useReducedMotion, useSpring } from "framer-motion";
import { cn } from "../../lib/cn";

/**
 * A card that bears the cursor's WEIGHT — the counterpart to TiltedCard.
 *
 * TiltedCard lifts: same cursor-following rotation, but it scales UP so the
 * whole surface reads as floating toward the viewer. This one does the
 * opposite, because a resume is a sheet of paper lying on a desk, not a
 * hologram. Put a finger on a sheet of paper and it doesn't rise: the corner
 * under the finger goes DOWN, the sheet pivots around the contact point, and
 * the shadow beneath that corner tightens and darkens as the gap closes. Lift
 * the finger and the paper springs back past flat before it settles — that
 * overshoot is the only part of the motion that tells you the sheet has mass.
 *
 * So: the same rotation formulas and the same TILT spring as TiltedCard (one
 * motion language, not two), a negative translateZ instead of a scale-up, and
 * an under-damped LOAD spring on the depth so the release overshoots.
 *
 * The shadow is the hard part, because `box-shadow` is a paint property and
 * animating it would drag every frame off the compositor — the rule
 * `.css-pillar` states in styles.css. Two STATIC shadows are stacked instead
 * (`.wc-shadow-rest`, the resting document lift; `.wc-shadow-press`, a tight
 * dark contact shadow) and only their OPACITY crossfades, plus a few px of
 * translate toward the pointer so the contact reads as being under the
 * depressed edge. Transform and opacity only, the whole way down.
 *
 * Pointer-only by design: touch never fires mouse events, so the resting state
 * has to be the finished state. It is — reduced-motion users and every touch
 * device get exactly the document lift the cards had before this existed, and
 * the shadow layers are `pointer-events: none`, so nothing traps a tap.
 */

/** TiltedCard's tracking spring, verbatim — overdamped, so the tilt never wobbles. */
const TILT = { stiffness: 120, damping: 30, mass: 1.2 } as const;
/** Under-damped (ζ ≈ 0.42): the depth springs back past rest on release. */
const LOAD = { stiffness: 260, damping: 14, mass: 1.05 } as const;
/** TiltedCard's FLOAT spring — quick and clean, for the shadow crossfade. */
const CONTACT = { stiffness: 350, damping: 30, mass: 1 } as const;

const AMPLITUDE = 8; // max tilt in degrees at the card edges
const PRESS_Z = -16; // px into the page under the cursor
const PRESS_Y = 3; // px of settle, so the card sits down as well as back
const CONTACT_SHIFT = 6; // px the contact shadow slides toward the pointer
const REST_SHADOW_UNDER_LOAD = 0.25;

interface Props {
  /** Classes for the card surface itself — radius, background, ring. */
  className?: string;
  /** Classes for the perspective wrapper — outer rotation, sizing, margins. */
  wrapperClassName?: string;
  children: ReactNode;
}

export default function WeightedCard({ className, wrapperClassName, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  /** True only between a real pointer's enter and leave. */
  const engaged = useRef(false);

  const rotateX = useSpring(0, TILT);
  const rotateY = useSpring(0, TILT);
  const z = useSpring(0, LOAD);
  const y = useSpring(0, LOAD);

  const restOpacity = useSpring(1, CONTACT);
  const pressOpacity = useSpring(0, CONTACT);
  const shadowX = useSpring(0, CONTACT);
  const shadowY = useSpring(0, CONTACT);

  /** Coarse pointers synthesize mouse events on tap; a fine pointer is the gate. */
  function finePointer() {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  }

  function onEnter() {
    if (reduce || !finePointer()) return;
    engaged.current = true;
    z.set(PRESS_Z);
    y.set(PRESS_Y);
    restOpacity.set(REST_SHADOW_UNDER_LOAD);
    pressOpacity.set(1);
  }

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!engaged.current || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    // -1 … 1 from the card's centre.
    const nx = (e.clientX - r.left - r.width / 2) / (r.width / 2);
    const ny = (e.clientY - r.top - r.height / 2) / (r.height / 2);
    // Same signs as TiltedCard: the edge under the cursor is the one that
    // recedes. There it reads as a lift because the card also scales up; here,
    // with the whole surface pushed back on Z, it reads as load.
    rotateX.set(-ny * AMPLITUDE);
    rotateY.set(nx * AMPLITUDE);
    shadowX.set(nx * CONTACT_SHIFT);
    shadowY.set(ny * CONTACT_SHIFT);
  }

  function onLeave() {
    engaged.current = false;
    rotateX.set(0);
    rotateY.set(0);
    z.set(0);
    y.set(0);
    restOpacity.set(1);
    pressOpacity.set(0);
    shadowX.set(0);
    shadowY.set(0);
  }

  return (
    <div
      onMouseEnter={onEnter}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={cn("relative [perspective:900px]", wrapperClassName)}
    >
      <motion.div
        ref={ref}
        style={{ rotateX, rotateY, z, y, transformStyle: "preserve-3d" }}
        className={cn("relative", className)}
      >
        {/* Painted before the surface, so both sit behind it. */}
        <motion.span aria-hidden className="wc-shadow wc-shadow-rest" style={{ opacity: restOpacity }} />
        <motion.span
          aria-hidden
          className="wc-shadow wc-shadow-press"
          style={{ opacity: pressOpacity, x: shadowX, y: shadowY }}
        />
        <div className="relative overflow-hidden rounded-[inherit]">{children}</div>
      </motion.div>
    </div>
  );
}
