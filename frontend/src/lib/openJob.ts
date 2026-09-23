// Where a link from an alert email opens (PLAN 31.4/6): `/jobs?open=<posting>`.
// Dependency-free, so check-mirrors 70 can bundle and EXECUTE it.
import type { ApplicationOut, JobSearchHit } from "../types";

export type OpenTarget =
  | { kind: "job"; id: number } // a tracked job: its own page
  | { kind: "hit"; id: number } // an untracked job History still holds: its row
  | { kind: "missing" }; // neither: History keeps the newest 100

/** The job in the app for the posting URL an email carried. It is compared
 * through `normalize` (the Jobs page's own URL key) with each History row's URL
 * and the same posting on other boards, then with the tracker's rows. The row a
 * History hit names wins: the server matched it by LinkedIn id too. */
export function openTarget(
  open: string,
  hits: readonly Pick<JobSearchHit, "id" | "url" | "also_on" | "app_id">[] | null,
  rows: readonly Pick<ApplicationOut, "id" | "job_url">[],
  normalize: (url: string) => string,
): OpenTarget {
  const want = normalize(open);
  const same = (url?: string | null) => !!url && normalize(url) === want;
  const hit = hits?.find((h) => same(h.url) || (h.also_on ?? []).some((a) => same(a.url)));
  const rowId = hit?.app_id ?? rows.find((a) => same(a.job_url))?.id ?? null;
  if (rowId) return { kind: "job", id: rowId };
  return hit ? { kind: "hit", id: hit.id } : { kind: "missing" };
}

/** The posting link the "not in your history" notice may show: a plain http(s)
 * URL only. The parameter is anyone's to write, so nothing else in it is ever
 * made a link. */
export function postingLink(open: string): string | null {
  return /^https?:\/\//i.test(open.trim()) ? open.trim() : null;
}
