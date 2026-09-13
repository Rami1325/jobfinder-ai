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
