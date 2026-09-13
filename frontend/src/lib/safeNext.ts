// Where to go after signing in, and the ONE place that decides whether a
// `next` value is safe to follow.
//
// Dependency-free for lib/accessCode.ts's reason: the eager AccessGate imports
// this, so anything imported here would land in the entry chunk.
//
// A `next` arrives in a URL the visitor did not write. Anyone can craft
// `/login?next=...` and mail it to someone, and every page that reads it ends
// in `location.assign(next)`. So it is an open redirect unless it is refused
// whenever it could leave this origin. The rules mirror the backend's
// `safe_next`, so the two sides cannot disagree about the same link.

/** The auth flow's own pages.
 *
 * Two rules hang off this list. A signed-out visitor who is already on one of
 * these is not bounced to /login again (it would carry /login as its own
 * `next`). And none of them is a destination: `next=/login`, followed after
 * signing in, lands back on the login page, which forwards to `next` again,
 * which is a loop. */
export const AUTH_PAGES = ["/login", "/signup", "/verify", "/forgot", "/reset"] as const;
export type AuthPage = (typeof AUTH_PAGES)[number];

/** Where a refused or missing `next` goes: the document, which is the app. */
const FALLBACK = "/app";

const BACKSLASH = 0x5c;
const DEL = 0x7f;

/**
 * Refused before any parsing: anything not starting with one slash, anything
 * starting with two, and any backslash, C0 control character or DEL.
 *
 * The characters are the subtle half. Browsers read a backslash as a slash and
 * silently DELETE tabs and newlines while parsing a URL, so a slash, a
 * backslash and `evil.com` — or a slash, a tab, a slash and `evil.com` — both
 * become `//evil.com`, a link to another site that starts with a single slash.
 * Compared by char code rather than by a regex character class so the rule is
 * readable as written.
 */
function unsafeShape(v: string): boolean {
  if (!v.startsWith("/") || v.startsWith("//")) return true;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === DEL || c === BACKSLASH) return true;
  }
  return false;
}

export function isAuthPage(pathname: string): boolean {
  let bare = pathname;
  while (bare.length > 1 && bare.endsWith("/")) bare = bare.slice(0, -1);
  return (AUTH_PAGES as readonly string[]).includes(bare);
}

/**
 * A same-origin, relative destination, or `/app`.
 *
 * Checked RAW and also ONCE DECODED. `URLSearchParams.get` has already decoded
 * one layer by the time a page holds the value, but a doubly-encoded link
 * (`/%09/evil.com`) still reaches here with its `%09` intact. That is harmless
 * only while nothing decodes it again, and "nothing downstream decodes" is not
 * something this function can promise. A real in-app path is unaffected by the
 * decode, so refusing both forms costs nothing.
 *
 * Then the value is resolved against this origin and must stay on it. That
 * catches every spelling the shape checks did not think of, because it asks the
 * browser's own URL parser, which is the one that will follow the link.
 */
export function safeNext(value: string | null | undefined): string {
  if (!value) return FALLBACK;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return FALLBACK; // a malformed escape is not a path anyone meant
  }
  if (unsafeShape(value) || unsafeShape(decoded)) return FALLBACK;
  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== window.location.origin) return FALLBACK;
  if (isAuthPage(url.pathname)) return FALLBACK;
  return url.pathname + url.search + url.hash;
}

/**
 * `<page>?next=<where the visitor is now>`: the URL that sends someone into the
 * auth flow without losing their place.
 *
 * Path, query AND hash. The Chrome extension hands off through
 * `/app?tailor_app=<id>`, and that id lives only in the query, so a redirect
 * that kept only the path would drop it with no error.
 *
 * Called from an auth page, it passes that page's own `next` along instead of
 * nesting one auth page inside another's.
 */
export function authRedirectUrl(page: AuthPage): string {
  const { pathname, search, hash } = window.location;
  const here = isAuthPage(pathname)
    ? safeNext(new URLSearchParams(search).get("next"))
    : pathname + search + hash;
  return withNext(page, here);
}

/** `<page>?next=<next>`, for links between the auth pages. The default
 * destination is left off rather than spelled out, so a plain /signup link
 * stays plain. */
export function withNext(page: AuthPage, next: string): string {
  return next === FALLBACK ? page : `${page}?next=${encodeURIComponent(next)}`;
}
