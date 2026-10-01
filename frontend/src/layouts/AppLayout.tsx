import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  FileText,
  MessageSquareText,
  Briefcase,
  Wrench,
  KanbanSquare,
  Loader2,
  ShieldCheck,
  ChevronDown,
  ScanEye,
  ScanSearch,
  Building2,
  Send,
  Contact,
  Handshake,
  Mail,
  MoreHorizontal,
  Settings,
  LogOut,
  User,
  Languages,
  MessageSquarePlus,
  Moon,
  Sun,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { SectionLabel } from "../components/ui";
import Logo from "../components/Logo";
import FeedbackButton from "../components/FeedbackButton";
import GoogleNotice from "../components/GoogleNotice";
import LanguageSwitch from "../components/LanguageSwitch";
import ThemeToggle from "../components/ThemeToggle";
import { getAuthMe, refreshUses } from "../api/client";
import { setLanguage } from "../i18n";
import { useTheme } from "../hooks/useTheme";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { authRedirectUrl, takeLongNext } from "../lib/safeNext";
import { signOut } from "../lib/session";
import { announceAccount, watchAccount } from "../lib/accountWatch";
import { awaitingReview } from "../lib/kitsReview";
import { shouldRefreshUses, usesFor, useUsesState } from "../lib/usesStore";
import { getJobSearchState, subscribeJobSearch } from "../state/jobSearchStore";
import { getKitsState, loadKits, subscribeKits } from "../state/kitsStore";
import type { Me } from "../types";

type NavEntry = {
  to: string;
  labelKey: string;
  icon: LucideIcon;
  /** This entry carries the search's live indicator (the spinner, the dot).
   *
   * A FLAG, not a route-string comparison. Comparing `item.to` against a
   * hard-coded path is documented in CLAUDE.md as fragile — renaming the route
   * silently kills the indicator — and hoisting the path into a shared constant
   * is NOT the fix: check-mirrors check 9 scrapes route LITERALS out of this
   * table and guards only on the count being non-zero, so a constant would make
   * the Jobs destination quietly stop being validated. The literal stays in the
   * table; nothing has to repeat it. */
  live?: true;
  /** Path PREFIXES whose pages also light this entry: pages you reach from it,
   * at addresses of their own (PLAN 31.4: a job's page, `/applications/:id`,
   * and a batch draft's, `/kits/:id`, belong to the Tracker). Prefixes, not
   * destinations, so check 9 has no route to resolve for them. They must stay
   * disjoint from `moreActive`. */
  also?: readonly string[];
  /** This entry carries the count of drafts waiting for review: the Tracker,
   * whose To review lists them (PLAN 31.4/5; it rode the Jobs entry while a
   * Kits tab there listed them). A flag, for `live`'s reason. */
  drafts?: true;
};

const primaryNav: NavEntry[] = [
  { to: "/app", labelKey: "nav.resume", icon: FileText },
  { to: "/jobs", labelKey: "nav.jobs", icon: Briefcase, live: true },
  { to: "/tracker", labelKey: "nav.tracker", icon: KanbanSquare, also: ["/applications/", "/kits/"], drafts: true },
];

const moreNav: NavEntry[] = [
  { to: "/interview", labelKey: "nav.interview", icon: MessageSquareText },
];

// Sub-tools listed under the Tools entry, the same list as the cards on
// ToolsPage (labels come from the "tools" namespace). The label is a template
// literal check 9 cannot resolve, so check-mirrors 32(f) holds this table and
// ToolsPage's to one list and resolves every name in both locales.
const toolsSubNav = [
  { to: "/tools/scan", key: "scan", icon: ScanSearch },
  { to: "/tools/xray", key: "xray", icon: ScanEye },
  { to: "/tools/company-brief", key: "brief", icon: Building2 },
  { to: "/tools/outreach", key: "outreach", icon: Send },
  { to: "/tools/screening", key: "screening", icon: MessageSquareText },
  { to: "/tools/proposal", key: "proposal", icon: Handshake },
  { to: "/tools/linkedin", key: "linkedin", icon: Contact },
  { to: "/tools/follow-up", key: "followup", icon: Mail },
] as const;

/** Escape, or a pointerdown anywhere outside `ref`, closes an open popover.
 *
 * `pointerdown` in the CAPTURE phase, not `click`: a page handler that calls
 * stopPropagation() — the resume sheet has several — must not be able to strand
 * an open menu on screen, and capture runs before any of them. The trigger
 * button lives INSIDE `ref` on purpose, so its own onClick toggle is the only
 * thing that reacts to a click on it; handling it here too would close and
 * reopen in the same gesture.
 *
 * `[data-dismiss-keep]` is the escape hatch for a SECOND trigger that cannot
 * live inside `ref` — the tab bar's More button, which is a sibling subtree.
 * Without it that button is not a toggle at all for anything that activates it
 * by dispatching pointer events AT the element rather than hit-testing (a
 * screen reader does exactly that): the pointerdown closes the panel and the
 * click that follows reopens it, so the control silently does nothing. */
function useDismiss(ref: RefObject<HTMLElement>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.("[data-dismiss-keep]")) return;
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [ref, open, close]);
}

function NavItem({
  to,
  icon: Icon,
  label,
  trailing,
  end,
  also,
  onNavigate,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  trailing?: ReactNode;
  end?: boolean;
  also?: readonly string[];
  onNavigate?: () => void;
}) {
  const { pathname } = useLocation();
  const lit = (isActive: boolean) => isActive || !!also?.some((p) => pathname.startsWith(p));
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          // A 44 px row (the third tap-target pass; 36 before, stacked 2 px apart).
          "relative flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          lit(isActive)
            ? "font-semibold text-ink"
            : "text-ink-muted hover:bg-panel-2/60 hover:text-ink",
        )
      }
    >
      {({ isActive: own }) => {
        const isActive = lit(own);
        return (
        <>
          {isActive && (
            // Shared-layout pill: slides between nav entries. The panel is the
            // ONLY thing that mounts a NavItem now (the desktop rail is gone),
            // so a single LayoutGroup id is enough — the old `group` prop
            // existed because rail and drawer were both mounted at once on
            // mobile and duplicate layoutIds made the pill jump between them.
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
        );
      }}
    </NavLink>
  );
}

/**
 * The product map: every destination this app has, in one panel.
 *
 * Flat, not collapsible. The old rail hid the eight tools behind a disclosure
 * that animated `height: "auto"` — the one motion CLAUDE.md forbids on a
 * click-to-open element — and the reason it existed (a 240px rail with a fixed
 * viewport height) is gone. A menu you open on purpose can afford to answer
 * "what is in here?" in one glance; that is the whole complaint this replaces.
 */
function MenuPanel({
  searching,
  awaiting,
  onNavigate,
  sheet = false,
}: {
  searching: boolean;
  awaiting: number;
  onNavigate: () => void;
  /** Below `lg`: the More sheet the tab bar opens, from the bottom where the
   * thumb that opened it is (PLAN 31.2/8). It leaves out the three
   * destinations the tab bar already shows. It used to be this same panel
   * dropping from the TOP of the screen, far from that thumb, repeating them. */
  sheet?: boolean;
}) {
  const { t } = useTranslation();
  const { t: tTools } = useTranslation("tools");
  const sheetRef = useRef<HTMLDivElement>(null);
  // The sheet is modal: it takes focus, keeps Tab inside, and hands focus back
  // to the More tab when it closes (check-mirrors 42's hook). The dropdown is not.
  useDialogFocus(sheet, sheetRef);

  const spinner = searching ? (
    <Loader2
      size={14}
      role="status"
      aria-label={t("nav.searching")}
      className="shrink-0 animate-spin text-accent-soft"
    />
  ) : undefined;
  // A finished background batch is otherwise INVISIBLE until someone thinks to
  // look: BatchTailorCard tailors asynchronously, and nothing on any other page
  // said so. The count is drafts with status "done" — tailored and waiting for a
  // human — which is exactly what approveKit requires. It rides the Tracker,
  // whose To review lists them (PLAN 31.4/5), so the search's spinner on Jobs
  // and this count no longer share an entry.
  const kitsBadge =
    awaiting > 0 ? (
      <span
        title={t("nav.kitsAwaiting", { count: awaiting })}
        aria-label={t("nav.kitsAwaiting", { count: awaiting })}
        className="grid min-w-[18px] place-items-center rounded-full bg-accent px-1.5 py-px text-[11px] font-bold leading-tight tabular-nums text-white"
      >
        {awaiting}
      </span>
    ) : undefined;

  const body = (
    // Caps the column on tablets. No effect at 390px (max-w-md is wider than
    // the viewport), so the phone still gets a full-bleed sheet.
    <div className="mx-auto w-full max-w-md lg:max-w-none">
      {!sheet && (
        <>
          <SectionLabel className="px-3">{t("nav.primary")}</SectionLabel>
          <div className="mt-1.5 space-y-0.5">
            {primaryNav.map((item) => (
              <NavItem
                key={item.to}
                to={item.to}
                icon={item.icon}
                label={t(item.labelKey)}
                trailing={item.live ? spinner : item.drafts ? kitsBadge : undefined}
                also={item.also}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </>
      )}

      <SectionLabel className={cn("px-3", !sheet && "mt-5")}>{t("nav.more")}</SectionLabel>
      <div className="mt-1.5 space-y-0.5">
        {moreNav.map((item) => (
          <NavItem
            key={item.to}
            to={item.to}
            icon={item.icon}
            label={t(item.labelKey)}
            onNavigate={onNavigate}
          />
        ))}
        {/* `end`: /tools is the index card grid, so it must not stay lit
            while one of the eight sub-tools below is the active route. */}
        <NavItem
          to="/tools"
          end
          icon={Wrench}
          label={t("nav.tools")}
          onNavigate={onNavigate}
        />
        <div className="ms-4 mt-0.5 space-y-0.5 border-s border-line/70 ps-2">
          {toolsSubNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  // 44 px, as every nav row is (the third tap-target pass; 31.5).
                  "relative flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors",
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
      </div>

      {/* The trust badge followed the nav out of the deleted rail. It says
          what this product refuses to do, so it belongs where the whole
          product is listed — and rendering t("nav.trust") from THIS file is
          what keeps check-mirrors check 9 guarding the key. */}
      <div className="mt-5 flex items-center gap-2 rounded-lg border border-mint/35 bg-mint/10 px-3 py-2 text-xs font-semibold text-mint">
        <ShieldCheck size={15} className="shrink-0" />
        {t("nav.trust")}
      </div>
    </div>
  );

  if (sheet)
    return (
      <LayoutGroup id="nav">
        {/* A dialog holding the nav, not a nav claiming to be a dialog. It sits
            on the modal layer (z-50, like BlockEditSheet) OVER the tab bar, with
            its own scroller; `overscroll-contain` keeps a drag that reaches the
            end of the list from scrolling the page behind the backdrop. Only
            transform and opacity move (house rule: never a height). */}
        <motion.div
          ref={sheetRef}
          id="app-more-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={t("nav.more")}
          tabIndex={-1}
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-line bg-bg-soft px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2 shadow-panel focus:outline-none lg:hidden"
        >
          <div aria-hidden className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
          <nav aria-label={t("nav.menu")}>{body}</nav>
        </motion.div>
      </LayoutGroup>
    );

  return (
    <LayoutGroup id="nav">
      {/* lg and up only: the header's Menu is hidden below lg, where the tab
          bar is the nav and More opens the sheet above. */}
      <motion.nav
        id="app-menu-panel"
        aria-label={t("nav.menu")}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        className="absolute start-0 top-[calc(100%+0.5rem)] max-h-[calc(100dvh-5rem)] w-[21rem] overflow-y-auto overscroll-contain rounded-2xl border border-line bg-bg-soft px-3 pb-4 pt-4 shadow-panel"
      >
        {body}
      </motion.nav>
    </LayoutGroup>
  );
}

/** This month's uses, in the phone header, which is the logo, this and the
 * avatar (PLAN 31.2/8). Only a count this page knows: nothing for the admin, a
 * plan with no monthly limit, or an /auth/me that could not be read, the
 * account menu's rule (cost-and-quota.md). At lg the account menu's line says
 * it. In AppLayout.tsx for check 9's reason; check-mirrors 32(d) reads it. */
function UsesLeft() {
  const { t } = useTranslation();
  const uses = usesFor("", undefined, useUsesState());
  if (!uses.limited || uses.remaining === null) return null;
  return (
    <span className="shrink-0 rounded-full border border-line px-2.5 py-1 text-xs font-semibold tabular-nums text-ink-muted lg:hidden">
      {uses.remaining === 0 ? t("uses.headerNone") : t("uses.headerLeft", { count: uses.remaining })}
    </span>
  );
}

/**
 * The account menu — identity, settings, and the two ways out.
 *
 * DEFINED HERE, not in a components/ file of its own, and that is deliberate:
 * check-mirrors check 9 is scoped to AppLayout.tsx, so a nav destination or a
 * nav-namespace label ANYWHERE ELSE is guarded by nothing — a dead destination
 * falls through the catch-all to the marketing landing and reads as being
 * logged out, and a renamed label renders the raw key at 12px in Hebrew while
 * check 8 stays green (en and he are still in parity with each other). It is
 * also the documented "the nav is one table" invariant: one file, one set of
 * destinations.
 *
 * "Close my account" NAVIGATES. Nothing irreversible is reachable from a menu —
 * the two-step confirm lives in the Settings danger zone and stays there. The
 * label is the SECOND danger-zone button's words, verbatim, and that is not
 * cosmetic: the zone holds two doors that do deliberately different things
 * (the smoke test pins that they differ), and an entry point reading "Delete
 * account" pointed at both — a user who wanted to leave would meet "Delete all
 * my data" first, arm it, and be told their access code keeps working.
 *
 * NOT `role="menu"`. It was, and that was a promise this is not built to keep:
 * the WAI-ARIA menu pattern owes arrow-key navigation, a roving tabindex and
 * focus moved into the menu on open, and a screen-reader user who is told
 * "menu" and presses Down gets nothing. It is a short list of links plus one
 * button, so it says so. What IS implemented is the part that bites either
 * way: Escape returns focus to the trigger, instead of unmounting the focused
 * node and dropping a keyboard user at the top of the document.
 */
function AccountMenu({
  me,
  open,
  onToggle,
  onClose,
  onFeedback,
}: {
  me: Me | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onFeedback: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { theme, toggle: toggleTheme } = useTheme();
  const isHebrew = (i18n.resolvedLanguage ?? "en").startsWith("he");
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useDismiss(ref, open, onClose);

  // `me` is best-effort (the guard in AppLayout fails open), so the avatar has to
  // read as an account button with no name at all — hence the User glyph rather
  // than a placeholder letter, which would be a fabricated initial.
  const initial = me?.name?.trim()?.[0]?.toUpperCase();
  // This month's uses, for the line under "Signed in as" (Phase 30 / C5).
  const usesState = useUsesState();
  const uses = usesFor("", undefined, usesState);

  const item =
    "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-start text-sm font-medium transition-colors";

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={onToggle}
        aria-haspopup="true"
        aria-expanded={open}
        // Only while it exists. `aria-controls` naming an id that is not in the
        // document is a dangling reference, and the card is unmounted whenever
        // this reads false.
        aria-controls={open ? "app-account-panel" : undefined}
        aria-label={t("nav.account")}
        // `tap-44`: the 32 px avatar keeps its face, and its layer reaches 6 px
        // past it, inside the header and the 8 px gap to the uses chip.
        className="tap-44 grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line bg-panel-2/60 text-xs font-bold text-ink-muted transition-colors hover:bg-panel-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        {initial ?? <User size={15} />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            id="app-account-panel"
            // Ahead of `useDismiss`'s window listener, which also closes on
            // Escape: React 18 delegates to the root container, so this runs
            // first and the trigger is focused BEFORE the card unmounts. The
            // second close() is a no-op. Without it the focused link simply
            // disappears and focus falls to <body>.
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              triggerRef.current?.focus();
              onClose();
            }}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="absolute end-0 top-[calc(100%+0.5rem)] w-60 rounded-2xl border border-line bg-bg-soft p-1.5 shadow-panel"
          >
            {/* Only when the fetch resolved. A "Signed in as —" line would be a
                worse answer than no line at all. */}
            {me?.name && (
              <p className="truncate px-3 pb-2 pt-1.5 text-xs text-ink-muted">
                {t("nav.signedInAs", { name: me.name })}
              </p>
            )}
            {/* Only a count this page knows: nothing for the admin, a plan with
                no monthly limit, or an /auth/me that could not be read. It stays
                in AppLayout.tsx, for check 9's reason. */}
            {uses.limited && (
              // Wraps, never truncates: cut at 240px, the Hebrew sentence lost
              // its count behind an ellipsis (PLAN 31.2 shell pass).
              <p className={cn("px-3 pb-2 text-xs leading-snug text-ink-muted", !me?.name && "pt-1.5")}>
                {t("uses.account", { count: uses.limit ?? 0, remaining: uses.remaining ?? 0 })}
              </p>
            )}
            <Link
              to="/settings"
              onClick={onClose}
              className={cn(item, "text-ink-muted hover:bg-panel-2/60 hover:text-ink")}
            >
              <Settings size={15} className="shrink-0" />
              {t("nav.settings")}
            </Link>
            {/* Below lg the header keeps only the logo, the uses left and this
                avatar (PLAN 31.2/8 and /12): the feedback pill, the language
                switch and the theme toggle it dropped are these three rows. At
                lg all three stay where they were, so the rows hide. The
                language names itself, as the header switch does. */}
            <div className="lg:hidden">
              <button
                type="button"
                onClick={onFeedback}
                className={cn(item, "text-ink-muted hover:bg-panel-2/60 hover:text-ink")}
              >
                <MessageSquarePlus size={15} className="shrink-0" />
                {t("feedback.title")}
              </button>
              <button
                type="button"
                onClick={() => void setLanguage(isHebrew ? "en" : "he")}
                lang={isHebrew ? "en" : "he"}
                className={cn(item, "text-ink-muted hover:bg-panel-2/60 hover:text-ink")}
              >
                <Languages size={15} className="shrink-0" />
                {isHebrew ? "English" : "עברית"}
              </button>
              <button
                type="button"
                onClick={toggleTheme}
                className={cn(item, "text-ink-muted hover:bg-panel-2/60 hover:text-ink")}
              >
                {theme === "dark" ? (
                  <Sun size={15} className="shrink-0" />
                ) : (
                  <Moon size={15} className="shrink-0" />
                )}
                {t(theme === "dark" ? "theme.toLight" : "theme.toDark")}
              </button>
            </div>
            {/* "Close my account" lived here, in red, one tap from Settings
                (PLAN 31.1/12). It is only in Settings' danger zone now, which
                states each way out's cost before it is pressed
                (document-editor.md, "Two ways out"). SettingsPage still scrolls
                to #danger for any link that carries the anchor. */}
            <div className="my-1 border-t border-line" />
            <button
              type="button"
              onClick={() => void signOut("/")}
              className={cn(item, "text-ink-muted hover:bg-panel-2/60 hover:text-ink")}
            >
              {/* The door glyph points out to the right; in RTL "out" is the
                  other way, so it mirrors with the reading direction. */}
              <LogOut size={15} className="shrink-0 rtl:-scale-x-100" />
              {t("nav.signOut")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Bottom tab bar — the primary navigation on phones. Always visible and
 * thumb-reachable. The three core destinations get a tab each; "More" opens
 * the More SHEET, `MenuPanel` drawn from the bottom without the three tabs it
 * would repeat (PLAN 31.2/8) — three plus More is the four-item bar, and there
 * is still exactly one menu definition.
 *
 * INVARIANT: `moreActive` (see the call site) must never be true while any
 * primaryNav NavLink is active. This function has no <LayoutGroup> of its own,
 * so both layoutId="tabbar-dash" spans below — the NavLink dash and the More
 * dash — register in the ROOT projection stack under the bare id, and two live
 * members crossfade into a doubled, ghosted dash instead of sliding. Nothing
 * checks this. Hidden on lg+, where the header's Menu button is already a
 * pointer-reachable target and the bar would only take a row of the page. */
function MobileTabBar({
  searching,
  awaiting,
  moreOpen,
  moreActive,
  onMore,
}: {
  searching: boolean;
  awaiting: number;
  moreOpen: boolean;
  moreActive: boolean;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const tabCls = (active: boolean) =>
    cn(
      "relative flex min-w-0 flex-1 flex-col items-center gap-1 pb-1.5 pt-2 text-xs font-semibold transition-colors",
      active ? "text-accent-soft" : "text-ink-muted",
    );
  // An entry is lit on its own route and on the pages it names in `also`.
  const lit = (item: NavEntry, isActive: boolean) => isActive || !!item.also?.some((p) => pathname.startsWith(p));
  return (
    <nav
      aria-label={t("nav.primary")}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line/70 bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
    >
      <div className="mx-auto flex max-w-md items-stretch">
        {primaryNav.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => tabCls(lit(item, isActive))}>
            {({ isActive: own }) => {
              const isActive = lit(item, own);
              return (
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
                  {item.live && searching && (
                    <span
                      role="status"
                      aria-label={t("nav.searching")}
                      className="absolute -end-1 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-accent"
                    />
                  )}
                  {/* Capped at 9+ deliberately: the slot is 94.8px at 390px and
                      a three-digit pill would push the label into an ellipsis,
                      which is the one thing 22.9 measured this bar to avoid. */}
                  {item.drafts && awaiting > 0 && (
                    <span
                      aria-label={t("nav.kitsAwaiting", { count: awaiting })}
                      className="absolute -end-2 -top-1.5 grid min-w-[16px] place-items-center rounded-full bg-accent px-1 text-[10px] font-bold leading-[15px] tabular-nums text-white"
                    >
                      {awaiting > 9 ? "9+" : awaiting}
                    </span>
                  )}
                </span>
                <span className="max-w-full truncate">{t(item.labelKey)}</span>
              </>
              );
            }}
          </NavLink>
        ))}
        {/* This button DOES carry its state, and the reasoning it used to carry
            instead is the thing worth recording. It said "no aria-expanded:
            this button cannot be reached while the panel is open", from an
            elementFromPoint probe showing the panel's backdrop over this exact
            slot at 390px. True — and irrelevant to assistive tech, which
            reaches a control through the accessibility tree and ignores
            z-order and pointer occlusion entirely, so it says whether the
            sheet it controls is open. The sheet is dismissed by its own
            backdrop and Escape, never by useDismiss, so this needs no
            `data-dismiss-keep` any more. */}
        <button
          type="button"
          onClick={onMore}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-controls={moreOpen ? "app-more-sheet" : undefined}
          className={tabCls(moreActive)}
        >
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
  const { pathname, hash } = useLocation();
  // The document route is the one page whose sticky toolbar spans the window;
  // see `main` below.
  const docRoute = pathname.replace(/\/+$/, "") === "/app";
  const { searching } = useSyncExternalStore(subscribeJobSearch, getJobSearchState);
  // Kits load HERE, not on the page that lists them (JobsPage's Kits tab until
  // PLAN 31.4/5, the tracker's To review since). A page that loads them only
  // once it is open makes a count on the nav unbuildable: it read zero until
  // you had already gone and looked, which is the one moment a badge is
  // useless. The layout is the only component mounted on every app route, and
  // loadKits() no-ops once the store is populated — so this is ONE GET /kits per
  // app session, not one per visit, and the store already refreshes itself
  // (startKitBatch and resumeKitQueue both call loadKits(true) when a batch
  // finishes), so the badge updates the moment a background batch lands.
  const { kits } = useSyncExternalStore(subscribeKits, getKitsState);

  // THE AUTH GUARD. One /auth/me on mount, and the shell does not render until
  // it answers. A signed-out visitor goes to /login and an unverified account
  // to /verify, each carrying where it was, so the extension's
  // `/app?tailor_app=<id>` survives the round trip. Both are DOCUMENT loads, for
  // AccessGate's reason. Until the answer arrives this paints the same
  // full-screen spinner App.tsx's Suspense does, so the hand-off from the lazy
  // chunk to the guard is one spinner, not a spinner, a shell and a redirect.
  //
  // It FAILS OPEN. If /auth/me cannot be read (no network, a server error), the
  // shell renders anyway. That is safe because the guard is a courtesy, not the
  // lock: the server enforces every route the shell calls, and a 401 or 403
  // from any of them redirects through AccessGate. Failing closed would leave a
  // spinner for ever on the one day this check itself is what broke.
  //
  // With the gate off locally, /auth/me answers with the dev admin, which is
  // authenticated and verified, so nothing redirects.
  const [authed, setAuthed] = useState(false);
  // Who is signed in, from that same answer: the avatar initial and the
  // "Signed in as" line. Null when the guard failed open, and then the avatar
  // is a generic User glyph and every other control in the header still works.
  const [me, setMe] = useState<Me | null>(null);
  // The same answer's account id, for the uses refresh below. Null when the
  // guard failed open: then no account is known and nothing is refreshed.
  const [meId, setMeId] = useState<number | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    let live = true;
    // A destination too long for `next` waited in this tab through the sign-in
    // (lib/safeNext's fitNext): an alert email's job link with a long posting
    // URL. It is put back here, before the page under the shell mounts, so the
    // page reads the whole address; a `?jf_next=` this tab holds nothing for
    // is only dropped from the address bar.
    const shellFor = () => {
      const back = takeLongNext(window.location.pathname, window.location.search, window.location.hash);
      if (back !== null) navigate(back, { replace: true });
      setAuthed(true);
    };
    // No first-run questions open from here any more (PLAN 31.5/2): the first
    // run is the upload, and /app asks "What first?" once the resume is read.
    getAuthMe()
      .then((a) => {
        if (!live) return;
        if (!a.authenticated) {
          window.location.assign(authRedirectUrl("/login"));
          return;
        }
        if (!a.verified) {
          window.location.assign(authRedirectUrl("/verify"));
          return;
        }
        if (a.user) {
          setMe({ name: a.user.name, email: a.user.email, is_admin: a.user.is_admin });
          setMeId(a.user.id);
          // Tell this browser's other tabs who holds the cookie now (lib/accountWatch).
          announceAccount(a.user.id);
        }
        shellFor();
      })
      .catch(() => {
        if (!live) return;
        shellFor();
      });
    return () => {
      live = false;
    };
  }, []);

  // ANOTHER ACCOUNT IN ANOTHER TAB. Every tab shares the session cookie, so once
  // B signs in elsewhere this tab's next request runs as B while its stores
  // still show A's resume, search and kits. A tab that hears another account
  // announced, or a sign-out, reloads: the guard then runs as whoever holds the
  // cookie. A document load, for AccessGate's reason, never a route change.
  useEffect(() => {
    if (meId === null) return;
    return watchAccount(meId, () => window.location.reload());
  }, [meId]);

  // Uses spent where this tab cannot see them: the Chrome extension's
  // autofill, another tab, another device. Their X-Uses headers land on other
  // pages, so this tab's notes kept the old count, and kept saying "costs 1
  // use" about a screening pass the extension had already opened, until a
  // reload (P30-EXT-LIMIT). Showing the tab again re-reads /auth/me, at most
  // once a minute, for the account the guard saw and no other.
  //
  // refreshUses, never getAuthMe: getAuthMe also re-stamps the resume draft's
  // owner, and a mid-session answer (an expired session, another account
  // signed in from another tab) must never claim this tab's draft. A store
  // write only: nothing here redirects. A session that ended reaches
  // AccessGate through the next protected call's 401.
  useEffect(() => {
    if (meId === null) return;
    // The guard's own /auth/me, just answered, is the last ask.
    let lastAsked = Date.now();
    const onVisibility = () => {
      const now = Date.now();
      if (!shouldRefreshUses(now, lastAsked, document.visibilityState === "visible")) return;
      lastAsked = now;
      void refreshUses(meId);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [meId]);

  useEffect(() => {
    // Only once the guard has passed: a signed-out visit must not fire a
    // request whose 401 races the guard's own redirect.
    if (authed) void loadKits(); // best-effort: a failure just leaves the badge off
  }, [authed]);
  // "done" is tailored-and-waiting-for-a-human, and it is the exact status
  // approveKit requires — a queued or failed kit is not something to review.
  const awaitingKits = awaitingReview(kits);

  // Three popovers, one at a time — opening any closes the others: the Menu
  // dropdown (lg and up), the account card, and the More sheet (below lg).
  const [menuOpen, setMenuOpen] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // The feedback dialog, opened by the desktop pill or by the account menu's
  // row below lg (PLAN 31.2/12).
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const closeAll = useCallback(() => {
    setMenuOpen(false);
    setAcctOpen(false);
    setMoreOpen(false);
  }, []);
  const toggleMenu = useCallback(() => {
    setAcctOpen(false);
    setMoreOpen(false);
    setMenuOpen((v) => !v);
  }, []);
  const toggleAcct = useCallback(() => {
    setMenuOpen(false);
    setMoreOpen(false);
    setAcctOpen((v) => !v);
  }, []);
  const toggleMore = useCallback(() => {
    setMenuOpen(false);
    setAcctOpen(false);
    setMoreOpen((v) => !v);
  }, []);
  const openFeedback = useCallback(() => {
    closeAll();
    setFeedbackOpen(true);
  }, [closeAll]);

  // Close on route change. This is the BELT to the item handlers' braces: a
  // NavLink already calls onNavigate, but "Delete account" moves the hash only
  // and the browser Back button moves neither. Depending on `hash` as well as
  // `pathname` is what covers /settings → /settings#danger.
  useEffect(() => {
    closeAll();
  }, [pathname, hash, closeAll]);

  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, menuOpen, closeAll);
  // The More sheet closes on Escape. useDialogFocus keeps Tab inside it but
  // leaves Escape to the overlay, and the backdrop covers only the pointer.
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  // Must stay disjoint from every primaryNav `to` — see the MobileTabBar
  // invariant. /settings is folded in here for exactly the reason /interview
  // and /tools are: it is reachable only through the More panel (via the
  // account card), so leaving it out would light NO tab, and adding it as a
  // fourth tab would break the four-slot bar.
  const moreActive =
    pathname.startsWith("/interview") ||
    pathname.startsWith("/tools") ||
    pathname.startsWith("/settings");

  // After every hook, so the hook order is the same on the render that shows
  // the spinner and the render that shows the shell.
  if (!authed) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg">
        <Loader2 className="h-6 w-6 animate-spin text-ink-muted" aria-hidden />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-bg text-ink">
      {/* EXACTLY h-14 / 3.5rem. DocumentToolbar is `sticky top-14` and stacks
          directly under this bar; changing this number silently leaves a strip
          of scrolling content visible between the two.

          The blur is on a CHILD, not on the header itself, and that is
          load-bearing: `backdrop-filter` creates a containing block for
          fixed-position descendants, so with `backdrop-blur-xl` on the <header>
          the menu panel's `position: fixed` would resolve against the 56px-tall
          header box instead of the viewport — the sheet would be clipped to a
          strip and its backdrop would cover nothing.

          z-45, and both neighbours are the reason. ABOVE 40 because the Menu
          dropdown hangs from this element's stacking context and has to cover
          the z-40 feedback pill at lg (below lg there is no Menu and no pill;
          the More sheet sits on the modal layer instead). BELOW 50
          because 50 is this app's modal layer (Modal, BlockEditSheet), and at
          z-50 the header painted OVER BlockEditSheet's scrim: opening an
          experience entry at 390px dimmed the whole page except a bright,
          fully tappable 56px strip on top of an aria-modal dialog, and tapping
          Menu there opened the nav behind the sheet. Toasts and the AccessGate
          sit at 60 and stay above everything. */}
      <header className="sticky top-0 z-[45] h-14 border-b border-line/70">
        <div aria-hidden className="absolute inset-0 -z-10 bg-bg/85 backdrop-blur-xl" />
        {/* Full width, not the content column: the logo and Menu sit at the
            window's start edge and the account cluster at its end, like any
            site's top bar. The px is the SAME 4/8 the document toolbar uses on
            /app, so the two bars' contents line up on both edges. */}
        <div className="flex h-full items-center gap-2 px-4 lg:px-8">
          {/* A 44 px box (the third tap-target pass; the mark alone was 27 px
              tall): free here, centred in the 56 px header. */}
          <Link to="/app" aria-label={t("appName")} onClick={closeAll} className="flex min-h-11 shrink-0 items-center">
            <Logo size={26} />
          </Link>

          {/* lg and up only (PLAN 31.2/8). Below lg the tab bar is the nav,
              and its More opens the sheet from the bottom. */}
          <div ref={menuRef} className="relative hidden shrink-0 lg:block">
            <button
              type="button"
              onClick={toggleMenu}
              aria-haspopup="true"
              aria-expanded={menuOpen}
              // Only while the panel exists — see the account trigger's note.
              aria-controls={menuOpen ? "app-menu-panel" : undefined}
              className={cn(
                "flex min-h-11 items-center gap-1 rounded-lg border border-transparent px-2.5 py-1.5 text-sm font-semibold transition-colors",
                menuOpen ? "bg-panel-2 text-ink" : "text-ink-muted hover:bg-panel-2/60 hover:text-ink",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
              )}
            >
              {t("nav.menu")}
              <ChevronDown
                size={15}
                aria-hidden
                className={cn("transition-transform duration-200", menuOpen && "rotate-180")}
              />
            </button>

            {/* No backdrop: the card is small and anchored, so a dimmed page
                would be theatre; the pointerdown-outside dismiss covers it. */}
            <AnimatePresence>
              {menuOpen && (
                <MenuPanel searching={searching} awaiting={awaitingKits} onNavigate={closeAll} />
              )}
            </AnimatePresence>
          </div>

          {/* lg+ ONLY. It began as a width budget: with Menu, the language
              switch and the theme toggle in this row, a spinner overflowed a
              360px phone, and below lg `body { overflow-x: clip }` CLIPS the
              account avatar rather than scrolling to it. The phone header is
              now the logo, the uses left and the avatar (PLAN 31.2/8), and the
              spinner stays out of it anyway: below lg the tab bar pulses a dot
              on the Jobs tab, and the tab bar is exactly what is hidden at lg. */}
          {searching && (
            <Loader2
              size={15}
              role="status"
              aria-label={t("nav.searching")}
              className="hidden shrink-0 animate-spin text-accent-soft lg:block"
            />
          )}

          {/* From lg the switches and the avatar each wear `tap-44` at 32 px, so
              they sit 12 px apart: two 6 px layers. */}
          <div className="ms-auto flex shrink-0 items-center gap-2 lg:gap-3">
            <UsesLeft />
            {/* Below lg these two are rows in the account menu. */}
            <div className="hidden items-center gap-3 lg:flex">
              <LanguageSwitch className="tap-44" />
              <ThemeToggle className="tap-44" />
            </div>
            <AccountMenu
              me={me}
              open={acctOpen}
              onToggle={toggleAcct}
              onClose={closeAll}
              onFeedback={openFeedback}
            />
          </div>
        </div>
      </header>

      {/* Content — remounts with a fast fade+rise per route. Enter-only by
          design (no exit choreography): product register, 160 ms, never makes
          the user wait.

          A centered column on every page but one. On /app `main` is the full
          window width and TailorPage centres its own content with `.app-col`
          (styles.css), because DocumentToolbar has to span the window like the
          header above it while the paper stays in the column. A toolbar inside
          a centered `main` can only reach the window edge through a 100vw
          bleed, and 100vw counts the Windows scrollbar.

          Below `lg` the bottom padding must clear the TAB BAR (3.5rem) plus
          the safe-area inset, with a rem to spare. It used to clear the
          feedback pill, 4.25rem + its own ~2.4rem up, but the pill is
          desktop-only since PLAN 31.2/12. The inset is not optional: `pb-24`
          (6rem, no inset) left the last line under the pill by 10 px at
          390 px, and on an iPhone the 34 px home indicator took more that no
          scroll could bring out. check-mirrors 41 reads both files. */}
      <main
        className={cn(
          "pb-[calc(4.5rem+env(safe-area-inset-bottom))] pt-8 lg:pb-10",
          !docRoute && "mx-auto max-w-6xl px-4 lg:px-8",
        )}
      >
        {/* After the guard, never in the spinner branch above: it takes
            `google=superseded` out of the address as it mounts, and there it
            would be unmounted before anyone read it (check-mirrors 32(l)). */}
        <div className={docRoute ? "app-col" : undefined}>
          <GoogleNotice email={me?.email ?? ""} />
        </div>
        <motion.div
          key={pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
        >
          <Outlet />
        </motion.div>
      </main>

      <MobileTabBar
        searching={searching}
        awaiting={awaitingKits}
        moreOpen={moreOpen}
        moreActive={moreActive}
        onMore={toggleMore}
      />

      <AnimatePresence>
        {moreOpen && (
          <>
            {/* `touch-none` is what holds the page still: `overscroll-contain`
                on the sheet stops a scroll chaining OUT of it, and a drag that
                starts on this backdrop is not in it, so the document used to
                scroll behind a stationary panel. `touch-action: none` refuses
                that drag at source, with no body style to set, restore, and
                fight BlockEditSheet's own lock over. */}
            <motion.div
              aria-hidden
              onClick={() => setMoreOpen(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed inset-0 z-50 touch-none bg-black/40 lg:hidden"
            />
            <MenuPanel sheet searching={searching} awaiting={awaitingKits} onNavigate={closeAll} />
          </>
        )}
      </AnimatePresence>

      <FeedbackButton open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </div>
  );
}
