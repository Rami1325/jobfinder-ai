import { useMemo } from "react";
import type { ApplicationOut } from "../types";

/** Statuses that mean the application was actually submitted. */
export const SUBMITTED = new Set(["applied", "interview", "offer", "rejected"]);
/** Statuses that mean the company answered (any outcome). */
export const RESPONDED = new Set(["interview", "offer", "rejected"]);

/**
 * The date an application is filed under: when it was SENT, or — when that is
 * unknown — when it was added.
 *
 * ONE definition, read by the card's date and by every date bucket in
 * TrackerAnalytics. `created_at` alone is the SAVE date for anything saved from
 * Jobs, a kit or the extension and applied to later, so an application sent
 * today after sitting in Saved for three weeks landed in a bar three weeks
 * back. Two readers of two different fields would put the same card in two
 * different weeks.
 */
export function dateOfRecord(a: {
  applied_at?: string | null;
  created_at: string;
  source?: string;
}): string {
  if (a.applied_at) return a.applied_at;
  // A card the inbox made is dated by its earliest email (I3), and the server
  // writes that as a UTC instant serialised WITHOUT an offset. Parsed as local
  // time it lands on the UTC calendar day, while the same email in the card's
  // own timeline (which carries its offset) reads the local day. So it is read
  // as the UTC instant it is. Scoped to inbox rows: every other row keeps the
  // value it always had, and a value that states an offset is left alone.
  if (a.source === "email" && a.created_at && !/(?:Z|[+-]\d\d:?\d\d)$/.test(a.created_at)) return `${a.created_at}Z`;
  return a.created_at;
}

/** Whether a row counts as interviewed. ONE definition for the Interviews tile
 * and the analytics funnel: a card dragged to the Interview column never sets
 * the flag (a status change sends only `status`), and the two numbers used to
 * disagree about exactly that card. */
export function isInterviewed(a: { interviewed?: boolean; status?: string }): boolean {
  return !!a.interviewed || a.status === "interview";
}

export interface TrackerMetrics {
  total: number;
  applied: number;
  interviews: number;
  offers: number;
  declined: number;
  /** null when nothing has been sent yet. 0/0 is undefined, not 0% — see the
   * rate calculation below for why that distinction is load-bearing. */
  interviewRate: number | null;
  responseRate: number | null;
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
    const interviews = apps.filter(isInterviewed).length;
    const offers = apps.filter((a) => a.status === "offer").length;
    const declined = apps.filter((a) => a.status === "rejected").length;
    // A "response" = the company answered at all: moved to interview/offer/
    // rejected, or the interviewed flag was set while still in "applied".
    const responses = apps.filter(
      (a) => SUBMITTED.has(a.status || "saved") && (RESPONDED.has(a.status) || a.interviewed),
    ).length;
    // `: null`, never `: 0`. With nothing applied there is no rate to report,
    // and the old zero fallback rendered as two 104px rings reading "0%" —
    // the first thing a user saw on the tracker in their first week, stating a
    // measurement that had not been taken. TrackerAnalytics twelve files away
    // already withholds rates below a sample threshold and skips unknown keys
    // with `// unknown -- not a value`; this brings the default tab in line.
    const interviewRate = applied > 0 ? (interviews / applied) * 100 : null;
    const responseRate = applied > 0 ? (responses / applied) * 100 : null;
    return { total, applied, interviews, offers, declined, interviewRate, responseRate };
  }, [apps]);
}
