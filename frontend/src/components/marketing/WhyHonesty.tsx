import { Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import Reveal from "./Reveal";

const SLOP_KEYS = ["slop1", "slop2", "slop3", "slop4"] as const;
const US_KEYS = ["us1", "us2", "us3", "us4"] as const;

export default function WhyHonesty() {
  const { t } = useTranslation("marketing");
  return (
    <section className="relative mx-auto max-w-6xl px-4 py-20">
      <div className="pointer-events-none absolute inset-x-8 top-1/2 -z-10 h-64 -translate-y-1/2 rounded-full bg-mint/10 blur-[100px]" />
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-accent-soft">{t("why.kicker")}</p>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          {t("why.title")}
        </h2>
        <p className="mt-3 text-ink-muted">
          {t("why.sub")}
        </p>
      </Reveal>

      <div className="mx-auto mt-14 grid max-w-4xl gap-6 md:grid-cols-2">
        <Reveal>
          <div className="h-full rounded-xl2 border border-danger/25 bg-danger/[0.06] p-6">
            <h3 className="mb-4 text-lg font-semibold text-ink">{t("why.slopTitle")}</h3>
            <ul className="space-y-3">
              {SLOP_KEYS.map((k) => (
                <li key={k} className="flex items-start gap-2.5 text-sm text-ink-muted">
                  <X size={16} className="mt-0.5 shrink-0 text-danger" /> {t(`why.${k}`)}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="h-full rounded-xl2 border border-mint/30 bg-mint/[0.06] p-6 shadow-glow-mint">
            <h3 className="mb-4 text-lg font-semibold text-ink">{t("why.usTitle")}</h3>
            <ul className="space-y-3">
              {US_KEYS.map((k) => (
                <li key={k} className="flex items-start gap-2.5 text-sm text-ink">
                  <Check size={16} className="mt-0.5 shrink-0 text-mint" /> {t(`why.${k}`)}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
