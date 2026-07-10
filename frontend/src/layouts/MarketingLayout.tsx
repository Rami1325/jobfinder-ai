import { Link, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui";
import Logo from "../components/Logo";
import LanguageSwitch from "../components/LanguageSwitch";
import ThemeToggle from "../components/ThemeToggle";
import PillarBackground from "../components/PillarBackground";

/**
 * E4 — fine film grain (inline SVG feTurbulence tile, desaturated so it is
 * theme-neutral) laid over the marketing pages at ~2% opacity, so the glass
 * panels don't feel airbrushed. Static — no animation — and pointer-events-none.
 */
const GRAIN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E";

export default function MarketingLayout() {
  const { t } = useTranslation();
  return (
    <div className="relative min-h-screen text-ink">
      <PillarBackground />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-40 opacity-[0.02]"
        style={{ backgroundImage: `url("${GRAIN}")`, backgroundRepeat: "repeat", backgroundSize: "180px 180px" }}
      />
      <header className="sticky top-0 z-30 border-b border-line/40 bg-bg/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5">
          <Link to="/" aria-label={t("appName")}>
            <Logo size={28} />
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/scan" className="hidden text-sm text-ink-muted hover:text-ink sm:inline">{t("header.freeScan")}</Link>
            <a href="#how" className="hidden text-sm text-ink-muted hover:text-ink sm:inline">{t("header.how")}</a>
            <a href="#features" className="hidden text-sm text-ink-muted hover:text-ink sm:inline">{t("header.features")}</a>
            <a href="#faq" className="hidden text-sm text-ink-muted hover:text-ink sm:inline">{t("header.faq")}</a>
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
  );
}
