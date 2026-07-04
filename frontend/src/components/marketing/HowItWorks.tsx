import { Upload, ScanSearch, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import Reveal from "./Reveal";

const steps = [
  { icon: Upload, key: "upload" },
  { icon: ScanSearch, key: "analyze" },
  { icon: ShieldCheck, key: "verify" },
] as const;

export default function HowItWorks() {
  const { t } = useTranslation("marketing");
  return (
    <section id="how" className="relative mx-auto max-w-6xl px-4 py-20">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-accent-soft">{t("how.kicker")}</p>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          {t("how.title")}
        </h2>
        <p className="mt-3 text-ink-muted">
          {t("how.sub")}
        </p>
      </Reveal>

      <div className="mt-14 grid gap-6 md:grid-cols-3">
        {steps.map((s, i) => (
          <Reveal key={s.key} delay={i * 0.1}>
            <div className="relative h-full rounded-xl2 border border-line bg-gradient-to-b from-panel to-panel/70 p-6 shadow-card">
              <div className="mb-4 flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl border border-accent/30 bg-accent/10 text-accent-soft">
                  <s.icon size={18} />
                </span>
                <span className="text-sm font-semibold text-ink-faint">{t("how.step", { n: i + 1 })}</span>
              </div>
              <h3 className="text-lg font-semibold text-ink">{t(`how.${s.key}.title`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t(`how.${s.key}.body`)}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
