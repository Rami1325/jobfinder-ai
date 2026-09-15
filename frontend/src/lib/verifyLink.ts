// The email confirmation link, kept for this tab through a log in.
//
// Dependency-free, for lib/accessCode.ts's reason and because check-mirrors 30
// executes it in node with nothing but a stubbed sessionStorage.
//
// Since FIXB B1 a link confirms an address only from a signed-in session of its
// own account: a squatter who signs up with someone else's address must not
// have that person's click confirm the squatter's account. So a link opened in
// a browser without that session cannot finish there by itself. /verify keeps
// the link's token here, the person logs in, and the code page spends it
// straight away (EnterCode). The squatter still loses: nobody can log in to
// the squatter's account but the squatter, so the kept token is never spent.
//
// sessionStorage, not localStorage: the token belongs to the tab that opened
// the link, and closing the tab forgets it. A log out and a log in in that tab
// keep it, because the shared sign-out (lib/session.ts) never touches this
// storage. Mail scanners cannot spend it either: they fetch a link, and the
// spend is a POST made after a person logged in.

/** Where the token waits. */
export const VERIFY_LINK_KEY = "jf-verify-link";
/** The longest token the server reads (accounts._TOKEN_MAX_LEN). */
const MAX_LENGTH = 128;
/** A link token is URL-safe base64 (the server mints it with token_urlsafe). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+$/;
/** The link's own lifetime: a token kept longer than this is stale. */
const MAX_AGE_MS = 60 * 60 * 1000;
/** The refusals that spend a link for good. Every other failure (another
 * account's session, a dropped connection, a server error) keeps it for the
 * next log in. An unknown link reads as `used` on the server. */
const SPENT = new Set(["used", "expired", "invalid"]);

export type StoredLinkOutcome = "none" | "verified" | "failed";

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_LENGTH && TOKEN_SHAPE.test(value);
}

function forget(): void {
  try {
    sessionStorage.removeItem(VERIFY_LINK_KEY);
  } catch {
    /* blocked storage kept nothing to forget */
  }
}

/** Keep a link's token for this tab. A value that is not a link token is not kept. */
export function rememberVerifyLink(token: string): void {
  if (!isToken(token)) return;
  try {
    sessionStorage.setItem(VERIFY_LINK_KEY, JSON.stringify({ token, at: Date.now() }));
  } catch {
    /* private mode or blocked storage: the 6-digit code still works */
  }
}

/** The kept token, or null. Storage is not a trusted source, so a bad shape or
 * a stale entry is dropped rather than returned. */
export function peekVerifyLink(): string | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(VERIFY_LINK_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { token?: unknown; at?: unknown } | null;
    if (v && isToken(v.token) && typeof v.at === "number" && Date.now() - v.at <= MAX_AGE_MS) return v.token;
  } catch {
    /* not JSON: dropped below */
  }
  forget();
  return null;
}

/** An API error's structured `code`, or null. Read here rather than through
 * lib/apiError, which imports i18n. */
function codeOf(err: unknown): string | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail;
  const code = typeof detail === "object" && detail !== null ? (detail as { code?: unknown }).code : null;
  return typeof code === "string" ? code : null;
}

/**
 * Spend the kept token, if there is one, through `verify` (POST /auth/verify).
 *
 * "none": nothing kept, and nothing is sent. "verified": the address is
 * confirmed and the token forgotten. "failed": anything else, and the page
 * shows the code form. The token is forgotten when the server says the link is
 * spent, and KEPT on `session_required` (this browser holds another account)
 * or when no answer came, so a log out and a log in can still spend it.
 *
 * Never throws: the code form must open whatever happens here.
 */
export async function consumeStoredLink(
  verify: (token: string) => Promise<{ verified?: boolean } | null | undefined>,
): Promise<StoredLinkOutcome> {
  const token = peekVerifyLink();
  if (token === null) return "none";
  try {
    const result = await verify(token);
    if (result?.verified !== true) return "failed";
    forget();
    return "verified";
  } catch (err) {
    const code = codeOf(err);
    if (code !== null && SPENT.has(code)) forget();
    return "failed";
  }
}
