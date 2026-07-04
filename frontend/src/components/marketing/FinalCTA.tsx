import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui";
import Reveal from "./Reveal";

export default function FinalCTA() {
  const { t } = useTranslation("marketing");
  return (
    <section className="mx-auto max-w-6xl px-4 py-20">
      <Reveal>
        <div className="relative overflow-hidden rounded-[1.75rem] border border-line bg-gradient-to-b from-panel-2 to-panel px-6 py-16 text-center shadow-panel">
          <div className="pointer-events-none absolute -top-24 left-1/2 h-64 w-[36rem] -translate-x-1/2 rounded-full bg-accent/25 blur-[110px]" />
          <h2 className="relative text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            {t("finalCta.title")}
          </h2>
          <p className="relative mx-auto mt-4 max-w-xl text-ink-muted">
            {t("finalCta.sub")}
          </p>
          <div className="relative mt-8 flex justify-center">
            <Link to="/jobs">
              <Button size="lg" icon={<ArrowRight size={18} className="rtl:-scale-x-100" />}>
                {t("finalCta.cta")}
              </Button>
            </Link>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
