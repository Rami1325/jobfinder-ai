import { Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import Reveal from "./Reveal";

const SLOP_KEYS = ["slop1", "slop2", "slop3", "slop4"] as const;
const US_KEYS = ["us1", "us2", "us3", "us4"] as const;
/** The fact classes the guard actually diffs against the ledger. */
const GUARDED = ["employers", "titles", "dates", "credentials", "numbers"] as const;

/**
 * The one full-bleed dark band on the paper page.
 *
 * `.ink-slab` (styles.css) restates the DARK token values on this subtree, so
 * every `bg-panel` / `text-ink` / `border-line` utility inside keeps working
 * unchanged — the same scoped-token trick `.paper` uses, in reverse. The band
 * is deliberately the honesty argument: it is the part of the pitch that
 * should feel like a different room.
 */
export default function WhyHonesty() {
  const { t } = useTranslation("marketing");
  return (
    <section className="ink-slab relative overflow-hidden bg-bg py-20 text-ink sm:py-24">
      {/* Very soft navy → plum → rose wash, the band's only decoration. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(60% 55% at 18% 0%, rgb(var(--accent) / 0.22), transparent 70%), radial-gradient(55% 50% at 82% 100%, rgb(var(--paper-blush) / 0.14), transparent 72%)",
        }}
      />

      <div className="relative mx-auto max-w-6xl px-4">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
            {t("why.kicker")}
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-[-0.025em] text-ink sm:text-[2.6rem] sm:leading-[1.1]">
            {t("why.title")}
          </h2>
          <p className="mt-4 text-base leading-relaxed text-ink-muted sm:text-lg">{t("why.sub")}</p>
        </Reveal>

        <div className="mx-auto mt-14 grid max-w-4xl gap-5 md:grid-cols-2">
          <Reveal>
            <div className="h-full rounded-xl3 border border-danger/25 bg-danger/[0.08] p-6 sm:p-7">
              <h3 className="mb-5 text-lg font-semibold text-ink">{t("why.slopTitle")}</h3>
              <ul className="space-y-3.5">
                {SLOP_KEYS.map((k) => (
                  <li key={k} className="flex items-start gap-2.5 text-sm leading-relaxed text-ink-muted">
                    <X size={16} className="mt-0.5 shrink-0 text-danger" /> {t(`why.${k}`)}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="h-full rounded-xl3 border border-mint/30 bg-mint/[0.08] p-6 shadow-glow-mint sm:p-7">
              <h3 className="mb-5 text-lg font-semibold text-ink">{t("why.usTitle")}</h3>
              <ul className="space-y-3.5">
                {US_KEYS.map((k) => (
                  <li key={k} className="flex items-start gap-2.5 text-sm leading-relaxed text-ink">
                    <Check size={16} className="mt-0.5 shrink-0 text-mint" /> {t(`why.${k}`)}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>

        {/* What the guard actually diffs — specificity beats assertion. */}
        <Reveal delay={0.15}>
          <div className="mx-auto mt-12 max-w-3xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-faint">
              {t("why.guardedLabel")}
            </p>
            <ul className="mt-4 flex flex-wrap justify-center gap-2">
              {GUARDED.map((g) => (
                <li
                  key={g}
                  className="rounded-full border border-line bg-panel/70 px-3.5 py-1.5 text-[13px] font-medium text-ink backdrop-blur-sm"
                >
                  {t(`why.guarded.${g}`)}
                </li>
              ))}
            </ul>
            <p className="mx-auto mt-5 max-w-xl text-[13px] leading-relaxed text-ink-muted">
              {t("why.guardedNote")}
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
