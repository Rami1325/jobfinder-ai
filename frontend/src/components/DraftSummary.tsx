import { useTranslation } from "react-i18next";
import { ChevronRight, ShieldAlert, ShieldCheck, Target } from "lucide-react";
import PageBadge from "./PageBadge";
import { cn } from "../lib/cn";
import type { ResumeTemplate } from "../api/client";
import type { ResumeModel } from "../types";

interface Props {
  /**
   * Keywords the posting asks for that the resume carries: `before` for the
   * resume this draft was tailored FROM, `after` for the draft on screen. Both
   * are the same deterministic matcher over the same analysed posting, which is
   * why a before → after is honest here and nowhere else (`scoring.md`: the
   * recruiter fit is one model reading and gets no delta). `null` = not
   * measured yet, never zero.
   */
  before: { covered: number; total: number } | null;
  after: { covered: number; total: number } | null;
  stale?: boolean;
  /** Flags the document still carries (`flagStates`, the drawer's own answer),
   * and how many the guard raised. */
  claimsOpen: number;
  claimsRaised: number;
  /** Lines the user typed. The guard never saw them, so "no new claims" is said
   * about the AI's changes and only about them. */
  typed: number;
  resume: ResumeModel;
  template: ResumeTemplate;
  onOpen: () => void;
}

/**
 * A tailored draft in one line, over the paper (PLAN 31.3/3): keywords before
 * and after, the claims to check, the page count. Everything behind it is one
 * tap away in the drawer this opens; the page is the document, not the four
 * cards that used to follow it for 7,000 px.
 *
 * ONE BUTTON, whose name is the whole line, because every part of it is a way
 * into the same review. The page count is `PageBadge`, the one mount measuring
 * this document (it mounts one at a time: the drawer's change list shows none).
 */
export default function DraftSummary({
  before,
  after,
  stale,
  claimsOpen,
  claimsRaised,
  typed,
  resume,
  template,
  onOpen,
}: Props) {
  const { t } = useTranslation("tailor");
  const total = after?.total ?? before?.total ?? 0;
  const keywords =
    before && after
      ? t("review.summary.keywords", { before: before.covered, after: after.covered, total })
      : after
        ? t("review.summary.keywordsNow", { after: after.covered, total })
        : before
          ? t("review.summary.keywords", { before: before.covered, after: "…", total })
          : null;
  const claims =
    claimsOpen > 0
      ? t("review.summary.claims", { count: claimsOpen })
      : claimsRaised > 0
        ? t("review.summary.claimsResolved")
        : typed > 0
          ? t("review.summary.noClaimsTyped")
          : t("review.summary.noClaims");
  const flagged = claimsOpen > 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-panel px-3 py-2 text-start text-xs text-ink-muted shadow-sm transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
    >
      {keywords && (
        <span className={cn("inline-flex items-center gap-1 tabular-nums text-ink", stale && "opacity-60")}>
          <Target size={13} aria-hidden className="shrink-0 text-accent-soft" />
          {keywords}
        </span>
      )}
      <span className={cn("inline-flex items-center gap-1", flagged ? "font-semibold text-danger" : "text-ink-muted")}>
        {flagged ? (
          <ShieldAlert size={13} aria-hidden className="shrink-0" />
        ) : (
          <ShieldCheck size={13} aria-hidden className="shrink-0 text-mint" />
        )}
        {claims}
      </span>
      <PageBadge compact resume={resume} template={template} />
      <span className="ms-auto inline-flex items-center gap-0.5 font-semibold text-accent-soft">
        {t("review.summary.open")}
        <ChevronRight size={14} aria-hidden className="rtl:-scale-x-100" />
      </span>
    </button>
  );
}
