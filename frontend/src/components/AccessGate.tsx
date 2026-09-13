import { useEffect } from "react";
// From lib/, not api/client: importing it from there pulls axios + the whole
// typed API surface into the eager entry chunk (see lib/accessCode.ts).
import { UNAUTHORIZED_EVENT, UNVERIFIED_EVENT } from "../lib/accessCode";
import { authRedirectUrl, isAuthPage, type AuthPage } from "../lib/safeNext";

/**
 * Where a rejected request sends the visitor. It renders nothing.
 *
 * It used to be a full-screen overlay asking for the access code. With
 * accounts, a 401 means "sign in" and a 403 `email_unverified` means "confirm
 * your email", and each of those is a page (/login, /verify), not a dialog
 * over whatever page failed.
 *
 * A DOCUMENT LOAD, never <Navigate>. Every store in this app is a module-level
 * binding that outlives the router (tailorStore, kitsStore, jobSearchStore,
 * useMasterResume's cache), and a 401 is exactly the moment one of them may
 * hold the previous session's data. A route change would carry that data into
 * whichever account signs in next.
 *
 * Nothing happens on an auth page itself. The verify page asks for a resend
 * with a session that may be gone, and bouncing it to /login from there would
 * nest one auth page's `next` inside another's.
 *
 * ONCE per page. A signed-out app fires several requests at mount and each one
 * 401s. `pageshow` re-arms the flag, because a page restored from the
 * back/forward cache keeps its JS state and would otherwise never redirect
 * again.
 */
export default function AccessGate() {
  useEffect(() => {
    let leaving = false;
    const go = (page: AuthPage) => () => {
      if (leaving || isAuthPage(window.location.pathname)) return;
      leaving = true;
      window.location.assign(authRedirectUrl(page));
    };
    const toLogin = go("/login");
    const toVerify = go("/verify");
    const rearm = () => {
      leaving = false;
    };
    window.addEventListener(UNAUTHORIZED_EVENT, toLogin);
    window.addEventListener(UNVERIFIED_EVENT, toVerify);
    window.addEventListener("pageshow", rearm);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, toLogin);
      window.removeEventListener(UNVERIFIED_EVENT, toVerify);
      window.removeEventListener("pageshow", rearm);
    };
  }, []);

  return null;
}
