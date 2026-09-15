// First-visit onboarding answers, persisted per device. The modal shows once;
// the target role prefills the job search until the user customizes it away.
export interface OnboardingAnswers {
  role: string;
  timeline: string; // "now" | "soon" | "exploring" | ""
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
