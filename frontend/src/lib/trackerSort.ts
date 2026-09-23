import type { ApplicationOut } from "../types";

/** The tracker's phone list order (PLAN 31.2/7). */
export type ListSort = "newest" | "applied" | "match";

/** The phone list's order (PLAN 31.2/7). "Date applied" is the sort people
 * rely on (LinkedIn's new tracker drew complaints for dropping it: some report
 * it for unemployment); a row with no applied date goes after every dated one,
 * newest first among themselves, since an unknown date is not an early one. */
export function sortApps(list: ApplicationOut[], by: ListSort): ApplicationOut[] {
  const time = (s?: string | null) => (s ? new Date(s).getTime() || 0 : 0);
  const out = [...list];
  if (by === "match") out.sort((x, y) => (y.overall_score || 0) - (x.overall_score || 0));
  else if (by === "applied")
    out.sort((x, y) => {
      const ax = time(x.applied_at);
      const ay = time(y.applied_at);
      if (!ax !== !ay) return ax ? -1 : 1;
      return ay - ax || time(y.created_at) - time(x.created_at);
    });
  else out.sort((x, y) => time(y.created_at) - time(x.created_at));
  return out;
}
