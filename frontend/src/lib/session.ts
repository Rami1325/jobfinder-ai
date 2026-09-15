import { logout } from "../api/client";
import { resetMasterCache } from "../hooks/useMasterResume";
import { ACCESS_CODE_KEY } from "./accessCode";
import { clearDataCache } from "./dataCache";
import { clearDraft } from "./draft";
import { clearInboxHints } from "./inboxHint";
import { clearOnboarding } from "./onboarding";

/**
 * The one sign-out.
 *
 * Forgetting the access code is only half of it: every store in this app is a
 * module-level binding that outlives the router (tailorStore, kitsStore,
 * jobSearchStore and useMasterResume's cache all still hold the previous user's
 * resume and search results), so this ends in a DOCUMENT LOAD to
 * `destination`, never a <Navigate>. A route change would repaint the next page
 * with the last person's CV one tab away.
 *
 * There is exactly ONE definition, here, and check-mirrors 30 fails a second:
 * "forget this user" is precisely the list that drifts, and the day a new
 * module-level store is added, only one of two copies would get it. It lived
 * in AppLayout, imported by Settings, until /verify's "Log out and continue"
 * became a third caller (Phase 30 D).
 *
 * With accounts there is a server half, and it goes FIRST: `logout()` ends this
 * session, so the cookie cannot sign anyone back in. Its failure is ignored. An
 * expired session or a dropped connection must not strand someone who asked to
 * leave, and everything after it is local. The local half forgets the code, the
 * resume draft (lib/draft.ts: DraftRestoreBar would offer it to the next
 * account on this device as that account's own CV), the onboarding answers
 * (whose target role would prefill that account's search), and the Gmail-sync
 * hints that account hid on the tracker.
 *
 * It never touches this tab's session storage, and check-mirrors 30 pins that.
 * A confirmation link kept there (lib/verifyLink.ts) is what "Log out and
 * continue" continues with: clearing it would leave the log in that follows
 * asking for the 6-digit code instead.
 *
 * `destination` is followed as given, so it must already be a safe same-origin
 * path: "/" from the menu and Settings, `withNext("/login", next)` from /verify.
 */
export async function signOut(destination: string): Promise<void> {
  try {
    await logout();
  } catch {
    /* the session may already be gone; forgetting this device still happens */
  }
  localStorage.removeItem(ACCESS_CODE_KEY);
  clearDraft();
  clearOnboarding();
  clearInboxHints();
  clearDataCache();
  resetMasterCache();
  window.location.assign(destination);
}
