import { Link, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui";
import Logo from "../components/Logo";
import LanguageSwitch from "../components/LanguageSwitch";
import ThemeToggle from "../components/ThemeToggle";
import PillarBackground from "../components/PillarBackground";

export default function MarketingLayout() {
  const { t } = useTranslation();
  return (
    <div className="relative min-h-screen text-ink">
      <PillarBackground />
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
