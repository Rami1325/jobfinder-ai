import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePageCount } from "../hooks/usePageCount";
import { cn } from "../lib/cn";
import type { ResumeModel } from "../types";
import type { ResumeTemplate } from "../api/client";

/**
 * How many pages the document on screen actually renders to, measured by a
 * real reportlab build on the deterministic, uncapped `/tools/page-count`.
 *
 * Extracted from ChangeLog so the review panel and the document toolbar cannot
 * describe the same measurement differently — this is the same class of
 * duplication the section order and `skill_blocks` mirrors exist to prevent.
 *
 * MOUNT ONE AT A TIME. Each mount owns a `usePageCount`, and each of those is a
 * debounced server render; two live badges would double every measurement for
 * one number. A page that shows the number twice measures ONCE and hands the
 * reading in as `measured` (/app's toolbar and its first-run sheet, PLAN
 * 31.5/2); the badge then runs no measurement of its own. The toolbar mounts it only while there is no tailor result, which
 * is precisely the gap — before Phase 22.10 the count first appeared inside the
 * review panel, i.e. only after you had already spent a tailor on a CV whose
 * length you could not see.
 */
export default function PageBadge({
  resume,
  template,
  enabled = true,
  compact = false,
  measured,
  className,
}: {
  resume: ResumeModel | null;
  template: ResumeTemplate;
  enabled?: boolean;
  /** Below `lg`, the count and the target only ("1 page", "3 pages · target 2"),
   * for the document toolbar's one row (PLAN 31.2/1): the sentence was 200 px
   * of a 358 px row on its own. The sentence stays for screen readers, and in
   * full from `lg`. */
  compact?: boolean;
  /** A reading the page already holds, so this mount measures nothing. */
  measured?: ReturnType<typeof usePageCount>;
  className?: string;
}) {
  const { t } = useTranslation("tailor");
  const own = usePageCount(resume, template, enabled && !!resume && !measured);
  const pages = measured ?? own;

  if (pages.failed && !pages.data)
    return <span className={cn("text-xs text-ink-faint", className)}>{t("pages.unavailable")}</span>;
  if (!pages.data) return null;

  const { pages: n, max_pages: max, hard_max_pages: hard } = pages.data;
  const value = t("pages.value", { count: n });
  const over = n > max;
  const hardOver = n > hard;
  const sentence = hardOver
    ? t("pages.hardOver", { pages: value, hard })
    : over
      ? t("pages.over", { pages: value, max })
      : t("pages.fits", { pages: value, max });
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs tabular-nums transition-opacity",
        pages.stale && "opacity-50",
        hardOver ? "font-medium text-danger" : over ? "font-medium text-warn" : "text-ink-muted",
        className,
      )}
    >
      <FileText size={12} aria-hidden />
      {compact ? (
        <>
          <span aria-hidden className="lg:hidden">
            {hardOver
              ? t("pages.compactHard", { pages: value, hard })
              : over
                ? t("pages.compactOver", { pages: value, max })
                : value}
          </span>
          <span className="sr-only lg:not-sr-only">{sentence}</span>
        </>
      ) : (
        sentence
      )}
      {pages.stale && <span className="text-ink-faint">· {t("pages.measuring")}</span>}
    </span>
  );
}
