import { useEffect, useRef, useState } from "react";
import { coverageOf } from "../api/client";
import type { CoverageResult, JDModel, ResumeModel } from "../types";

/**
 * Keyword coverage for the résumé as it stands RIGHT NOW.
 *
 * This is the one half of the match score that can honestly move as the user
 * accepts and declines edits: it is pure Python, deterministic and free. The
 * other half (`fit_score`) is a model sample and cannot move without spending,
 * which is why it is not here — a hook that could animate it would be animating
 * something nobody measured.
 *
 * NOT computed in TypeScript, and that is deliberate rather than lazy. The
 * server matcher tries the verbatim phrase first, which is what makes Hebrew
 * work: prefixes glue to the word (ב/ל/ה/ו/מ/ש), so "פייתון" has to match
 * inside "בפייתון". `lib/keywords.ts` wraps the needle in token-boundary
 * guards, which makes exactly that case miss. One matcher, one number.
 * `scripts/check-mirrors.js` fails the build if a second one appears.
 */
export function useCoverage(
  resume: ResumeModel | null,
  jd: JDModel | null,
): { data: CoverageResult | null; stale: boolean; failed: boolean } {
  const [data, setData] = useState<CoverageResult | null>(null);
  const [stale, setStale] = useState(false);
  const [failed, setFailed] = useState(false);
  // The last good number stays on screen while a new one is in flight, so the
  // ring dims rather than dropping to zero on every decision.
  const seen = useRef(false);

  useEffect(() => {
    if (!resume || !jd) return;
    setStale(seen.current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      coverageOf(resume, jd, ctrl.signal)
        .then((r) => {
          setData(r);
          setFailed(false);
          seen.current = true;
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setFailed(true); // an abort is a newer request winning
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setStale(false);
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [resume, jd]);

  return { data, stale, failed };
}
