import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Menu, Moon, Sun, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import Logo from "../Logo";
import LanguageSwitch from "../LanguageSwitch";
import { cn } from "../../lib/cn";
import type { LandingMode } from "../../hooks/useLandingTheme";

/**
 * The landing's own header.
 *
 * It is not `MarketingLayout`'s: that one is shared with `/scan`, which keeps
 * its warm-paper design, and this one has to start INVISIBLE over the star
 * scene and only assert itself once the visitor has scrolled past the hero's
 * opening. Reusing it would have meant a `pathname === "/"` branch inside a
 * component two routes depend on.
 *
 * The compact menu is a disclosure, not a modal: it does not cover the page or
 * trap focus, so it needs no focus management beyond returning focus to its
 * own button on Escape — which is exactly what it does. Every link, the
 * language switch and the theme control are inside it, so nothing is reachable
 * on a wide screen only.
 */

interface NavItem {
  href: string;
  ns: "common" | "marketing";
  key: string;
}

const NAV: NavItem[] = [
  { href: "#templates", ns: "marketing", key: "templates.nav" },
  { href: "#how", ns: "common", key: "header.how" },
  { href: "#features", ns: "common", key: "header.features" },
  { href: "#faq", ns: "common", key: "header.faq" },
];

/** Scroll distance at which the bar takes on its own background. */
const SOLID_AT = 32;

function ThemeButton({ mode, toggle }: { mode: LandingMode; toggle: () => void }) {
  // `tm`, not `t`: the exported component below binds `t` to `common`, and one
  // identifier standing for two namespaces in one file is exactly the ambiguity
  // check-mirrors 28 refuses to resolve.
  const { t: tm } = useTranslation("marketing");
  const label = mode === "dark" ? tm("landing.nav.toLight") : tm("landing.nav.toDark");
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="grid h-11 w-11 place-items-center rounded-full text-ink-muted transition-colors hover:bg-ink/[0.08] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {mode === "dark" ? <Moon size={17} aria-hidden /> : <Sun size={17} aria-hidden />}
    </button>
  );
}

export default function LandingHeader({
  mode,
  toggleTheme,
}: {
  mode: LandingMode;
  toggleTheme: () => void;
}) {
  const { t } = useTranslation();
  const { t: tm } = useTranslation("marketing");
  const [solid, setSolid] = useState(false);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const label = (n: NavItem) => (n.ns === "marketing" ? tm(n.key) : t(n.key));

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > SOLID_AT);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const navLink =
    "rounded-md px-1 py-2 text-[15px] font-normal text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-200",
        solid
          ? "border-b border-line bg-bg/85 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-[1160px] items-center justify-between gap-4 px-5 sm:px-8 md:h-[72px] lg:px-14">
        <Link
          to="/"
          aria-label={t("appName")}
          /* The negative margin keeps the mark where it sits optically while
             giving the link a 44px interaction area. */
          className="-m-2.5 flex shrink-0 items-center rounded-md p-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Logo size={26} />
        </Link>

        <nav aria-label={tm("footer.navLabel")} className="hidden items-center gap-8 md:flex">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} className={navLink}>
              {label(n)}
            </a>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <Link to="/scan" className={cn(navLink, "hidden lg:inline-block")}>
            {t("header.freeScan")}
          </Link>
          <div className="hidden items-center gap-1 md:flex">
            <LanguageSwitch className="h-11 min-w-11 rounded-full border-0 text-[13px] hover:bg-ink/[0.08]" />
            <ThemeButton mode={mode} toggle={toggleTheme} />
          </div>
          <Link
            to="/app"
            className="inline-flex min-h-[44px] items-center rounded-full border border-ink/25 px-4 text-sm font-medium text-ink transition-colors hover:border-ink/50 hover:bg-ink/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t("header.openApp")}
          </Link>
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={open ? tm("landing.nav.close") : t("nav.menu")}
            className="grid h-11 w-11 place-items-center rounded-full text-ink-muted transition-colors hover:bg-ink/[0.08] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:hidden"
          >
            {open ? <X size={20} aria-hidden /> : <Menu size={20} aria-hidden />}
          </button>
        </div>
      </div>

      {/* Compact menu. Rendered conditionally and animated with opacity and
          transform only — never a height tween, for the reason check-mirrors 11
          exists. */}
      {open && (
        <div
          id={panelId}
          ref={panelRef}
          className="lp-in border-b border-line bg-bg/97 backdrop-blur-xl md:hidden"
        >
          <nav aria-label={tm("footer.navLabel")} className="mx-auto max-w-[1160px] px-5 pb-5 pt-1 sm:px-8">
            <ul className="flex flex-col">
              {NAV.map((n) => (
                <li key={n.href}>
                  <a
                    href={n.href}
                    onClick={() => setOpen(false)}
                    className="flex min-h-[48px] items-center border-b border-line/70 text-[16px] text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {label(n)}
                  </a>
                </li>
              ))}
              <li>
                <Link
                  to="/scan"
                  onClick={() => setOpen(false)}
                  className="flex min-h-[48px] items-center text-[16px] text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {t("header.freeScan")}
                </Link>
              </li>
            </ul>
            <div className="mt-3 flex items-center gap-2 border-t border-line/70 pt-3">
              <LanguageSwitch className="h-11 min-w-11 rounded-full border-0 text-[13px] hover:bg-ink/[0.08]" />
              <ThemeButton mode={mode} toggle={toggleTheme} />
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
