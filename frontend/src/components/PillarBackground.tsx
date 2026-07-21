import { useEffect, useState } from "react";
import { useTheme } from "../hooks/useTheme";
import CssPillar from "./CssPillar";

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
 * CSS-only since PLAN 12.5e: the previous WebGL raymarcher put every
 * dark-theme visitor one lazy chunk away from 466 kB of three.js and needed
 * scroll-pause plumbing to keep the GPU off the scroll critical path. The
 * CssPillar layers animate transform/opacity only, so neither is needed.
 */
export default function PillarBackground() {
  const { theme } = useTheme();
  const reduced = usePrefersReducedMotion();

  if (theme !== "dark" || reduced) return null;

  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden>
      {/* Anchor the pillar to the upper-center; fade its base into the page. */}
      <div className="absolute inset-x-0 top-0 h-[110vh] [mask-image:linear-gradient(to_bottom,#000_58%,transparent_92%)]">
        <CssPillar />
      </div>
    </div>
  );
}
