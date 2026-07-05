import { Link } from "react-router-dom";
import { ArrowRight, ScanSearch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui";
import Reveal from "./Reveal";

/** Landing wedge for the free no-signup CV-vs-JD scan (PLAN 6). */
export default function FreeScanStrip() {
  const { t } = useTranslation("marketing");
  return (
    <section className="mx-auto max-w-6xl px-4 py-10">
      <Reveal>
        <div className="relative overflow-hidden rounded-xl2 border border-accent/30 bg-panel/70 p-6 shadow-panel sm:p-8">
          <div className="pointer-events-none absolute -top-24 end-0 h-56 w-56 rounded-full bg-accent/15 blur-3xl" />
          <div className="relative flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-2xl">
              <p className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-mint/40 bg-mint/10 px-2.5 py-0.5 text-xs font-semibold text-mint">
                <ScanSearch size={13} /> {t("freeScan.kicker")}
              </p>
              <h2 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">
                {t("freeScan.title")}
              </h2>
              <p className="mt-2 text-sm text-ink-muted sm:text-base">{t("freeScan.body")}</p>
              <p className="mt-2 text-xs text-ink-faint">{t("freeScan.note")}</p>
            </div>
            <Link to="/scan" className="shrink-0">
              <Button size="lg" icon={<ArrowRight size={18} className="rtl:-scale-x-100" />}>
                {t("freeScan.cta")}
              </Button>
            </Link>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
