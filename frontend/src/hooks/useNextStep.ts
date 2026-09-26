import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useToast } from "../components/ui";

/** How long a next-step toast stays up: long enough to read and reach. */
const NEXT_STEP_MS = 8000;

/**
 * Every finished step offers the next one (PLAN 31.5/6), and each is a link to
 * something that already exists:
 * - marked Applied: "Remind me if it goes quiet", the reminder emails in
 *   Settings (`#alerts`, the alert form's "Also remind me to follow up");
 * - moved to Interview: "Practice for this interview", Interview with the job
 *   (`?app=`, `useJobContext`), whose Back returns to the job.
 * Any other status says nothing more. Called by every place a status changes:
 * the tracker's chip, the job page's chip, and the document's Mark applied.
 * Returns true when it showed a toast, so a caller keeps its own otherwise.
 */
export function useNextStep() {
  const toast = useToast();
  const nav = useNavigate();
  const { t } = useTranslation();
  return useCallback(
    (status: string, appId: number | null): boolean => {
      if (status === "applied") {
        toast("success", t("next.applied"), {
          action: { label: t("next.followUp"), onClick: () => nav("/settings#alerts") },
          durationMs: NEXT_STEP_MS,
        });
        return true;
      }
      if (status === "interview" && appId !== null) {
        toast("success", t("next.interview"), {
          action: { label: t("next.practice"), onClick: () => nav(`/interview?app=${appId}`) },
          durationMs: NEXT_STEP_MS,
        });
        return true;
      }
      return false;
    },
    [toast, nav, t],
  );
}
