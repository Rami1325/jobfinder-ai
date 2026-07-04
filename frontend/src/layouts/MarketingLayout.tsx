import { Link, Outlet } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui";
import LanguageSwitch from "../components/LanguageSwitch";
import ThemeToggle from "../components/ThemeToggle";

export default function MarketingLayout() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="sticky top-0 z-30 border-b border-line/40 bg-bg/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent-gradient text-white shadow-glow">
              <Sparkles size={15} />
            </span>
            <span className="text-[15px]">{t("appName")}</span>
          </Link>
          <div className="flex items-center gap-4">
            <a href="#how" className="hidden text-sm text-ink-muted hover:text-ink sm:inline">{t("header.how")}</a>
            <a href="#features" className="hidden text-sm text-ink-muted hover:text-ink sm:inline">{t("header.features")}</a>
            <a href="#faq" className="hidden text-sm text-ink-muted hover:text-ink sm:inline">{t("header.faq")}</a>
            <LanguageSwitch />
            <ThemeToggle />
            <Link to="/jobs">
              <Button size="sm">{t("header.openApp")}</Button>
            </Link>
          </div>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
