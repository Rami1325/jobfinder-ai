import { useEffect, useRef, useState } from "react";
import { pageCount } from "../api/client";
import type { PageCountResult, ResumeModel } from "../types";
import type { ResumeTemplate } from "../api/client";

/**
 * How many pages the resume the user is about to download actually renders to.
 *
 * MEASURED, never derived. Restoring something the page budget cut produces a
 * document nothing has ever measured — the trimmed resume plus the *master's*
 * full version of the restored item, which is larger than the compressed one
 * the budget was looking at. Arithmetic on `length_report.pages_before/after`
 * would be a guess, and the whole point of the badge is that it isn't one.
 *
 * The route is deterministic and uncapped, but it is a real reportlab build
 * (~15 ms server-side), so this debounces and aborts in flight — Accept all /
 * Reject all must not fire one request per edit.
 */
export function usePageCount(
  resume: ResumeModel | null,
  template: ResumeTemplate,
  enabled = true,
): { data: PageCountResult | null; stale: boolean; failed: boolean } {
  const [data, setData] = useState<PageCountResult | null>(null);
  const [stale, setStale] = useState(false);
  const [failed, setFailed] = useState(false);
  // Keeps the last good number on screen while a new one is in flight, so the
  // badge dims rather than disappearing on every keystroke-fast decision.
  const seen = useRef(false);

  useEffect(() => {
    if (!enabled || !resume) return;
    setStale(seen.current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      pageCount(resume, template, ctrl.signal)
        .then((r) => {
          setData(r);
          setFailed(false);
          seen.current = true;
        })
        .catch((e: unknown) => {
          // An aborted request is a newer one winning, not a failure.
          if (ctrl.signal.aborted) return;
          setFailed(true);
          void e;
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setStale(false);
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [resume, template, enabled]);

  return { data, stale, failed };
}
