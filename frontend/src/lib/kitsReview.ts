// Which batch-tailored drafts ("kits") are still waiting on the user (PLAN
// 31.4/5). Dependency-free, so check-mirrors 69 can bundle and EXECUTE it.
import type { KitOut } from "../types";

/** The order "To review" lists them in: a draft ready to review first, then the
 * ones still on their way, then a failure to clear away. Approved, rejected and
 * submitted kits are decided: an approved or submitted one is its job's draft in
 * the tracker now, and a rejected one was turned down. */
export const REVIEW_ORDER: readonly KitOut["status"][] = ["done", "running", "queued", "failed"];

/** The kits "To review" lists, in `REVIEW_ORDER`, newest first within a status.
 * A list never loaded (null) lists nothing. The input is never sorted in place:
 * it is the store's own array. */
export function kitsToReview(kits: readonly KitOut[] | null): KitOut[] {
  if (!kits) return [];
  return kits
    .filter((k) => REVIEW_ORDER.includes(k.status))
    .sort((a, b) => REVIEW_ORDER.indexOf(a.status) - REVIEW_ORDER.indexOf(b.status) || b.id - a.id);
}

/** Drafts tailored and waiting for a person: the nav's count. "done" is exactly
 * the status approving and rejecting require, so a queued, running or failed kit
 * is never counted as something to review. */
export function awaitingReview(kits: readonly KitOut[] | null): number {
  return kits ? kits.filter((k) => k.status === "done").length : 0;
}
