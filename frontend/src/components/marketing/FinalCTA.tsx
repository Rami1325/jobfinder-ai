import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui";
import Reveal from "./Reveal";
import ResumeMiniature from "./ResumeMiniature";

export default function FinalCTA() {
  const { t } = useTranslation("marketing");
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:py-20">
      <Reveal>
        <div className="relative overflow-hidden rounded-[2rem] border border-line bg-paper-violet/[0.14] px-6 py-14 sm:px-12 sm:py-16">
          {/* A fanned stack of pages behind the copy — the thing you leave
              with. Anchored from the TOP so the page header (the part that
              reads as a résumé at a glance) is what shows; the foot bleeds off
              the card, which clips it, so it never affects layout or
              introduces horizontal overflow. */}
          <div
            aria-hidden
            className="pointer-events-none absolute -end-8 top-10 hidden w-[19rem] rotate-[4deg] lg:block rtl:-rotate-[4deg]"
          >
            <div className="relative">
              <div className="absolute inset-0 translate-x-9 rotate-[6deg] rounded-[8px] bg-white opacity-50 shadow-doc rtl:-translate-x-9 rtl:-rotate-[6deg]" />
              <div className="absolute inset-0 translate-x-[18px] rotate-[3deg] rounded-[8px] bg-white opacity-75 shadow-doc rtl:-translate-x-[18px] rtl:-rotate-[3deg]" />
              <div className="relative overflow-hidden rounded-[8px] shadow-doc">
                <ResumeMiniature template="modern" className="block h-auto w-full rtl:-scale-x-100" />
              </div>
            </div>
          </div>

          <div className="relative max-w-xl">
            <h2 className="text-3xl font-bold tracking-[-0.03em] text-ink sm:text-[2.75rem] sm:leading-[1.08]">
              {t("finalCta.title")}
            </h2>
            <p className="mt-5 text-base leading-relaxed text-ink-muted sm:text-lg">
              {t("finalCta.sub")}
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link to="/app">
                <Button
                  size="lg"
                  className="w-full sm:w-auto"
                  icon={<ArrowRight size={18} className="rtl:-scale-x-100" />}
                >
                  {t("finalCta.cta")}
                </Button>
              </Link>
              <Link to="/scan">
                <Button
                  size="lg"
                  variant="secondary"
                  className="w-full border-ink/20 bg-panel hover:border-ink/45 hover:bg-panel sm:w-auto"
                >
                  {t("finalCta.ctaSecondary")}
                </Button>
              </Link>
            </div>
            <p className="mt-6 text-[13px] text-ink-faint">{t("finalCta.note")}</p>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
