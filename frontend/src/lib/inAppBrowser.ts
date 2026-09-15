// Continue with Google inside an app's embedded browser (Phase 30 F2).
//
// Google refuses OAuth sign-in in embedded browsers (its `disallowed_useragent`
// error): a tap on the button inside Instagram, Facebook or LinkedIn opens an
// error page from Google, not the account chooser. So in one of those the
// button is replaced by a line saying where it works, a way to copy this page's
// link, and on Android a link that opens this same page in Chrome.
//
// Dependency-free, so check-mirrors 32(l) runs it in node, with its
// false-positive half beside it: a marker that also matched real Chrome or
// Safari would take the button away from exactly the people it works for.
// WhatsApp's browser is deliberately not listed. How it behaves is unknown and
// has to be tried on a phone.

/** Facebook (FBAN, FBAV, FB_IAB), Instagram, LINE, LinkedIn, TikTok (and its old
 * name musical_ly), and any Android WebView ("; wv)"). */
const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Line\/|LinkedInApp|TikTok|musical_ly|; wv\)/;

export function isInAppBrowser(userAgent: string): boolean {
  return IN_APP.test(userAgent);
}

export function isAndroid(userAgent: string): boolean {
  return /Android/i.test(userAgent);
}

/** An Android intent link that opens THIS page in Chrome, its query included,
 * so `next` comes along. The page's own hash cannot: the fragment is where the
 * intent syntax lives. */
export function chromeIntentUrl(location: Pick<Location, "protocol" | "host" | "pathname" | "search">): string {
  const scheme = location.protocol === "http:" ? "http" : "https";
  return `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=${scheme};package=com.android.chrome;end`;
}
