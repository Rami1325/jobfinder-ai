import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import Logo from "../Logo";

export default function Footer() {
  const { t } = useTranslation();
  const { t: tm } = useTranslation("marketing");
  return (
    <footer className="border-t border-line bg-bg-soft/60">
      <div className="mx-auto max-w-6xl px-4 py-12">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <Logo size={28} />
            <p className="mt-3 text-sm leading-relaxed text-ink-muted">{tm("footer.blurb")}</p>
          </div>
          <nav
            aria-label={tm("footer.navLabel")}
            className="flex flex-wrap gap-x-6 gap-y-2.5 text-sm text-ink-muted"
          >
            <Link to="/home" className="hover:text-ink">{t("footer.app")}</Link>
            <Link to="/scan" className="hover:text-ink">{t("footer.freeScan")}</Link>
            <a href="#templates" className="hover:text-ink">{tm("templates.nav")}</a>
            <a href="#how" className="hover:text-ink">{t("footer.how")}</a>
            <a href="#faq" className="hover:text-ink">{t("footer.faq")}</a>
          </nav>
        </div>
        <p className="mt-10 border-t border-line pt-6 text-[13px] leading-relaxed text-ink-faint">
          {tm("footer.honesty")}
        </p>
      </div>
    </footer>
  );
}
