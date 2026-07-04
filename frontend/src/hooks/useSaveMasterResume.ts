import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { saveMasterResume } from "../api/client";
import { useToast } from "../components/ui";
import type { FactsLedger, MasterResume, ResumeModel } from "../types";

/** Human-readable label for a saved master résumé, derived from the contact name. */
export function masterResumeLabel(resume: ResumeModel): string {
  return resume.contact.name ? `${resume.contact.name}'s résumé` : "My résumé";
}

/**
 * Persist a freshly parsed résumé as the master résumé (label from the contact
 * name) and toast on success. Persistence is best-effort: returns the saved
 * MasterResume, or null if the backend call failed. Shared by TailorPage and
 * JobsPage so the save logic lives in one place.
 */
export function useSaveMasterResume() {
  const toast = useToast();
  const { t } = useTranslation();
  return useCallback(
    async (resume: ResumeModel, ledger: FactsLedger): Promise<MasterResume | null> => {
      try {
        const m = await saveMasterResume({ resume, ledger, label: masterResumeLabel(resume) });
        toast("success", t("masterResume.savedToast"));
        return m;
      } catch {
        return null; // best-effort — the caller can still use the parsed résumé locally
      }
    },
    [toast, t],
  );
}
