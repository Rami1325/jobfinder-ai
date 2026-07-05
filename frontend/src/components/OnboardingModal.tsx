import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Briefcase, FileText, MessageSquareText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { saveOnboarding } from "../lib/onboarding";
import { Button, Modal } from "./ui";
import { cn } from "../lib/cn";

interface Props {
  open: boolean;
  onClose: () => void;
}

const TIMELINES = ["now", "soon", "exploring"] as const;

const HELP_OPTIONS = [
  { id: "jobs", to: "/jobs", icon: Briefcase },
  { id: "tailor", to: "/app", icon: FileText },
  { id: "interview", to: "/interview", icon: MessageSquareText },
] as const;

/** First-visit, 3-question goal onboarding: target role, timeline, and where
 * help is needed first — the last answer routes to Jobs, Tailor, or Interview.
 * Any way of closing persists, so it never shows twice. */
export default function OnboardingModal({ open, onClose }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [role, setRole] = useState("");
  const [timeline, setTimeline] = useState("");
  const [help, setHelp] = useState<(typeof HELP_OPTIONS)[number]["id"]>("jobs");

  function finish(navigateTo?: string) {
    saveOnboarding({ role: role.trim(), timeline });
    onClose();
    if (navigateTo) navigate(navigateTo);
  }

  return (
    <Modal open={open} onClose={() => finish()} title={t("onboarding.title")} maxWidth="max-w-xl">
      <p className="-mt-2 mb-5 text-sm text-ink-muted">{t("onboarding.sub")}</p>

      <div className="space-y-5">
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
          <span className="text-sm font-medium text-ink">{t("onboarding.timelineLabel")}</span>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {TIMELINES.map((tl) => (
              <button
                key={tl}
                type="button"
                aria-pressed={timeline === tl}
                onClick={() => setTimeline(timeline === tl ? "" : tl)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm font-medium transition",
                  timeline === tl
                    ? "border-accent/60 bg-accent/15 text-accent-soft"
                    : "border-line text-ink-muted hover:border-accent/40 hover:text-ink",
                )}
              >
                {t(`onboarding.timeline.${tl}`)}
              </button>
            ))}
          </div>
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
        <Button onClick={() => finish(HELP_OPTIONS.find((o) => o.id === help)?.to)}>
          {t("onboarding.start")}
        </Button>
      </div>
    </Modal>
  );
}
