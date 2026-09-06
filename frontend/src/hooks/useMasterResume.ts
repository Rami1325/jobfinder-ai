import { useCallback, useEffect, useState } from "react";
import { getMasterResume, listMasterResumes } from "../api/client";
import { resumeLanguage } from "../lib/lang";
import { adoptMaster } from "../state/tailorStore";
import type { MasterResume } from "../types";

// Module-level cache so navigating between pages that need the master resume
// (Resume, Jobs, Interview) doesn't re-fetch and flash a skeleton on every visit.
// Stale-while-revalidate: mounts after the first return the cache instantly and
// refresh in the background. `null` = never loaded yet.
let cache: MasterResume[] | null = null;

/**
 * Drop the cache so the next mount refetches.
 *
 * This exists because `invalidateData` CANNOT reach this variable — it only
 * clears the `dataCache` Map, and this is a plain module-level binding. Nine
 * pages read the master resume from here (Interview, and every tool), so after
 * the master is edited and saved, anything that skips this keeps painting AND
 * SENDING the pre-edit resume: an ATS X-ray run straight after an edit would
 * scan the document that was just replaced.
 *
 * Set to null rather than to the new value: consumers already treat `null` as
 * "fetch, with a skeleton", and that is honestly invalidated where an optimistic
 * upsert would only be half right.
 */
export function resetMasterCache(): void {
  cache = null;
}

/** Loads the persisted master resumes once (paired he/en — at most one per
 * language, newest first). `master` is the most recently updated one, which is
 * all Interview / Tools need; Jobs also shows the full pair via `masters`.
 * `setMaster` upserts a freshly uploaded resume into its language slot without
 * a reload — and hands it to the document surface, which keeps a second copy
 * of the master that nothing else can reach (see the comment on the call). */
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
    // THIS CACHE IS NOT THE ONLY ONE. The document surface keeps its own
    // module-level copy of the master in `tailorStore`, and `TailorPage`'s
    // loader early-returns the moment that copy is set — so a resume replaced
    // from here never reached /app: it kept painting, TAILORING and downloading
    // the file this call had just replaced, until a full page reload. Uploading
    // a new CV on Jobs and then tailoring it produced the OLD one.
    //
    // The call belongs HERE, not at the three call sites (upload, version
    // restore, skills-editor save), because every caller of `setMaster` is by
    // definition a replacement of the stored master — so a fourth surface gets
    // it for free instead of shipping the same bug again. check-mirrors 12
    // pins that, and pins the reset against `applyBlockEdit`'s.
    //
    // (This import makes hooks/useMasterResume ↔ state/tailorStore a cycle, on
    // exactly the terms of the api/client one already documented there: both
    // sides only ever call across it at runtime, never at module evaluation,
    // and both entry points are hoisted function declarations.)
    adoptMaster({ ...m, language: lang });
  }, []);

  return { master: masters[0] ?? null, masters, loading, setMaster };
}
