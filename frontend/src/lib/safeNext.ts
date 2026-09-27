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

/** The longest `next` anyone may hand us, in characters.
 *
 * The backend twin (`sessions.safe_next`) carries the same number, and there it
 * is load-bearing: Phase 30's anonymous `POST /auth/google/start` STORES the
 * value it is given, and the callback later rebuilds its redirect from the
 * stored copy -- so an unbounded `next` is megabytes written into the database
 * by a caller with no account, and a `Location` header long enough that an HTTP
 * client refuses the sign-in outright. Nothing on this side is stored, but both
 * validators answer the same question about the same link, and a link this side
 * follows while the other refuses is the disagreement this file exists to
 * prevent. The extension's handoff `/app?tailor_app=<id>` is far under it; an
 * alert email's `/jobs?open=<posting>` can be over it, and waits in the tab
 * instead (`fitNext`), so the ceiling never has to move. */
const MAX_NEXT = 512;

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
  return checkNext(value, MAX_NEXT);
}

/** `safeNext`'s rules, every one of them, at a given length ceiling. Only the
 * ceiling differs between a `next` (MAX_NEXT, the backend twin's) and a long
 * destination waiting in this tab (LONG_NEXT_MAX, below), which never reaches
 * the server. */
function checkNext(value: string | null | undefined, max: number): string {
  if (!value) return FALLBACK;
  if (value.length > max) return FALLBACK;
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
  const out = url.pathname + url.search + url.hash;
  // The RESULT is checked again, not only the input. The parser normalises
  // dot segments: `/.//evil.com`, `/%2e//evil.com` and `/app/..//evil.com`
  // all start with one slash and resolve on this origin, and all come back as
  // the path `//evil.com`, which `location.assign` reads as another site.
  if (unsafeShape(out)) return FALLBACK;
  return out;
}

/** Where a validated `next` waits between /forgot and /reset on this device. */
export const RESET_NEXT_KEY = "jobfinder.resetNext";
/** The reset link's own lifetime: a destination older than the link is stale. */
const RESET_NEXT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Remember `next` at /forgot, so the reset that follows lands where the visitor
 * was going. The mail link carries no `next`, so without this a reset always
 * ends on /app and the extension's `/app?tailor_app=<id>` handoff is lost.
 *
 * Stored already validated, and validated AGAIN when taken: storage is not a
 * trusted source. Only on this device, which is fine: a link opened on another
 * device has no handoff to resume there anyway.
 */
export function rememberResetNext(next: string): void {
  try {
    const safe = safeNext(next);
    if (safe === FALLBACK) localStorage.removeItem(RESET_NEXT_KEY);
    else localStorage.setItem(RESET_NEXT_KEY, JSON.stringify({ next: safe, at: Date.now() }));
  } catch {
    /* private mode: the reset lands on /app, as before */
  }
}

/** The remembered destination, once, or `/app`. */
export function takeResetNext(): string {
  try {
    const raw = localStorage.getItem(RESET_NEXT_KEY);
    localStorage.removeItem(RESET_NEXT_KEY);
    if (!raw) return FALLBACK;
    const v = JSON.parse(raw) as { next?: unknown; at?: unknown };
    if (typeof v.next !== "string" || typeof v.at !== "number") return FALLBACK;
    if (Date.now() - v.at > RESET_NEXT_MAX_AGE_MS) return FALLBACK;
    return safeNext(v.next);
  } catch {
    return FALLBACK;
  }
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
    : fitNext(pathname + search + hash);
  return withNext(page, here);
}

/** The query parameter that names a destination waiting in this tab. */
export const LONG_NEXT_PARAM = "jf_next";
/** Where it waits: sessionStorage, THIS tab only, the verify token's home. */
export const LONG_NEXT_KEY = "jobfinder.longNext";
/** The longest destination a tab keeps for itself. It never reaches the server,
 * so MAX_NEXT's two reasons (a stored row, a Location header) do not apply;
 * this only bounds what a stored value may be. */
const LONG_NEXT_MAX = 8192;
/** The reset link's hour, for the same reason: a sign-in older is stale. */
const LONG_NEXT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * `here` as a `next`, when it fits; otherwise its path plus `?jf_next=<ref>`,
 * with the whole destination kept in this tab until the sign-in comes back.
 *
 * A job link from an alert email is `/jobs?open=<the posting's URL, quoted
 * whole>`, and a posting URL longer than about 450 characters (a Comeet slug in
 * Hebrew is ten characters a letter once quoted twice) made the `next` longer
 * than MAX_NEXT: both validators refused it, and the sign-in landed on /app
 * with the job gone (found in PLAN 31.4/6, fixed 2026-09-27). The ceiling is
 * right where it is, so the long value simply never crosses the server: the
 * `next` that does is short, and Google's round trip, which stores `next`,
 * carries it like any other. `takeLongNext` puts the destination back.
 *
 * Validated before it is kept, by every rule `safeNext` has but the length. If
 * storage is refused, the path alone: the right page, if not the job.
 */
function fitNext(here: string): string {
  if (here.length <= MAX_NEXT) return here;
  const safe = checkNext(here, LONG_NEXT_MAX);
  if (safe === FALLBACK) return FALLBACK;
  const path = new URL(safe, window.location.origin).pathname;
  const ref = newRef();
  try {
    sessionStorage.setItem(LONG_NEXT_KEY, JSON.stringify({ ref, next: safe, at: Date.now() }));
  } catch {
    return path;
  }
  return `${path}?${LONG_NEXT_PARAM}=${ref}`;
}

function newRef(): string {
  const bytes = new Uint8Array(8);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Where a page that carries `?jf_next=<ref>` should be, or null when it carries
 * none (almost always: then nothing happens).
 *
 * The destination this tab kept, taken ONCE and validated again (storage is not
 * a trusted source), only when its ref is the one in the address, it is under
 * an hour old, and its path is the page's own: a ref in a link someone crafted
 * can only select what this tab itself stored for this very page. Anything else
 * answers the page's own address without the parameter, so a stale or foreign
 * ref is dropped from the address bar and never followed.
 */
export function takeLongNext(pathname: string, search: string, hash = ""): string | null {
  const params = new URLSearchParams(search);
  const ref = params.get(LONG_NEXT_PARAM);
  if (ref === null) return null;
  params.delete(LONG_NEXT_PARAM);
  const rest = params.toString();
  const without = pathname + (rest ? `?${rest}` : "") + hash;
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(LONG_NEXT_KEY);
    sessionStorage.removeItem(LONG_NEXT_KEY);
  } catch {
    return without;
  }
  if (!raw) return without;
  try {
    const v = JSON.parse(raw) as { ref?: unknown; next?: unknown; at?: unknown };
    if (v.ref !== ref || typeof v.next !== "string" || typeof v.at !== "number") return without;
    if (Date.now() - v.at > LONG_NEXT_MAX_AGE_MS) return without;
    const safe = checkNext(v.next, LONG_NEXT_MAX);
    if (safe === FALLBACK || new URL(safe, window.location.origin).pathname !== pathname) return without;
    return safe;
  } catch {
    return without;
  }
}

/** `<page>?next=<next>`, for links between the auth pages. The default
 * destination is left off rather than spelled out, so a plain /signup link
 * stays plain. */
export function withNext(page: AuthPage, next: string): string {
  return next === FALLBACK ? page : `${page}?next=${encodeURIComponent(next)}`;
}
