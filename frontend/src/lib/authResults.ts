// Readers for two account-response fields the UI has to act on, and the
// one-shot notice that the extension key changed.
//
// Dependency-free, so check-mirrors 30 can run it in node, and so ResetPage
// (a lazy auth page) pulls nothing else in with it.

/** POST /auth/password, /auth/logout-others and /auth/reset say whether the
 * extension key was replaced along with the sessions. `key` is the new key
 * when the response carries it (an invite-code device has to store it, or its
 * next request 401s on the code that was just switched off).
 *
 * Only a literal `true` is a rotation. A response without the field comes from
 * a backend that does not report it, and claiming "your key changed" on that
 * would send the user to re-paste a key that still works. */
export function readKeyRotation(data: unknown): { rotated: boolean; key: string } {
  const d = (data ?? {}) as { extension_key_rotated?: unknown; key?: unknown };
  if (d.extension_key_rotated !== true) return { rotated: false, key: "" };
  return { rotated: true, key: typeof d.key === "string" ? d.key : "" };
}

/** DELETE /inbox/connection: did Google accept the revoke? `null` when the
 * response does not say, which is unknown and never a failure to warn about. */
export function readGoogleRevoked(data: unknown): boolean | null {
  const v = (data ?? {}) as { google_revoked?: unknown };
  return typeof v.google_revoked === "boolean" ? v.google_revoked : null;
}

/** Where to manage (and remove) a Google grant by hand. */
export const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";

const KEY_ROTATED = "jobfinder.extensionKeyRotated";

/** Remember that the extension key changed, so Settings can say so even when
 * the change happened somewhere Settings was not on screen (a password reset).
 * Best-effort: private mode throws, and the toast still said it. */
export function markKeyRotated(): void {
  try {
    localStorage.setItem(KEY_ROTATED, "1");
  } catch {
    /* no notice this session */
  }
}

export function keyRotatedNotice(): boolean {
  try {
    return localStorage.getItem(KEY_ROTATED) === "1";
  } catch {
    return false;
  }
}

/** Cleared once the user has looked at the new key (revealed or copied it). */
export function clearKeyRotated(): void {
  try {
    localStorage.removeItem(KEY_ROTATED);
  } catch {
    /* nothing to do */
  }
}
