import { Link, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui";
import Logo from "../components/Logo";
import LanguageSwitch from "../components/LanguageSwitch";
import ThemeToggle from "../components/ThemeToggle";
import PaperAurora from "../components/marketing/PaperAurora";

/**
 * Fine film grain (inline SVG feTurbulence tile, desaturated so it is
 * theme-neutral) laid over the marketing pages at ~2% opacity. On the paper
 * palette it does real work: it is what stops a large flat warm-white area
 * from looking like an empty div. Static, pointer-events-none.
 */
const GRAIN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E";

const NAV = [
  { href: "#templates", key: "marketing" as const, tk: "templates.nav" },
  { href: "#how", key: "common" as const, tk: "header.how" },
  { href: "#features", key: "common" as const, tk: "header.features" },
  { href: "#faq", key: "common" as const, tk: "header.faq" },
];

/**
 * The marketing shell.
 *
 * `paper` is the scoped token override (styles.css): it rebinds --bg / --ink /
 * --accent / … on THIS SUBTREE ONLY, so the landing and the free scan render
 * on warm white while /home, /app, /jobs, /tools/*, /tracker keep the app's
 * dark default. The theme toggle still writes the global class on <html> and
 * still drives every app surface — it simply has no say over the marketing
 * page, which is a committed light design.
 *
 * `isolate` creates a stacking context so the fixed aurora can sit under the
 * content without negative z-indexes leaking behind the document background.
 */
export default function MarketingLayout() {
  const { t } = useTranslation();
  const { t: tm } = useTranslation("marketing");
  const label = (n: (typeof NAV)[number]) => (n.key === "marketing" ? tm(n.tk) : t(n.tk));

  return (
    <div className="paper relative isolate min-h-screen text-ink">
      <PaperAurora />

      <div className="relative z-10">
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-40 opacity-[0.025]"
          style={{ backgroundImage: `url("${GRAIN}")`, backgroundRepeat: "repeat", backgroundSize: "180px 180px" }}
        />

        <header className="sticky top-0 z-30 border-b border-line/70 bg-bg/80 backdrop-blur-xl">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3.5">
            <Link to="/" aria-label={t("appName")} className="shrink-0">
              <Logo size={28} />
            </Link>
            <nav aria-label={tm("footer.navLabel")} className="hidden items-center gap-6 md:flex">
              {NAV.map((n) => (
                <a key={n.href} href={n.href} className="text-sm font-medium text-ink-muted hover:text-ink">
                  {label(n)}
                </a>
              ))}
            </nav>
            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              <Link
                to="/scan"
                className="hidden text-sm font-medium text-ink-muted hover:text-ink lg:inline"
              >
                {t("header.freeScan")}
              </Link>
              <LanguageSwitch />
              <ThemeToggle />
              <Link to="/home">
                <Button size="sm">{t("header.openApp")}</Button>
              </Link>
            </div>
          </div>
        </header>

        <Outlet />
      </div>
    </div>
  );
}
