import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { formatUsesDate, formatUsesTime, useUses } from "../lib/usesStore";

interface Props {
  /** The feature this control spends, as the backend's `quota.FEATURES` names it. */
  feature: string;
  /** A per-posting inclusion the caller holds (ISO UTC): the fit check's
   * `tailor_included_until` for Tailor, and for a cover letter's next change the
   * deadline `usesStore.inclusionFrom` took on arrival from the server's relative
   * seconds (never the letter's `included_until`). While it is in the future the
   * call uses nothing. */
  includedUntil?: string;
  /** The sentence while the control has uses left and nothing covers it. Default:
   * the feature's own sentence, or "This uses 1 of the N you have left this month." */
  children?: ReactNode;
  /** The sentence while the call is covered. Default: the feature's own, or none. */
  covered?: ReactNode;
  /** The sentence at zero, in place of the generic one. For a surface where the
   * generic list of what stays free would contradict the control it sits under:
   * the review panel's checks ARE free, and naming "the review" as free
   * directly beneath that panel's one paid button reads as a contradiction
   * rather than as reassurance. */
  atZero?: ReactNode;
  /** A control inside an open session (a model answer, practice feedback, the
   * mock interview's Send and End): it says nothing while the session covers it,
   * and its caller never disables it mid-session. */
  inSession?: boolean;
  className?: string;
}

/**
 * The line under a counted control (Phase 30 / C4): what pressing it costs,
 * said before it is pressed.
 *
 * It renders NOTHING for an account with no monthly limit (the admin, plan
 * "unlimited") and when this page does not know the count (a failed /auth/me):
 * "0 left" about a count nobody measured would be a false sentence at the moment
 * of decision. At zero the caller disables the control on `useUses(...).out`,
 * the only thing allowed to disable one, and this line says when uses come back
 * and what stays free -- or what the caller's own `atZero` says instead, where
 * that generic list would contradict the surface it renders on.
 *
 * A NUMBER IN ONE OF THESE SENTENCES IS WHAT IS LEFT, never the allowance. The
 * two-clause notes (the fit check, the cover letter) used to interpolate
 * `limit`, so with one use left they read "Uses 1 of your 10" while every other
 * counted button on the same account read "This uses your last use this month."
 * -- and the warning ink below is computed from `remaining`, so the colour and
 * the number disagreed. Both now name `remaining`, which is also the number the
 * `_one` forms were written for.
 *
 * Every sentence is a LITERAL `t("uses.…")` call, one per state, never a
 * template literal: check-mirrors 32(d) resolves each one in both common.json
 * files, and a key it cannot see would render raw under the button it prices.
 * The pass numbers (3 hours, 6 answers) are the backend's `quota.PASS_RULES`,
 * written into the copy as the spec states them.
 */
export default function UsesNote({
  feature,
  includedUntil,
  children,
  covered,
  atZero,
  inSession,
  className,
}: Props) {
  const { t } = useTranslation();
  const { i18n } = useTranslation();
  const uses = useUses(feature, includedUntil);
  if (!uses.limited) return null;

  const lang = i18n.language;
  let text: ReactNode = null;
  if (uses.out) {
    if (atZero !== undefined) {
      text = atZero;
    } else {
      const date = formatUsesDate(uses.resetsOn, lang);
      text = date ? t("uses.out", { date }) : t("uses.outBare");
    }
  } else if (uses.covered) {
    if (inSession) return null;
    if (covered !== undefined) text = covered;
    else if (feature === "interview" && uses.pass)
      text = t("uses.includedInterview", { time: formatUsesTime(uses.pass.deadline, lang) });
    else if (feature === "screening" && uses.pass)
      text = t("uses.includedScreening", {
        count: uses.pass.callsLeft,
        time: formatUsesTime(uses.pass.deadline, lang),
      });
    else if (feature === "tailor") text = t("uses.includedFit");
  } else if (children !== undefined) {
    text = children;
  } else if (feature === "interview") {
    text = t("uses.passInterview");
  } else if (feature === "screening") {
    text = t("uses.passScreening");
  } else if (feature === "fit_check") {
    text = t("uses.fitCheck", { count: uses.remaining ?? 0 });
  } else {
    text = t("uses.note", { count: uses.remaining ?? 0 });
  }
  if (text === null || text === "") return null;

  // Warning ink at two or fewer left, and at none; never on a covered call,
  // which spends nothing whatever the count.
  const low = !uses.covered && uses.remaining !== null && uses.remaining <= 2;
  return (
    <p className={cn("text-xs leading-relaxed", low ? "text-warn" : "text-ink-faint", className)}>{text}</p>
  );
}
