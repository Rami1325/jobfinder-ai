import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  FileText,
  MessageSquareText,
  Briefcase,
  Wrench,
  KanbanSquare,
  Loader2,
  X,
  ShieldCheck,
  ChevronDown,
  ScanLine,
  ScanEye,
  Building2,
  HeartPulse,
  Send,
  Contact,
  Mail,
  MoreHorizontal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
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

type NavEntry = { to: string; labelKey: string; icon: LucideIcon };

const primaryNav: NavEntry[] = [
  { to: "/app", labelKey: "nav.resume", icon: FileText },
  { to: "/jobs", labelKey: "nav.jobs", icon: Briefcase },
  { to: "/tracker", labelKey: "nav.tracker", icon: KanbanSquare },
];

const moreNav: NavEntry[] = [
  { to: "/interview", labelKey: "nav.interview", icon: MessageSquareText },
];

// Sub-tools listed under the Tools entry — mirrors the cards on ToolsPage
// (labels come from the "tools" namespace so the two stay in sync).
const toolsSubNav = [
  { to: "/tools/ats", key: "ats", icon: ScanLine },
  { to: "/tools/xray", key: "xray", icon: ScanEye },
  { to: "/tools/company-brief", key: "brief", icon: Building2 },
  { to: "/tools/resume-health", key: "health", icon: HeartPulse },
  { to: "/tools/outreach", key: "outreach", icon: Send },
  { to: "/tools/screening", key: "screening", icon: MessageSquareText },
  { to: "/tools/linkedin", key: "linkedin", icon: Contact },
  { to: "/tools/follow-up", key: "followup", icon: Mail },
] as const;

function NavItem({
  to,
  icon: Icon,
  label,
  trailing,
  end,
  onNavigate,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  trailing?: ReactNode;
  end?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={to}
      end={end}
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

/** The Tools nav entry with its sub-tools nested underneath. Clicking Tools
 * navigates to /tools and expands the list; it auto-expands whenever a
 * /tools route is active and collapses on a repeat click while inside. */
function ToolsNavGroup({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { t: tTools } = useTranslation("tools");
  const { pathname } = useLocation();
  const inTools = pathname.startsWith("/tools");
  const [open, setOpen] = useState(inTools);

  useEffect(() => {
    if (inTools) setOpen(true);
  }, [inTools]);

  return (
    <div>
      <NavItem
        to="/tools"
        end
        icon={Wrench}
        label={t("nav.tools")}
        trailing={
          <ChevronDown
            size={15}
            className={cn("transition-transform duration-200", open && "rotate-180")}
          />
        }
        onNavigate={() => {
          setOpen(inTools ? !open : true);
          onNavigate?.();
        }}
      />
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="ms-4 mt-0.5 space-y-0.5 border-s border-line/70 ps-2 pb-1">
              {toolsSubNav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      "relative flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                      isActive
                        ? "font-semibold text-ink"
                        : "text-ink-muted hover:bg-panel-2/60 hover:text-ink",
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <motion.span
                          layoutId="nav-pill"
                          aria-hidden
                          transition={{ type: "spring", stiffness: 550, damping: 45 }}
                          className="absolute inset-0 rounded-lg bg-panel-2"
                        >
                          <span className="absolute inset-y-1.5 start-1 w-1 rounded-full bg-accent" />
                        </motion.span>
                      )}
                      <item.icon size={15} className="relative shrink-0" />
                      <span className="relative min-w-0 flex-1 truncate">
                        {tTools(`cards.${item.key}.title`)}
                      </span>
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
      <Link to="/app" onClick={onNavigate} aria-label={t("appName")} className="mb-6 px-2">
        <Logo size={30} />
      </Link>

      {/* min-h-0 + overflow: the expanded Tools sub-list can outgrow short
          viewports — scroll the nav area, keep the trust badge pinned. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
      <SectionLabel className="px-3">{t("nav.primary")}</SectionLabel>
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
        <ToolsNavGroup onNavigate={onNavigate} />
      </nav>
      </div>

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

/** Bottom tab bar — the primary navigation on phones. Always visible and
 * thumb-reachable (the drawer behind the old hamburger hid every destination).
 * The three core destinations get a tab each; "More" opens the drawer with the
 * rest (Interview, Tools) — three plus More is the four-item bar.
 *
 * INVARIANT: `moreActive` (see the call site) must never be true while any
 * primaryNav NavLink is active. This function has no <LayoutGroup> of its own,
 * so both layoutId="tabbar-dash" spans below — the NavLink dash and the More
 * dash — register in the ROOT projection stack under the bare id, and two live
 * members crossfade into a doubled, ghosted dash instead of sliding. Nothing
 * checks this. Hidden on lg+ where the sidebar rail takes over. */
function MobileTabBar({
  searching,
  moreActive,
  onMore,
}: {
  searching: boolean;
  moreActive: boolean;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  const tabCls = (active: boolean) =>
    cn(
      "relative flex min-w-0 flex-1 flex-col items-center gap-1 pb-1.5 pt-2 text-xs font-semibold transition-colors",
      active ? "text-accent-soft" : "text-ink-muted",
    );
  return (
    <nav
      aria-label={t("nav.primary")}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line/70 bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
    >
      <div className="mx-auto flex max-w-md items-stretch">
        {primaryNav.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => tabCls(isActive)}>
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId="tabbar-dash"
                    aria-hidden
                    transition={{ type: "spring", stiffness: 550, damping: 45 }}
                    className="absolute top-0 h-0.5 w-9 rounded-full bg-accent"
                  />
                )}
                <span className="relative">
                  <item.icon size={21} strokeWidth={isActive ? 2.2 : 1.7} />
                  {item.to === "/jobs" && searching && (
                    <span
                      role="status"
                      aria-label={t("nav.searching")}
                      className="absolute -end-1 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-accent"
                    />
                  )}
                </span>
                <span className="max-w-full truncate">{t(item.labelKey)}</span>
              </>
            )}
          </NavLink>
        ))}
        <button type="button" onClick={onMore} className={tabCls(moreActive)}>
          {moreActive && (
            <motion.span
              layoutId="tabbar-dash"
              aria-hidden
              transition={{ type: "spring", stiffness: 550, damping: 45 }}
              className="absolute top-0 h-0.5 w-9 rounded-full bg-accent"
            />
          )}
          <MoreHorizontal size={21} strokeWidth={moreActive ? 2.2 : 1.7} />
          <span className="max-w-full truncate">{t("nav.more")}</span>
        </button>
      </div>
    </nav>
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

  // Must stay disjoint from every primaryNav `to` — see the MobileTabBar
  // invariant. Home was deleted rather than moved into the drawer, so the two
  // sets are still disjoint.
  const moreActive = pathname.startsWith("/interview") || pathname.startsWith("/tools");

  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  const closed = rtl ? "100%" : "-100%";

  return (
    <div className="min-h-dvh bg-bg text-ink lg:flex">
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-e border-line/70 bg-bg-soft/60 px-3 py-5 lg:block">
        <SidebarBody group="rail" searching={searching} />
      </aside>

      {/* Mobile top bar — brand + utilities only; navigation lives in the
          bottom tab bar where thumbs can reach it. */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line/70 bg-bg/80 px-4 py-3 backdrop-blur-xl lg:hidden">
        <Link to="/app" aria-label={t("appName")}>
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
        {/* pb clears the fixed bottom tab bar on phones. */}
        <main className="mx-auto max-w-6xl px-4 pb-24 pt-8 lg:px-8 lg:pb-8">
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

      <MobileTabBar
        searching={searching}
        moreActive={moreActive}
        onMore={() => setMenuOpen(true)}
      />

      <FeedbackButton />
      <OnboardingModal open={onboardOpen} onClose={() => setOnboardOpen(false)} />
    </div>
  );
}
