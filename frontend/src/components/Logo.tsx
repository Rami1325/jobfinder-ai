import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useInRouterContext, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";

interface LogoProps {
  /** Pixel size of the square mark. */
  size?: number;
  withWordmark?: boolean;
  className?: string;
}

const DOT_CLASS = "ms-[3px] inline-block h-[5px] w-[5px] rounded-full bg-accent";

/**
 * The wordmark's accent dot — the one "personality" motion in the shell:
 * a single small spring bounce on every route change. Decorative only
 * (aria-hidden); static under reduced motion. Must only render inside a
 * Router (it reads the location).
 */
function BouncingDot() {
  const { pathname } = useLocation();
  const reduce = useReducedMotion();
  const [beat, setBeat] = useState(0);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false; // no bounce on initial mount, only on navigation
      return;
    }
    setBeat((b) => b + 1);
  }, [pathname]);

  if (reduce) return <span aria-hidden="true" className={DOT_CLASS} />;
  return (
    <motion.span
      key={beat}
      aria-hidden="true"
      className={DOT_CLASS}
      animate={beat > 0 ? { scale: [1, 1.35, 1] } : undefined}
      transition={{ duration: 0.35, times: [0, 0.45, 1], ease: [0.22, 1, 0.36, 1] }}
    />
  );
}

/**
 * Brand mark — a tailored-résumé monogram (document + verified check) in the
 * accent→mint gradient, optionally followed by the wordmark and its accent
 * dot. Reused across the app shell, marketing header, and access gate so the
 * identity stays coherent.
 */
export default function Logo({ size = 30, withWordmark = true, className }: LogoProps) {
  const { t } = useTranslation();
  const inRouter = useInRouterContext();
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        aria-hidden="true"
        className="grid shrink-0 place-items-center rounded-[10px] bg-accent-gradient text-white shadow-glow"
        style={{ width: size, height: size }}
      >
        <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62}>
          <path
            d="M6.5 3h6l4.5 4.5V18a2 2 0 0 1-2 2h-8.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
            fill="#fff"
            fillOpacity="0.96"
          />
          <path
            d="M12.5 3v4.5H17"
            fill="none"
            stroke="rgb(var(--accent-deep))"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path
            d="m8.6 13.4 2.3 2.3 4.2-4.6"
            fill="none"
            stroke="rgb(var(--accent-deep))"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {withWordmark && (
        <span className="text-[15px] font-bold tracking-[-0.02em] text-ink">
          {t("appName")}
          {inRouter ? <BouncingDot /> : <span aria-hidden="true" className={DOT_CLASS} />}
        </span>
      )}
    </span>
  );
}
