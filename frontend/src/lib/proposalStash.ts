/**
 * The proposal tool's page, kept for THIS TAB across a reload (the phone polish
 * pass, 2026-09-28).
 *
 * The tool (`pages/tools/ProposalToolPage.tsx`) held the pasted gig, the rate
 * and the proposal written for it in module state, which a reload empties. The
 * first proposal for a gig READS the gig on the server and opens that reading's
 * letter pass (one use, 24 hours, ten calls, keyed by the reading: see
 * `cost-and-quota.md`, *A proposal rides the letter's pass*). After a reload the
 * reading was gone with the page, so the next write read the gig again, a new
 * key, and charged a second use for a posting whose pass was still open.
 *
 * So the page keeps what it had in `sessionStorage`: this tab only, gone when the
 * tab closes, never sent to the server (the server already holds the pass and
 * nothing else). With the reading back, the letter card on the page reads its
 * pass back on mount (P30-RELOAD-PASS), and a change is said to be included and
 * rides it, exactly as before the reload.
 *
 * It belongs to ONE account: the stash names the account this tab's guard
 * resolved (`tabAccount`), and is read only by that account and written only
 * while one is known. Every tab of a browser shares the session cookie, and
 * sign-out ends in a document load but must not touch this tab's session storage
 * (lib/session.ts keeps a confirmation link there), so another account signing
 * in to this tab finds the stash under someone else's id: it is dropped, never
 * shown. "Delete all my data" drops it too (Settings).
 *
 * Best-effort: a private window, a full quota or a blocked storage throws, and
 * then the page simply starts empty after a reload, as it always did.
 * check-mirrors 111 executes this module.
 */
import { tabAccount } from "./accountWatch";

export const PROPOSAL_STASH_KEY = "jobfinder.proposal";

/** What the page keeps: the box's gig and rate, and the proposal written for a
 * gig with the server's reading of it (`jd`, the pass's key). `written` is typed
 * by the page; here it is only checked to have that shape. */
export interface ProposalStash<W> {
  gig: string;
  rate: string;
  written: W | null;
  /** The navigation (its location key) that last handed the page a posting: a
   * search row's state survives a reload under the same key, so the posting is
   * pasted in once per tap and a reload never pastes it over an edit. */
  handed: string;
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function clearProposalStash(): void {
  try {
    storage()?.removeItem(PROPOSAL_STASH_KEY);
  } catch {
    /* nothing kept, or nothing to keep */
  }
}

/** A written proposal as the page stores it: the gig it was written for, the
 * rate, the server's reading (an object), the text and what the floor found. */
function isWritten(w: unknown): boolean {
  if (!w || typeof w !== "object") return false;
  const x = w as Record<string, unknown>;
  return (
    typeof x.gig === "string" &&
    typeof x.rate === "string" &&
    typeof x.text === "string" &&
    !!x.jd &&
    typeof x.jd === "object" &&
    !Array.isArray(x.jd) &&
    !!x.found &&
    typeof x.found === "object"
  );
}

/** This tab's stash for the account signed in here, or null: none kept, no
 * account known, another account's, or unreadable (the last two are dropped). */
export function readProposalStash<W>(): ProposalStash<W> | null {
  const owner = tabAccount();
  const s = storage();
  if (owner === null || !s) return null;
  let raw: string | null = null;
  try {
    raw = s.getItem(PROPOSAL_STASH_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || v.owner !== owner || typeof v.gig !== "string" || typeof v.rate !== "string") {
      clearProposalStash();
      return null;
    }
    return {
      gig: v.gig,
      rate: v.rate,
      written: isWritten(v.written) ? (v.written as W) : null,
      handed: typeof v.handed === "string" ? v.handed : "",
    };
  } catch {
    clearProposalStash();
    return null;
  }
}

/** Keep the page's state for this tab, under the account signed in here; with
 * no account known nothing is kept. */
export function writeProposalStash<W>(stash: ProposalStash<W>): void {
  const owner = tabAccount();
  const s = storage();
  if (owner === null || !s) return;
  try {
    s.setItem(
      PROPOSAL_STASH_KEY,
      JSON.stringify({ owner, gig: stash.gig, rate: stash.rate, written: stash.written, handed: stash.handed }),
    );
  } catch {
    /* full or blocked: the page still works, and starts empty after a reload */
  }
}
