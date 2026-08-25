import { ScanSearch, ShieldCheck, Upload } from "lucide-react";
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
    <section id="how" className="relative mx-auto max-w-6xl px-4 py-16 sm:py-20">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{t("how.kicker")}</p>
        <h2 className="mt-3 text-3xl font-bold tracking-[-0.025em] text-ink sm:text-[2.6rem] sm:leading-[1.1]">
          {t("how.title")}
        </h2>
        <p className="mt-4 text-base leading-relaxed text-ink-muted sm:text-lg">{t("how.sub")}</p>
      </Reveal>

      <ol className="mt-12 grid gap-5 md:grid-cols-3 md:gap-6">
        {steps.map((s, i) => (
          <li key={s.key}>
            <Reveal delay={i * 0.1} className="h-full">
              <div className="relative h-full rounded-xl3 border border-line bg-panel p-6 shadow-card sm:p-7">
                {/* The step number as a watermark, not a badge. */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute end-5 top-3 select-none text-[3.5rem] font-bold leading-none tracking-tight text-ink/[0.05]"
                >
                  {i + 1}
                </span>
                <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent/10 text-accent">
                  <s.icon size={19} />
                </span>
                <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
                  {t("how.step", { n: i + 1 })}
                </p>
                <h3 className="mt-2 text-lg font-semibold text-ink">{t(`how.${s.key}.title`)}</h3>
                <p className="mt-2.5 text-sm leading-relaxed text-ink-muted">
                  {t(`how.${s.key}.body`)}
                </p>
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
    </section>
  );
}
