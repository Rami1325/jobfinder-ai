import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useTheme } from "../hooks/useTheme";

// Lazy so the (heavy) three.js chunk only downloads when the pillar actually
// renders — i.e. on the dark-theme landing, never on the app pages.
const LightPillar = lazy(() => import("./LightPillar"));

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * Fixed, full-viewport light-pillar backdrop for the marketing site. Gated to
 * the dark theme (looks best on the dark palette) and skipped under
 * reduced-motion — in both cases the page keeps its static hero glow.
 *
 * Performance: the pillar is only near the hero, so we pause the shader while
 * the user is actively scrolling and whenever they've scrolled past the hero.
 * That keeps the GPU off the scroll critical path — the reported jank.
 */
export default function PillarBackground() {
  const { theme } = useTheme();
  const reduced = usePrefersReducedMotion();
  const [paused, setPaused] = useState(false);
  const scrollingRef = useRef(false);

  useEffect(() => {
    if (theme !== "dark" || reduced) return;
    let ticking = false;
    let stopTimer: number | undefined;
    const pastHero = () => window.scrollY > window.innerHeight * 0.85;
    const settle = () => {
      ticking = false;
      setPaused(scrollingRef.current || pastHero());
    };
    const onScroll = () => {
      scrollingRef.current = true;
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(settle);
      }
      window.clearTimeout(stopTimer);
      stopTimer = window.setTimeout(() => {
        scrollingRef.current = false;
        setPaused(pastHero());
      }, 140);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(stopTimer);
    };
  }, [theme, reduced]);

  if (theme !== "dark" || reduced) return null;

  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden>
      {/* Anchor the pillar to the upper-center; fade its base into the page. */}
      <div className="absolute inset-x-0 top-0 h-[110vh] [mask-image:linear-gradient(to_bottom,#000_58%,transparent_92%)]">
        <Suspense fallback={null}>
          <LightPillar intensity={1.0} pillarWidth={2.6} paused={paused} />
        </Suspense>
      </div>
    </div>
  );
}
