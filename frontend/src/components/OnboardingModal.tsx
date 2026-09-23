import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Briefcase, FileText, MessageSquareText, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { markOnboarded } from "../api/client";
import { ONBOARDING_ROUTES, onboardingOptionFor, saveOnboarding, type OnboardingOption } from "../lib/onboarding";
import { useUsesState } from "../lib/usesStore";
import { Button, Modal } from "./ui";
import { cn } from "../lib/cn";

interface Props {
  open: boolean;
  onClose: () => void;
}

// Where each choice leads lives in lib/onboarding.ts, beside the function that
// matches a page to a choice, so the two cannot name different routes.
const HELP_OPTIONS: { id: OnboardingOption; icon: LucideIcon }[] = [
  { id: "jobs", icon: Briefcase },
  { id: "tailor", icon: FileText },
  { id: "interview", icon: MessageSquareText },
];

/** First-visit onboarding: the target role, and where help is needed first.
 * Any way of closing records it on this device AND on the account (PLAN
 * 31.1/11), so it never shows twice, on any device. The "how urgent" question
 * that sat between the two is gone: nothing ever read its answer.
 *
 * The choice FOLLOWS THE PAGE it opens on (Phase 30 / C7). Sign-up carries the
 * visitor's destination, so a new account landing on /tools/scan or /app came
 * for that page; preselecting "Find matching jobs" and sending everyone to
 * /jobs undid that on every route. On a page that is none of the three nothing
 * is chosen and the button only continues, and it moves to another page only
 * when the choice IS another page. check-mirrors 32(i) pins both. */
export default function OnboardingModal({ open, onClose }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const uses = useUsesState();
  const [role, setRole] = useState("");
  const [help, setHelp] = useState<OnboardingOption | null>(() => onboardingOptionFor(pathname));

  function finish(navigateTo?: string) {
    saveOnboarding({ role: role.trim() });
    // Best effort: the device's own record already keeps the modal shut here.
    void markOnboarded().catch(() => {});
    onClose();
    if (navigateTo) navigate(navigateTo);
  }

  // The chosen page, unless it is the page the modal is on.
  const destination = help && onboardingOptionFor(pathname) !== help ? ONBOARDING_ROUTES[help] : undefined;

  return (
    <Modal open={open} onClose={() => finish()} title={t("onboarding.title")} maxWidth="max-w-xl">
      <p className="-mt-2 text-sm text-ink-muted">{t("onboarding.sub")}</p>
      {/* Only a number this page knows (Phase 30 / C7): nothing for the admin, a
          plan with no monthly limit, or an /auth/me that could not be read. */}
      {typeof uses?.limit === "number" && (
        <p className="mt-1 text-sm text-ink-muted">{t("uses.onboarding", { count: uses.limit })}</p>
      )}

      <div className="mt-5 space-y-5">
        <div>
          <label htmlFor="onboarding-role" className="text-sm font-medium text-ink">
            {t("onboarding.roleLabel")}
          </label>
          <input
            id="onboarding-role"
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder={t("onboarding.rolePlaceholder")}
            className="mt-1.5 w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <p className="mt-1 text-xs text-ink-faint">{t("onboarding.roleHint")}</p>
        </div>

        <div>
          <span className="text-sm font-medium text-ink">{t("onboarding.helpLabel")}</span>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
            {HELP_OPTIONS.map(({ id, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-pressed={help === id}
                onClick={() => setHelp(id)}
                className={cn(
                  "rounded-xl border p-3 text-start transition",
                  help === id
                    ? "border-accent/60 bg-accent/10 ring-1 ring-accent/40"
                    : "border-line hover:border-accent/40",
                )}
              >
                <Icon size={18} className={help === id ? "text-accent-soft" : "text-ink-muted"} />
                <div className="mt-2 text-sm font-semibold text-ink">{t(`onboarding.help.${id}.title`)}</div>
                <div className="mt-0.5 text-xs leading-snug text-ink-muted">{t(`onboarding.help.${id}.desc`)}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-end gap-3">
        <Button variant="ghost" onClick={() => finish()}>
          {t("onboarding.skip")}
        </Button>
        <Button onClick={() => finish(destination)}>
          {help ? t("onboarding.start") : t("onboarding.continue")}
        </Button>
      </div>
    </Modal>
  );
}
