import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Briefcase, ChevronRight, FileText, MessageSquareText, type LucideIcon } from "lucide-react";
import { Modal } from "./ui";
import { cn } from "../lib/cn";
import { useUses, useUsesState, usesFor } from "../lib/usesStore";

/** What a first choice opens. The page decides how: a search, the tailor
 * dialog, the interview page. */
export type FirstStep = "jobs" | "tailor" | "interview";

interface Props {
  open: boolean;
  /** Pages the resume renders to, once measured: the toolbar's own reading,
   * never a second measurement (PageBadge's one-mount rule). */
  pages: number | null;
  /** The review's two counts, once it has answered. */
  review: { fix: number; consider: number } | null;
  onChoose: (step: FirstStep) => void;
  onClose: () => void;
}

/**
 * The first run, after the first upload (PLAN 31.5/2). There is no modal
 * BEFORE the upload any more: a new account lands on the upload card, and once
 * the resume is read this one sheet says what the app found and asks what to
 * do first. It replaced the first-run questions (31.1/11), which asked for a
 * target role the resume already carries.
 *
 * It opens only from the upload card's handler, never from Replace, so it is a
 * first run by construction: no record is kept anywhere, and an account that
 * already had a resume never sees it (check-mirrors 52).
 *
 * Every number is one the page measured: the page count and the review's
 * counts appear once each has answered, and nothing stands in for them before.
 * Each choice says what it costs, on the account's own count, and a choice
 * whose feature is out of uses this month is disabled, the one thing
 * `useUses(...).out` may do.
 */
export default function FirstRunSheet({ open, pages, review, onChoose, onClose }: Props) {
  const { t } = useTranslation("tailor");
  const { t: tc } = useTranslation();
  const usesState = useUsesState();
  const account = usesFor("", undefined, usesState);

  const facts: string[] = [];
  if (pages !== null) facts.push(t("pages.value", { count: pages }));
  if (review) facts.push(t("firstRun.review", { fix: review.fix, consider: review.consider }));

  // Literal keys, one call each, so check-mirrors 52 can resolve every one in
  // both locales; a template literal would be invisible to it. The feature is
  // what the FIRST tap spends: the tailor dialog starts with the fit check,
  // whose one use covers the tailor after it.
  const steps: { id: FirstStep; icon: LucideIcon; feature: string; title: string; desc: string }[] = [
    // The search is the one choice the server can serve free: the pool's first search (PLAN 31.5).
    { id: "jobs", icon: Briefcase, feature: "search", title: t("firstRun.jobs.title"), desc: t("firstRun.jobs.desc") },
    {
      id: "tailor",
      icon: FileText,
      feature: "fit_check",
      title: t("firstRun.tailor.title"),
      desc: t("firstRun.tailor.desc"),
    },
    {
      id: "interview",
      icon: MessageSquareText,
      feature: "interview",
      title: t("firstRun.interview.title"),
      desc: t("firstRun.interview.desc"),
    },
  ];

  return (
    <Modal open={open} onClose={onClose} title={t("firstRun.title")} maxWidth="max-w-md" sheet>
      {facts.length > 0 && <p className="-mt-2 text-sm tabular-nums text-ink-muted">{facts.join(" · ")}</p>}
      <p className="mt-4 text-sm font-medium text-ink">{t("firstRun.ask")}</p>
      <div className="mt-2 space-y-2">
        {steps.map((step) => (
          <Choice
            key={step.id}
            icon={step.icon}
            feature={step.feature}
            title={step.title}
            desc={step.desc}
            onClick={() => onChoose(step.id)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-lg text-sm font-medium text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        {t("firstRun.later")}
      </button>
      {/* Only a count this page knows: nothing for the admin, a plan with no
          monthly limit, or an /auth/me that could not be read. */}
      {account.limited && (
        <p className="mt-1 text-center text-xs text-ink-faint">
          {tc("uses.account", { count: account.limit ?? 0, remaining: account.remaining ?? 0 })}
        </p>
      )}
    </Modal>
  );
}

function Choice({
  icon: Icon,
  feature,
  title,
  desc,
  onClick,
}: {
  icon: LucideIcon;
  feature: string;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  const { t: tc } = useTranslation();
  // Only the search is served free on a pool's first time, as on the Jobs page.
  const uses = useUses(feature, undefined, feature === "search");
  // Nothing when no limit is known, and nothing when an open session already
  // covers the tap: "1 use" there would be a cost the tap does not have.
  let cost: ReactNode = null;
  if (uses.free) cost = tc("uses.firstSearchShort");
  else if (uses.limited && !uses.covered) cost = uses.out ? tc("uses.outShort") : tc("uses.oneUse");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={uses.out}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border border-line p-3 text-start transition-colors",
        "hover:border-accent/50 hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <Icon size={20} aria-hidden className="shrink-0 text-accent-soft" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{title}</span>
        <span className="block text-xs leading-snug text-ink-muted">{desc}</span>
      </span>
      {/* Capped, so a long cost ("Free the first time" in Hebrew) wraps rather
          than squeezing the choice's own title onto a second line. */}
      {cost && <span className="max-w-[5.5rem] shrink-0 text-end text-xs leading-tight tabular-nums text-ink-faint">{cost}</span>}
      <ChevronRight size={16} aria-hidden className="shrink-0 text-ink-faint rtl:-scale-x-100" />
    </button>
  );
}
