import { useCallback, useEffect, useState } from "react";
import { getMasterResume, listMasterResumes } from "../api/client";
import { resumeLanguage } from "../lib/lang";
import type { MasterResume } from "../types";

/** Loads the persisted master résumés once (paired he/en — at most one per
 * language, newest first). `master` is the most recently updated one, which is
 * all Interview / Tools need; Jobs also shows the full pair via `masters`.
 * `setMaster` upserts a freshly uploaded résumé into its language slot without
 * a reload. */
export function useMasterResume() {
  const [masters, setMasters] = useState<MasterResume[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        setMasters(await listMasterResumes());
      } catch {
        // Older backend without /profile/resumes — fall back to the single master.
        try {
          const m = await getMasterResume();
          setMasters(m ? [m] : []);
        } catch {
          setMasters([]);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  const setMaster = useCallback((m: MasterResume) => {
    const lang = m.language ?? resumeLanguage(m.resume);
    setMasters((prev) => [{ ...m, language: lang }, ...prev.filter((p) => (p.language ?? resumeLanguage(p.resume)) !== lang)]);
  }, []);
  return { master: masters[0] ?? null, masters, loading, setMaster };
}
