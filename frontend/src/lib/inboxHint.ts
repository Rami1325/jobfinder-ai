// The inbox hints this device has hidden: "connect Gmail" and "Gmail sync is
// invite-only" on the tracker. Both are offers, not state, so a hidden one
// costs nothing — Settings still carries the whole card.
//
// Per device, the lib/onboarding.ts shape: storage that can throw (a private
// window, blocked site data) degrades to showing the hint, never to an error.
export type InboxHint = "connect" | "inviteOnly";

const KEY = "jf-inbox-hints-v1";

function read(): InboxHint[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed.filter((h) => typeof h === "string") as InboxHint[]) : [];
  } catch {
    return [];
  }
}

export function isInboxHintHidden(hint: InboxHint): boolean {
  return read().includes(hint);
}

export function hideInboxHint(hint: InboxHint): void {
  try {
    const hidden = read();
    if (!hidden.includes(hint)) localStorage.setItem(KEY, JSON.stringify([...hidden, hint]));
  } catch {
    /* storage unavailable — the hint just shows again next visit */
  }
}

/** Forget them. Called on sign-out for `clearOnboarding`'s reason: whether to
 * offer Gmail sync belongs to one person, and on a shared device a hint hidden
 * by one account would stay hidden for the next. */
export function clearInboxHints(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — nothing was stored either */
  }
}
