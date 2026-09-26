import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { saveMasterResume } from "../api/client";
import { useToast } from "../components/ui";
import { masterResumeLabel } from "../lib/masterLabel";
import type { FactsLedger, MasterResume, ResumeModel } from "../types";

// In lib/ since PLAN 31.6/2, where the store's autosave can reach it; kept
// exported from here for the pages that already import it from this hook.
export { masterResumeLabel };

/**
 * Persist a freshly parsed resume as the master resume (label from the contact
 * name) and toast on success. Persistence is best-effort: returns the saved
 * MasterResume, or null if the backend call failed. Shared by TailorPage and
 * JobsPage so the save logic lives in one place.
 *
 * `quiet` skips the success toast for a caller that says it on screen itself:
 * /app's first upload opens the first-run sheet, which a toast above the modal
 * layer covered for its whole life (PLAN 31.5/2, seen at 390 px).
 */
export function useSaveMasterResume() {
  const toast = useToast();
  const { t } = useTranslation();
  return useCallback(
    async (resume: ResumeModel, ledger: FactsLedger, quiet = false): Promise<MasterResume | null> => {
      try {
        const m = await saveMasterResume({ resume, ledger, label: masterResumeLabel(resume) });
        if (!quiet) toast("success", t("masterResume.savedToast"));
        return m;
      } catch {
        return null; // best-effort — the caller can still use the parsed resume locally
      }
    },
    [toast, t],
  );
}
