import { useEffect, useState } from "react";
import { getMasterResume } from "../api/client";
import type { MasterResume } from "../types";

/** Loads the persisted master résumé once. Shared by Interview / Jobs / Tools. */
export function useMasterResume() {
  const [master, setMaster] = useState<MasterResume | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        setMaster(await getMasterResume());
      } catch {
        setMaster(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  return { master, loading };
}
