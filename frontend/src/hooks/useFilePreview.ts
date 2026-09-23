import { useEffect, useRef, useState } from "react";
import { atsXray, renderPages, renderResumeBlob, type ResumeTemplate } from "../api/client";
import type { ATSXrayResult, PageImagesResult, ResumeModel } from "../types";

/**
 * The two "what does the real file look like" reads, both lazy and both
 * abortable.
 *
 * Lazy matters: rendering is a real reportlab build (~15 ms) and the x-ray
 * renders AND re-parses (~170 ms). Neither should fire because a panel exists —
 * only because its tab is showing. Both routes are deterministic and uncapped,
 * so the cost is latency, never money.
 *
 * Debounced for the same reason `usePageCount` is: accept/decline changes the
 * effective resume on every click, and a burst of Accept-all must not queue one
 * render per edit.
 */
const DEBOUNCE_MS = 400;

/** The rendered PDF as an object URL, or null while it is being built. */
export function usePdfPreview(
  resume: ResumeModel | null,
  template: ResumeTemplate,
  enabled: boolean,
): { url: string | null; loading: boolean; failed: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // Held in a ref so the revoke can happen in the effect's cleanup without
  // making `url` itself a dependency (which would revoke what it just set).
  const live = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !resume) return;
    setLoading(true);
    setFailed(false);
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      renderResumeBlob(resume, "pdf", template, ctrl.signal)
        .then((blob) => {
          if (ctrl.signal.aborted) return;
          const next = URL.createObjectURL(blob);
          if (live.current) URL.revokeObjectURL(live.current);
          live.current = next;
          setUrl(next);
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [resume, template, enabled]);

  // Revoke on unmount only. An object URL that outlives its page pins the whole
  // blob in memory, and a tailored PDF is not small.
  useEffect(
    () => () => {
      if (live.current) URL.revokeObjectURL(live.current);
      live.current = null;
    },
    [],
  );

  return { url, loading, failed };
}

/** The x-ray of the same file: rendered, then read back with our own parser. */
export function useXray(
  resume: ResumeModel | null,
  template: ResumeTemplate,
  enabled: boolean,
): { result: ATSXrayResult | null; loading: boolean; failed: boolean } {
  const [result, setResult] = useState<ATSXrayResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || !resume) return;
    setLoading(true);
    setFailed(false);
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      atsXray(resume, template, "pdf", ctrl.signal)
        .then((r) => {
          if (!ctrl.signal.aborted) setResult(r);
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [resume, template, enabled]);

  return { result, loading, failed };
}

/** The same file as page pictures, for a phone (PLAN 31.2/4): mobile browsers do
 * not draw a `blob:` PDF inside the page, so the view showed nothing of the file
 * whose job is to be seen. Lazy and debounced like the two above, and like them
 * deterministic and free: the cost is latency, never money. */
export function usePageImages(
  resume: ResumeModel | null,
  template: ResumeTemplate,
  enabled: boolean,
): { data: PageImagesResult | null; loading: boolean; failed: boolean } {
  const [data, setData] = useState<PageImagesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || !resume) return;
    setLoading(true);
    setFailed(false);
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      renderPages(resume, template, ctrl.signal)
        .then((r) => {
          if (!ctrl.signal.aborted) setData(r);
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [resume, template, enabled]);

  return { data, loading, failed };
}
