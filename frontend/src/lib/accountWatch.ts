/**
 * Which account this tab belongs to, and telling the browser's other tabs.
 *
 * Every tab of one browser shares the `jf_session` cookie, so when account B
 * signs in from another tab, this tab's next request already runs as B while
 * its page (every module-level store: the resume, the tailor draft, the
 * search, the kits) still shows A. Nothing noticed: the uses refresh only
 * declines to write B's count here (`usageIfSameUser`). Now the app shell
 * ANNOUNCES the account its guard resolved, and sign-out announces that nobody
 * is signed in; a tab that hears an account other than its own reloads the
 * document, which runs its guard again as whoever holds the cookie. That is
 * AccessGate's rule for leaving an account: a document load, never a route
 * change, because the stores outlive the router.
 *
 * `BroadcastChannel` reaches every same-origin tab of this browser and none of
 * another device, which is exactly the reach of the cookie. Where it does not
 * exist, nothing is announced and nothing is heard (the old behaviour).
 *
 * Dependency-free, like accessCode.ts: AppLayout and session.ts import it.
 */

const CHANNEL = "jobfinder.account";

/** The account this tab's guard resolved, or null when none is known (the
 * guard failed open, or has not answered yet). */
let mine: number | null = null;

export function tabAccount(): number | null {
  return mine;
}

// ONE channel object for this tab, for posting AND listening. A channel never
// receives its own messages, so a tab does not hear itself: with two objects,
// sign-out's own "nobody" reached this tab's listener and could reload the page
// before sign-out's document load to its destination.
let shared: BroadcastChannel | null | undefined;

function channel(): BroadcastChannel | null {
  if (shared !== undefined) return shared;
  try {
    shared = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    shared = null;
  }
  return shared;
}

/** Tell the other tabs who this tab is signed in as; `null` for signed out.
 * An id is also remembered as this tab's own (`tabAccount`). */
export function announceAccount(id: number | null): void {
  if (typeof id === "number") mine = id;
  const ch = channel();
  if (!ch) return;
  try {
    ch.postMessage({ account: id });
  } catch {
    /* nothing heard elsewhere; each tab's own guard still runs on its next load */
  }
}

/** True when a message says another account holds the cookie, or nobody does.
 * Pure, so check-mirrors 45 executes it. A message it cannot read says nothing. */
export function isOtherAccount(expectedId: number, message: unknown): boolean {
  if (!message || typeof message !== "object" || !("account" in message)) return false;
  const account = (message as { account: unknown }).account;
  if (account === null) return true;
  return typeof account === "number" && account !== expectedId;
}

/** Call `onOther` when another tab announces an account other than
 * `expectedId` (or a sign-out). Returns the unsubscribe. */
export function watchAccount(expectedId: number, onOther: () => void): () => void {
  const ch = channel();
  if (!ch) return () => {};
  const listener = (e: MessageEvent) => {
    if (isOtherAccount(expectedId, e.data)) onOther();
  };
  ch.addEventListener("message", listener);
  return () => ch.removeEventListener("message", listener);
}
