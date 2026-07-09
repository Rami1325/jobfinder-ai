import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  Home,
  FileText,
  MessageSquareText,
  Briefcase,
  Wrench,
  KanbanSquare,
  Loader2,
  Menu,
  X,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { SectionLabel } from "../components/ui";
import Logo from "../components/Logo";
import FeedbackButton from "../components/FeedbackButton";
import LanguageSwitch from "../components/LanguageSwitch";
import OnboardingModal from "../components/OnboardingModal";
import ThemeToggle from "../components/ThemeToggle";
import { isOnboarded } from "../lib/onboarding";
import { getJobSearchState, subscribeJobSearch } from "../state/jobSearchStore";

type NavEntry = { to: string; labelKey: string; icon: typeof Home };

const primaryNav: NavEntry[] = [
  { to: "/home", labelKey: "nav.home", icon: Home },
  { to: "/jobs", labelKey: "nav.jobs", icon: Briefcase },
  { to: "/app", labelKey: "nav.tailor", icon: FileText },
  { to: "/tracker", labelKey: "nav.tracker", icon: KanbanSquare },
];

const moreNav: NavEntry[] = [
  { to: "/interview", labelKey: "nav.interview", icon: MessageSquareText },
  { to: "/tools", labelKey: "nav.tools", icon: Wrench },
];

function NavItem({
  to,
  icon: Icon,
  label,
  trailing,
  onNavigate,
}: {
  to: string;
  icon: typeof Home;
  label: string;
  trailing?: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isActive
            ? "font-semibold text-ink"
            : "text-ink-muted hover:bg-panel-2/60 hover:text-ink",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            // Shared-layout pill: slides between nav entries on route change.
            // The LayoutGroup id in SidebarBody keeps rail/drawer copies apart.
            <motion.span
              layoutId="nav-pill"
              aria-hidden
              transition={{ type: "spring", stiffness: 550, damping: 45 }}
              className="absolute inset-0 rounded-lg bg-panel-2"
            >
              <span className="absolute inset-y-2 start-1 w-1 rounded-full bg-accent" />
            </motion.span>
          )}
          <Icon size={17} className="relative shrink-0" />
          <span className="relative min-w-0 flex-1 truncate">{label}</span>
          {trailing && <span className="relative shrink-0">{trailing}</span>}
        </>
      )}
    </NavLink>
  );
}

/** The sidebar body — shared verbatim between the desktop rail and the mobile
 * drawer, so there is one source of truth for navigation. `group` namespaces
 * the sliding nav-pill layoutId: both copies are mounted at once on mobile
 * (the rail is display:none, not unmounted), and duplicate layoutIds would
 * make the pill jump between them. */
function SidebarBody({
  group,
  searching,
  onNavigate,
}: {
  group: string;
  searching: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const spinner = searching ? (
    <Loader2
      size={14}
      role="status"
      aria-label={t("nav.searching")}
      className="shrink-0 animate-spin text-accent-soft"
    />
  ) : undefined;
  return (
    <LayoutGroup id={group}>
    <div className="flex h-full flex-col">
      <Link to="/home" onClick={onNavigate} aria-label={t("appName")} className="mb-6 px-2">
        <Logo size={30} />
      </Link>

      <SectionLabel className="px-3">{t("nav.overview")}</SectionLabel>
      <nav className="mt-1.5 space-y-0.5">
        {primaryNav.map((item) => (
          <NavItem
            key={item.to}
            to={item.to}
            icon={item.icon}
            label={t(item.labelKey)}
            trailing={item.to === "/jobs" ? spinner : undefined}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <SectionLabel className="mt-5 px-3">{t("nav.more")}</SectionLabel>
      <nav className="mt-1.5 space-y-0.5">
        {moreNav.map((item) => (
          <NavItem
            key={item.to}
            to={item.to}
            icon={item.icon}
            label={t(item.labelKey)}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <div className="flex-1" />

      <div className="mx-1 mb-3 flex items-center gap-2 rounded-lg border border-mint/35 bg-mint/10 px-3 py-2 text-xs font-semibold text-mint">
        <ShieldCheck size={15} className="shrink-0" />
        {t("nav.trust")}
      </div>
      <div className="flex items-center gap-2 px-1">
        <LanguageSwitch />
        <ThemeToggle />
      </div>
    </div>
    </LayoutGroup>
  );
}

export default function AppLayout() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { searching } = useSyncExternalStore(subscribeJobSearch, getJobSearchState);
  const [onboardOpen, setOnboardOpen] = useState(() => !isOnboarded());
  const [menuOpen, setMenuOpen] = useState(false);

  // Drawer: lock body scroll + close on Escape (mirrors the Modal pattern).
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  const closed = rtl ? "100%" : "-100%";

  return (
    <div className="min-h-dvh bg-bg text-ink lg:flex">
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-e border-line/70 bg-bg-soft/60 px-3 py-5 lg:block">
        <SidebarBody group="rail" searching={searching} />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line/70 bg-bg/80 px-4 py-3 backdrop-blur-xl lg:hidden">
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label={t("nav.openMenu")}
          className="grid h-9 w-9 place-items-center rounded-lg border border-line text-ink-muted transition-colors hover:bg-panel-2/60 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          <Menu size={19} />
        </button>
        <Link to="/home" aria-label={t("appName")}>
          <Logo size={26} />
        </Link>
        {searching && (
          <Loader2
            size={15}
            role="status"
            aria-label={t("nav.searching")}
            className="animate-spin text-accent-soft"
          />
        )}
        <div className="ms-auto flex items-center gap-2">
          <LanguageSwitch />
          <ThemeToggle />
        </div>
      </header>

      {/* Mobile drawer */}
      <AnimatePresence>
        {menuOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
              onClick={() => setMenuOpen(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
            <motion.aside
              className="fixed inset-y-0 start-0 z-50 flex w-72 max-w-[82vw] flex-col border-e border-line bg-bg-soft px-3 py-5 shadow-panel lg:hidden"
              initial={{ x: closed }}
              animate={{ x: 0 }}
              exit={{ x: closed }}
              transition={{ type: "tween", duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            >
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label={t("nav.closeMenu")}
                className="absolute end-3 top-5 grid h-8 w-8 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-panel-2 hover:text-ink"
              >
                <X size={18} />
              </button>
              <SidebarBody group="drawer" searching={searching} onNavigate={() => setMenuOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Content — remounts with a fast fade+rise per route. Enter-only by
          design (no exit choreography): product register, 160 ms, never makes
          the user wait. */}
      <div className="min-w-0 flex-1">
        <main className="mx-auto max-w-6xl px-4 py-8 lg:px-8">
          <motion.div
            key={pathname}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          >
            <Outlet />
          </motion.div>
        </main>
      </div>

      <FeedbackButton />
      <OnboardingModal open={onboardOpen} onClose={() => setOnboardOpen(false)} />
    </div>
  );
}
