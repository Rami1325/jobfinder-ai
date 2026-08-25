import { Link } from "react-router-dom";
import { ArrowRight, ScanSearch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui";
import Reveal from "./Reveal";

/** Landing wedge for the free no-signup CV-vs-JD scan. */
export default function FreeScanStrip() {
  const { t } = useTranslation("marketing");
  return (
    <section className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
      <Reveal>
        <div className="relative overflow-hidden rounded-xl3 border border-line bg-paper-mint/[0.16] p-6 sm:p-9">
          <div className="relative flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-2xl">
              <p className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-mint/35 bg-panel px-2.5 py-1 text-xs font-semibold text-mint">
                <ScanSearch size={13} /> {t("freeScan.kicker")}
              </p>
              <h2 className="text-2xl font-bold tracking-[-0.025em] text-ink sm:text-[1.85rem]">
                {t("freeScan.title")}
              </h2>
              <p className="mt-2.5 text-sm leading-relaxed text-ink-muted sm:text-base">
                {t("freeScan.body")}
              </p>
              <p className="mt-2.5 text-[13px] text-ink-faint">{t("freeScan.note")}</p>
            </div>
            <Link to="/scan" className="w-full shrink-0 sm:w-auto">
              <Button
                size="lg"
                className="w-full sm:w-auto"
                icon={<ArrowRight size={18} className="rtl:-scale-x-100" />}
              >
                {t("freeScan.cta")}
              </Button>
            </Link>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
