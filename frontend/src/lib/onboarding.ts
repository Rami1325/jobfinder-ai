// First-visit onboarding answers. Whether the questions are DONE is recorded on
// the account (POST /profile/onboarded, PLAN 31.1/11), so no device asks again;
// this device keeps its own record too, and the target role, which prefills the
// job search until the user customizes it away. The "how urgent" question is
// gone: nothing ever read its answer.
export interface OnboardingAnswers {
  role: string;
}

const KEY = "jf-onboarding-v1";

export function isOnboarded(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return true; // storage unavailable — never nag
  }
}

export function saveOnboarding(answers: OnboardingAnswers): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(answers));
  } catch {
    /* private mode — the modal just shows again next visit */
  }
}

/** Record on this device that the account is onboarded, keeping any stored
 * role. The account said so (/auth/me), so this device must not ask either. */
export function markOnboardedHere(): void {
  try {
    if (localStorage.getItem(KEY) === null) localStorage.setItem(KEY, JSON.stringify({ role: "" }));
  } catch {
    /* storage unavailable — the account's record still keeps the modal shut */
  }
}

/** What the shell does once /auth/me has answered (PLAN 31.1/11). `account` is
 * that answer's `onboarded`: undefined from a backend older than the field, or
 * when the guard failed open and no account is known. `here` is this device's
 * own record (`isOnboarded()`).
 *  - "ask":    nobody has answered: open the first-run questions.
 *  - "adopt":  the account answered on another device: record it here as well.
 *  - "report": this device answered before the account kept a record: tell it.
 *  - "none":   both agree, or there is no account to tell.
 * A sign-out clears this device's record, so the same account signing back in
 * is "adopt", not "ask": it is not asked again, and only the role prefill,
 * which is this device's alone, is gone. check-mirrors 52 runs every pair. */
export type OnboardingStep = "ask" | "adopt" | "report" | "none";

export function onboardingStep(account: boolean | undefined, here: boolean): OnboardingStep {
  if (account === true) return here ? "none" : "adopt";
  if (!here) return "ask";
  return account === false ? "report" : "none";
}

/** Forget the answers. Called on sign-out: the target role belongs to one
 * person, and on a shared device it would otherwise prefill the NEXT account's
 * job search and skip that account's own onboarding. */
export function clearOnboarding(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — nothing was stored either */
  }
}

/** Where each first-visit choice leads. The modal adds its icons and its copy. */
export const ONBOARDING_ROUTES = {
  jobs: "/jobs",
  tailor: "/app",
  interview: "/interview",
} as const;

export type OnboardingOption = keyof typeof ONBOARDING_ROUTES;

/** The choice that matches the page the modal opened on, or null for any other
 * page (Phase 30 / C7). Sign-up carries its destination in `next`, so the first
 * page a new account sees is the one it came for, and the modal must not steer
 * it anywhere else; it used to preselect "Find matching jobs" and send everyone
 * to /jobs. Exact paths only, where a trailing slash is the same page. */
export function onboardingOptionFor(pathname: string): OnboardingOption | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  for (const option of Object.keys(ONBOARDING_ROUTES) as OnboardingOption[])
    if (ONBOARDING_ROUTES[option] === path) return option;
  return null;
}

/** The target role from onboarding, "" when unanswered. */
export function onboardingRole(): string {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw) as Partial<OnboardingAnswers>;
    return typeof parsed.role === "string" ? parsed.role.trim() : "";
  } catch {
    return "";
  }
}
