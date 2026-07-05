import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function Footer() {
  const { t } = useTranslation();
  return (
    <footer className="border-t border-line/60">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-ink-muted sm:flex-row">
        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-accent-gradient text-white">
            <Sparkles size={12} />
          </span>
          <span className="font-medium text-ink">{t("appName")}</span>
          <span className="text-ink-faint">{t("footer.tagline")}</span>
        </div>
        <div className="flex items-center gap-5">
          <Link to="/jobs" className="hover:text-ink">{t("footer.app")}</Link>
          <Link to="/scan" className="hover:text-ink">{t("footer.freeScan")}</Link>
          <a href="#how" className="hover:text-ink">{t("footer.how")}</a>
          <a href="#faq" className="hover:text-ink">{t("footer.faq")}</a>
        </div>
      </div>
    </footer>
  );
}
