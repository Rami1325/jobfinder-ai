import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getApplication } from "../api/client";
import type { ApplicationDetail } from "../types";

/** The tracked job a tool was opened for (PLAN 31.4/3). */
export interface JobContext {
  id: number;
  /** Where the tool's Back goes: the job's own page. */
  backTo: string;
  /** The job's row, or null while it loads or when it could not be read (the
   * tool then simply opens empty, as it would without a job). */
  job: ApplicationDetail | null;
}

/**
 * The job a tool was opened from, when its job page named one with `?app=<id>`.
 *
 * A query parameter, not navigation state, on purpose: state is gone after a
 * reload, and so was the posting a tool had been opened with, and nothing could
 * say which page Back should return to. The tool fills in the job's posting,
 * company and role from the row (only into fields that are still empty, so what
 * the user typed or a caller's state handed over wins), and its Back returns to
 * `/applications/<id>`. Null when no job was named.
 */
export function useJobContext(): JobContext | null {
  const [params] = useSearchParams();
  const raw = params.get("app");
  const id = raw && /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
  const [job, setJob] = useState<ApplicationDetail | null>(null);

  useEffect(() => {
    if (id === null) return;
    let alive = true;
    setJob(null);
    getApplication(id)
      .then((d) => {
        if (alive) setJob(d);
      })
      .catch(() => {
        // Unreadable (deleted, another account's, offline): the tool opens
        // empty and Back still leads to the job's page, which says what happened.
      });
    return () => {
      alive = false;
    };
  }, [id]);

  return id === null ? null : { id, backTo: `/applications/${id}`, job };
}

/** Which follow-up the follow-up writer should open on, for a job's status. The
 * ids are the backend's (English, sent as-is). */
export function followUpStage(status: string): string {
  if (status === "interview") return "after an interview";
  if (status === "offer") return "after an offer";
  return "after applying";
}
