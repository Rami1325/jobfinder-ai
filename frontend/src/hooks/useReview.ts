import { useEffect, useRef, useState } from "react";
import { reviewResume } from "../api/client";
import type { JDModel, ResumeModel, ReviewResult } from "../types";

/**
 * The deterministic resume review for the document as it stands RIGHT NOW.
 *
 * This is allowed to run on every keystroke for exactly the reason `useCoverage`
 * is: `POST /tools/review` is pure Python, deterministic and uncapped — it takes
 * no `Depends`, spends no tokens and writes no `usage_log` row — so a finding
 * disappearing as you type it away costs nothing. Anything that reaches the
 * model is the opposite of this: `POST /tools/review/rewrites` takes
 * `Depends(llm_user)` and is therefore a BUTTON on the panel, never a hook, and
 * `fit_score` is one timestamped sample that cannot move without spending. A
 * hook that debounced its way through the user's daily cap would be this repo's
 * `/tools/ats-scan` mistake in a new costume: that route reached the analyser
 * with no cap and no token row for months, thirty lines under a docstring
 * saying it called no model.
 *
 * ONE DIFFERENCE from `useCoverage`, and it is deliberate: that hook bails on
 * `!jd` because coverage against no job is not a number. **This one must NOT.**
 * The review's home is the master resume, where there is usually no job
 * attached at all — twenty-five of the twenty-six checks (dates, placeholders,
 * weak openers, duplicate credentials, the measured page count) are properties
 * of the CV alone. `jd` is passed through as `null` and the one JD-gated check
 * (`skills-unasked`) simply does not fire, landing in `skipped` rather than in
 * `passed`: a check that could not run is unknown, never clean. Guarding on
 * `jd` here would mean the panel stayed permanently empty on the one surface
 * the feature exists for.
 *
 * The last good result stays on screen while a new one is in flight (`seen`),
 * so the panel and its `bad` count dim rather than emptying on every keystroke
 * — an emptied panel reads as "you fixed everything", which is a lie told
 * mid-request. An abort is a newer request winning and is never an error.
 */
export function useReview(
  resume: ResumeModel | null,
  jd: JDModel | null,
): { data: ReviewResult | null; stale: boolean; failed: boolean } {
  const [data, setData] = useState<ReviewResult | null>(null);
  const [stale, setStale] = useState(false);
  const [failed, setFailed] = useState(false);
  // The last good findings stay on screen while a new set is in flight, so the
  // count badge dims rather than dropping to zero on every edit.
  const seen = useRef(false);

  useEffect(() => {
    // NO `|| !jd` here — see the docstring. The review runs on a resume with no
    // job attached, which is the master-document case and the common one.
    if (!resume) return;
    setStale(seen.current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      reviewResume(resume, jd, ctrl.signal)
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
