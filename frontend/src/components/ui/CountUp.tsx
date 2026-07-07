import { useEffect, useState } from "react";
import { animate, useReducedMotion } from "framer-motion";

interface CountUpProps {
  to: number;
  duration?: number;
  suffix?: string;
  className?: string;
}

/**
 * Animated number that counts up from 0 on mount (ReactBits-style), pairing the
 * plain stat tiles with the animated ProgressRings. Honors reduced-motion by
 * jumping straight to the final value.
 */
export default function CountUp({ to, duration = 1.1, suffix = "", className }: CountUpProps) {
  const reduce = useReducedMotion();
  const [val, setVal] = useState(reduce ? to : 0);

  useEffect(() => {
    if (reduce) {
      setVal(to);
      return;
    }
    const controls = animate(0, to, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setVal(v),
    });
    return () => controls.stop();
  }, [to, duration, reduce]);

  return (
    <span className={className}>
      {Math.round(val)}
      {suffix}
    </span>
  );
}
