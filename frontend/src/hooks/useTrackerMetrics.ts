import { useMemo } from "react";
import type { ApplicationOut } from "../types";

/** Statuses that mean the application was actually submitted. */
export const SUBMITTED = new Set(["applied", "interview", "offer", "rejected"]);
/** Statuses that mean the company answered (any outcome). */
export const RESPONDED = new Set(["interview", "offer", "rejected"]);

export interface TrackerMetrics {
  total: number;
  applied: number;
  interviews: number;
  offers: number;
  declined: number;
  interviewRate: number;
  responseRate: number;
}

/**
 * Pipeline metrics derived from tracker rows. One consumer since 22.9 deleted
 * the Home dashboard (TrackerPage) — it stays a hook so the numbers keep a
 * single definition if a second surface ever needs them.
 */
export function useTrackerMetrics(apps: ApplicationOut[]): TrackerMetrics {
  return useMemo(() => {
    const total = apps.length;
    const applied = apps.filter((a) => SUBMITTED.has(a.status || "saved")).length;
    const interviews = apps.filter((a) => a.interviewed).length;
    const offers = apps.filter((a) => a.status === "offer").length;
    const declined = apps.filter((a) => a.status === "rejected").length;
    // A "response" = the company answered at all: moved to interview/offer/
    // rejected, or the interviewed flag was set while still in "applied".
    const responses = apps.filter(
      (a) => SUBMITTED.has(a.status || "saved") && (RESPONDED.has(a.status) || a.interviewed),
    ).length;
    const interviewRate = applied > 0 ? (interviews / applied) * 100 : 0;
    const responseRate = applied > 0 ? (responses / applied) * 100 : 0;
    return { total, applied, interviews, offers, declined, interviewRate, responseRate };
  }, [apps]);
}
