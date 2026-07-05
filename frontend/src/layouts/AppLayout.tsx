import { useState, useSyncExternalStore } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { Sparkles, FileText, MessageSquareText, Briefcase, Wrench, KanbanSquare, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import FeedbackButton from "../components/FeedbackButton";
import LanguageSwitch from "../components/LanguageSwitch";
import OnboardingModal from "../components/OnboardingModal";
import ThemeToggle from "../components/ThemeToggle";
import { isOnboarded } from "../lib/onboarding";
import { getJobSearchState, subscribeJobSearch } from "../state/jobSearchStore";

const nav = [
  { to: "/jobs", labelKey: "nav.jobs", icon: Briefcase },
  { to: "/app", labelKey: "nav.tailor", icon: FileText },
  { to: "/interview", labelKey: "nav.interview", icon: MessageSquareText },
  { to: "/tools", labelKey: "nav.tools", icon: Wrench },
  { to: "/tracker", labelKey: "nav.tracker", icon: KanbanSquare },
] as const;

export default function AppLayout() {
  const { t } = useTranslation();
  const { searching } = useSyncExternalStore(subscribeJobSearch, getJobSearchState);
  const [onboardOpen, setOnboardOpen] = useState(() => !isOnboarded());
  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="sticky top-0 z-30 border-b border-line/70 bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <NavLink to="/" className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent-gradient text-white shadow-glow">
              <Sparkles size={15} />
            </span>
            {/* Wordmark hidden on the narrowest screens so 5 nav icons + toggles fit without overflow */}
            <span className="hidden text-[15px] min-[420px]:inline">{t("appName")}</span>
          </NavLink>
          <nav className="flex items-center gap-0.5 sm:gap-1">
            {nav.map(({ to, labelKey, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-1.5 rounded-lg px-2 py-2 text-sm font-medium transition-colors sm:px-3",
                    isActive
                      ? "bg-panel-2 text-ink"
                      : "text-ink-muted hover:bg-panel-2/60 hover:text-ink",
                  )
                }
              >
                <Icon size={15} />
                <span className="hidden sm:inline">{t(labelKey)}</span>
                {to === "/jobs" && searching && (
                  <Loader2 size={13} className="animate-spin text-accent-soft" />
                )}
              </NavLink>
            ))}
            <LanguageSwitch className="ms-1" />
            <ThemeToggle className="ms-1" />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
      <FeedbackButton />
      <OnboardingModal open={onboardOpen} onClose={() => setOnboardOpen(false)} />
    </div>
  );
}
