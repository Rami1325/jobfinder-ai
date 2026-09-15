import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
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
  Mail,
  MoreHorizontal,
  Settings,
  LogOut,
  Trash2,
  User,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { SectionLabel } from "../components/ui";
import Logo from "../components/Logo";
import FeedbackButton from "../components/FeedbackButton";
import GoogleNotice from "../components/GoogleNotice";
import LanguageSwitch from "../components/LanguageSwitch";
import OnboardingModal from "../components/OnboardingModal";
import ThemeToggle from "../components/ThemeToggle";
import { getAuthMe } from "../api/client";
import { isOnboarded } from "../lib/onboarding";
import { authRedirectUrl } from "../lib/safeNext";
import { signOut } from "../lib/session";
import { usesFor, useUsesState } from "../lib/usesStore";
import { getJobSearchState, subscribeJobSearch } from "../state/jobSearchStore";
import { getKitsState, loadKits, subscribeKits } from "../state/kitsStore";
import type { Me } from "../types";

type NavEntry = {
  to: string;
  labelKey: string;
  icon: LucideIcon;
  /** This entry carries live indicators (the search spinner, the kits count).
   *
   * A FLAG, not a route-string comparison. Comparing `item.to` against a
   * hard-coded path is documented in CLAUDE.md as fragile — renaming the route
   * silently kills the indicator — and hoisting the path into a shared constant
   * is NOT the fix: check-mirrors check 9 scrapes route LITERALS out of this
   * table and guards only on the count being non-zero, so a constant would make
   * the Jobs destination quietly stop being validated. The literal stays in the
   * table; nothing has to repeat it. */
  live?: true;
};

const primaryNav: NavEntry[] = [
  { to: "/app", labelKey: "nav.resume", icon: FileText },
  { to: "/jobs", labelKey: "nav.jobs", icon: Briefcase, live: true },
  { to: "/tracker", labelKey: "nav.tracker", icon: KanbanSquare },
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
      )}
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
}: {
  searching: boolean;
  awaiting: number;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const { t: tTools } = useTranslation("tools");

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
  // said so. The count is kits with status "done" — tailored and waiting for a
  // human — which is exactly what approveKit requires.
  //
  // The spinner wins when both apply. A search in flight is about what you just
  // did and resolves in seconds; the kit count is patient and will still be
  // there afterwards.
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

  return (
    <LayoutGroup id="nav">
      <motion.nav
        id="app-menu-panel"
        aria-label={t("nav.menu")}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          // Below lg: a full-width sheet hung under the header, with its OWN
          // scroller. `overscroll-contain` so reaching the end of the list does
          // not hand the scroll to the page underneath — the sheet is fixed, so
          // chaining would slide the document out from behind it while the menu
          // sits still, which reads as a broken screen.
          "fixed start-0 end-0 top-14 max-h-[calc(100dvh-3.5rem)] overflow-y-auto overscroll-contain",
          "border-b border-line bg-bg-soft px-3 pt-4 shadow-panel",
          "pb-[calc(1rem+env(safe-area-inset-bottom))]",
          // lg+: the same component as an anchored dropdown card. `inset-auto`
          // first so the sheet's start/end pinning is released before start-0
          // re-anchors it under the Menu button.
          "lg:absolute lg:inset-auto lg:start-0 lg:top-[calc(100%+0.5rem)]",
          "lg:max-h-[calc(100dvh-5rem)] lg:w-[21rem] lg:rounded-2xl lg:border lg:pb-4",
        )}
      >
        {/* Caps the column on tablets. No effect at 390px (max-w-md is wider
            than the viewport), so the phone still gets a full-bleed sheet. */}
        <div className="mx-auto w-full max-w-md lg:max-w-none">
          <SectionLabel className="px-3">{t("nav.primary")}</SectionLabel>
          <div className="mt-1.5 space-y-0.5">
            {primaryNav.map((item) => (
              <NavItem
                key={item.to}
                to={item.to}
                icon={item.icon}
                label={t(item.labelKey)}
                trailing={item.live ? spinner ?? kitsBadge : undefined}
                onNavigate={onNavigate}
              />
            ))}
          </div>

          <SectionLabel className="mt-5 px-3">{t("nav.more")}</SectionLabel>
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
      </motion.nav>
    </LayoutGroup>
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
}: {
  me: Me | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
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
    "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-start text-sm font-medium transition-colors";

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
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line bg-panel-2/60 text-xs font-bold text-ink-muted transition-colors hover:bg-panel-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
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
              <p className={cn("truncate px-3 pb-2 text-xs text-ink-muted", !me?.name && "pt-1.5")}>
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
            <div className="my-1 border-t border-line" />
            {/* The To is an OBJECT, not "/settings#danger". Check 9 builds an
                exact-match regex per <Route path> and a hash glued onto the
                literal would never match /settings — the object keeps the
                pathname a real path while still carrying the anchor. The
                pathname itself is still guarded, by the Settings item above.
                SettingsPage does the scrolling: react-router does not act on a
                hash, and pushState does not trigger the browser's own fragment
                navigation, so this landed at the TOP of Settings with the
                danger zone four cards below the fold. */}
            <Link
              to={{ pathname: "/settings", hash: "#danger" }}
              onClick={onClose}
              className={cn(item, "text-danger hover:bg-danger/10")}
            >
              <Trash2 size={15} className="shrink-0" />
              {t("nav.closeAccount")}
            </Link>
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
 * thumb-reachable. The three core destinations get a tab each; "More" opens the
 * SAME top menu panel the header does — three plus More is the four-item bar,
 * and there is still exactly one menu definition.
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
  menuOpen,
  moreActive,
  onMore,
}: {
  searching: boolean;
  awaiting: number;
  menuOpen: boolean;
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
                  {item.live && !searching && awaiting > 0 && (
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
            )}
          </NavLink>
        ))}
        {/* This button DOES carry its state, and the reasoning it used to carry
            instead is the thing worth recording. It said "no aria-expanded:
            this button cannot be reached while the panel is open", from an
            elementFromPoint probe showing the panel's backdrop over this exact
            slot at 390px. True — and irrelevant to assistive tech, which
            reaches a control through the accessibility tree and ignores
            z-order and pointer occlusion entirely. Nothing here is `inert`, so
            a screen-reader user could always reach this button, be promised a
            popup by aria-haspopup, and never be told whether it was open.
            `data-dismiss-keep` is the other half: it makes this a real toggle
            for an activation that dispatches pointer events at the element
            (see useDismiss), instead of one that closes and reopens the panel
            in the same gesture and appears to do nothing. */}
        <button
          type="button"
          onClick={onMore}
          data-dismiss-keep
          aria-haspopup="true"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? "app-menu-panel" : undefined}
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
  const { searching } = useSyncExternalStore(subscribeJobSearch, getJobSearchState);
  // Kits load HERE, not on JobsPage. JobsPage called loadKits() only once its
  // Kits tab was open, which made a count on that tab unbuildable: it read zero
  // until you had already gone and looked, which is the one moment a badge is
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
  useEffect(() => {
    let live = true;
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
        if (a.user) setMe({ name: a.user.name, email: a.user.email, is_admin: a.user.is_admin });
        setAuthed(true);
      })
      .catch(() => {
        if (live) setAuthed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    // Only once the guard has passed: a signed-out visit must not fire a
    // request whose 401 races the guard's own redirect.
    if (authed) void loadKits(); // best-effort: a failure just leaves the badge off
  }, [authed]);
  // "done" is tailored-and-waiting-for-a-human, and it is the exact status
  // approveKit requires — a queued or failed kit is not something to review.
  const awaitingKits = kits?.filter((k) => k.status === "done").length ?? 0;
  const [onboardOpen, setOnboardOpen] = useState(() => !isOnboarded());

  // Two popovers, one at a time — opening either closes the other, so the panel
  // and the account card can never overlap at the top-end corner on a phone.
  const [menuOpen, setMenuOpen] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);
  const closeAll = useCallback(() => {
    setMenuOpen(false);
    setAcctOpen(false);
  }, []);
  const toggleMenu = useCallback(() => {
    setAcctOpen(false);
    setMenuOpen((v) => !v);
  }, []);
  const toggleAcct = useCallback(() => {
    setMenuOpen(false);
    setAcctOpen((v) => !v);
  }, []);

  // Close on route change. This is the BELT to the item handlers' braces: a
  // NavLink already calls onNavigate, but "Delete account" moves the hash only
  // and the browser Back button moves neither. Depending on `hash` as well as
  // `pathname` is what covers /settings → /settings#danger.
  useEffect(() => {
    closeAll();
  }, [pathname, hash, closeAll]);

  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, menuOpen, closeAll);

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

          z-45, and both neighbours are the reason. ABOVE 40 because the menu
          panel and its backdrop hang from this element's stacking context and
          have to cover the z-30 tab bar and the z-40 feedback pill. BELOW 50
          because 50 is this app's modal layer (Modal, BlockEditSheet), and at
          z-50 the header painted OVER BlockEditSheet's scrim: opening an
          experience entry at 390px dimmed the whole page except a bright,
          fully tappable 56px strip on top of an aria-modal dialog, and tapping
          Menu there opened the nav behind the sheet. Toasts and the AccessGate
          sit at 60 and stay above everything. */}
      <header className="sticky top-0 z-[45] h-14 border-b border-line/70">
        <div aria-hidden className="absolute inset-0 -z-10 bg-bg/85 backdrop-blur-xl" />
        <div className="mx-auto flex h-full max-w-6xl items-center gap-2 px-4 lg:px-8">
          <Link to="/app" aria-label={t("appName")} onClick={closeAll} className="shrink-0">
            <Logo size={26} />
          </Link>

          <div ref={menuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={toggleMenu}
              aria-haspopup="true"
              aria-expanded={menuOpen}
              // Only while the panel exists — see the account trigger's note.
              aria-controls={menuOpen ? "app-menu-panel" : undefined}
              className={cn(
                "flex items-center gap-1 rounded-lg border border-transparent px-2.5 py-1.5 text-sm font-semibold transition-colors",
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

            <AnimatePresence>
              {menuOpen && (
                <>
                  {/* Phone/tablet only. At lg the card is small and anchored, so
                      a dimmed page would be theatre; the pointerdown-outside
                      dismiss covers that breakpoint instead.

                      `touch-none` is what actually holds the page still. The
                      deleted drawer locked `document.body.style.overflow`; the
                      panel's own `overscroll-contain` replaced it and does not
                      cover this case at all — it only stops chaining OUT of
                      the panel, and a drag that starts on this backdrop is not
                      in the panel. So the document scrolled behind a
                      stationary sheet. `touch-action: none` refuses the drag
                      at source, with no body style to set, restore, and fight
                      BlockEditSheet's own lock over — and no desktop
                      scrollbar-width jump, since this element is lg:hidden. */}
                  <motion.div
                    onClick={closeAll}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="fixed bottom-0 end-0 start-0 top-14 touch-none bg-black/40 lg:hidden"
                  />
                  <MenuPanel
                    searching={searching}
                    awaiting={awaitingKits}
                    onNavigate={closeAll}
                  />
                </>
              )}
            </AnimatePresence>
          </div>

          {/* lg+ ONLY, and that is a width budget, not taste. This row cannot
              wrap and every item in it is shrink-0: at 390px the logo (~118px),
              Menu (~77px) and the utilities cluster (~112px) plus gaps come to
              ~323px of the 358px inside the padding, and this spinner and its
              gap spend 23px of the 35px left — so a 360px phone overflowed, and
              below lg `body { overflow-x: clip }` means it CLIPS the account
              avatar rather than scrolling to it. Nothing is lost: below lg the
              bottom tab bar pulses a dot on the Jobs tab and the menu panel
              spins on its Jobs row, and the tab bar is exactly the thing that
              is hidden at lg. */}
          {searching && (
            <Loader2
              size={15}
              role="status"
              aria-label={t("nav.searching")}
              className="hidden shrink-0 animate-spin text-accent-soft lg:block"
            />
          )}

          <div className="ms-auto flex shrink-0 items-center gap-2">
            <LanguageSwitch />
            <ThemeToggle />
            <AccountMenu me={me} open={acctOpen} onToggle={toggleAcct} onClose={closeAll} />
          </div>
        </div>
      </header>

      {/* Content — remounts with a fast fade+rise per route. Enter-only by
          design (no exit choreography): product register, 160 ms, never makes
          the user wait.

          A plain centered column now the rail is gone. The px must stay 4/8:
          DocumentToolbar bleeds itself out with `-mx-4 lg:-mx-8` to reach the
          column's own padding, and a different number leaves it peeking. */}
      <main className="mx-auto max-w-6xl px-4 pb-24 pt-8 lg:px-8 lg:pb-10">
        {/* After the guard, never in the spinner branch above: it takes
            `google=superseded` out of the address as it mounts, and there it
            would be unmounted before anyone read it (check-mirrors 32(l)). */}
        <GoogleNotice email={me?.email ?? ""} />
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
        menuOpen={menuOpen}
        moreActive={moreActive}
        onMore={toggleMenu}
      />

      <FeedbackButton />
      <OnboardingModal open={onboardOpen} onClose={() => setOnboardOpen(false)} />
    </div>
  );
}
