import { useCallback, useEffect, useState } from "react";
import { getMasterResume, listMasterResumes } from "../api/client";
import { resumeLanguage } from "../lib/lang";
import type { MasterResume } from "../types";

// Module-level cache so navigating between pages that need the master résumé
// (Resume, Jobs, Interview) doesn't re-fetch and flash a skeleton on every visit.
// Stale-while-revalidate: mounts after the first return the cache instantly and
// refresh in the background. `null` = never loaded yet.
let cache: MasterResume[] | null = null;

/**
 * Drop the cache so the next mount refetches.
 *
 * This exists because `invalidateData` CANNOT reach this variable — it only
 * clears the `dataCache` Map, and this is a plain module-level binding. Nine
 * pages read the master résumé from here (Interview, and every tool), so after
 * the master is edited and saved, anything that skips this keeps painting AND
 * SENDING the pre-edit résumé: an ATS X-ray run straight after an edit would
 * scan the document that was just replaced.
 *
 * Set to null rather than to the new value: consumers already treat `null` as
 * "fetch, with a skeleton", and that is honestly invalidated where an optimistic
 * upsert would only be half right.
 */
export function resetMasterCache(): void {
  cache = null;
}

/** Loads the persisted master résumés once (paired he/en — at most one per
 * language, newest first). `master` is the most recently updated one, which is
 * all Interview / Tools need; Jobs also shows the full pair via `masters`.
 * `setMaster` upserts a freshly uploaded résumé into its language slot without
 * a reload. */
export function useMasterResume() {
  const [masters, setMasters] = useState<MasterResume[]>(cache ?? []);
  // Only the first-ever load shows a skeleton; later mounts start from cache.
  const [loading, setLoading] = useState(cache === null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const next = await listMasterResumes();
        if (!alive) return;
        cache = next;
        setMasters(next);
      } catch {
        // Older backend without /profile/resumes — fall back to the single master.
        try {
          const m = await getMasterResume();
          if (!alive) return;
          cache = m ? [m] : [];
          setMasters(cache);
        } catch {
          if (!alive) return;
          if (cache === null) setMasters([]); // keep any prior cache on transient errors
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setMaster = useCallback((m: MasterResume) => {
    const lang = m.language ?? resumeLanguage(m.resume);
    setMasters((prev) => {
      const next = [
        { ...m, language: lang },
        ...prev.filter((p) => (p.language ?? resumeLanguage(p.resume)) !== lang),
      ];
      cache = next; // keep the shared cache in sync with in-place upserts
      return next;
    });
  }, []);

  return { master: masters[0] ?? null, masters, loading, setMaster };
}
