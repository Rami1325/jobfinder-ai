import { useRef } from "react";
import { useInView } from "framer-motion";
import { useTranslation } from "react-i18next";
import { CountUp } from "../ui";
import Reveal from "./Reveal";

/**
 * Hard numbers — and only ones that can be checked against this repository.
 *
 * There is deliberately no user count, star rating or "hired last month"
 * figure here. This is a new tool with no such numbers, and inventing them on
 * a page whose entire pitch is that the product does not invent things would
 * be the one unforgivable copy decision.
 *
 * Sources, all verified at the time of writing:
 *  - 0   accounts:  no auth anywhere in app/api/routes.py; the free scan at
 *                   /scan is public.
 *  - 5   boards:    PROVIDERS in backend/app/core/providers/__init__.py —
 *                   LinkedIn, Drushim, Comeet, JobMaster, Greenhouse.
 *  - 2   languages: locales/en + locales/he, with real RTL end to end.
 *  - 600+ checks:   backend/tests/smoke_test.py, which renders every template
 *                   in both formats and both languages and re-extracts the
 *                   text to prove it stays ATS-parseable. Counted at 666 on
 *                   2026-08-25 (`python -m tests.smoke_test | grep -c PASS`).
 *
 * This one is printed as a FLOOR ("600+"), not an exact figure, and that is
 * deliberate: it is the only stat here that moves on every backend commit.
 * It shipped as a bare "609" and was already false by the time the template
 * registry grew to eleven — a stale precise number on a page whose headline is
 * "counted from the source" is worse than an honest floor. Raise the floor when
 * the real count clears the next hundred; never restore an exact integer.
 *
 * Re-verify these before changing them; the labels live in the locale files
 * so a correction is a one-line edit in each language.
 */
const STATS = [
  { key: "accounts", to: 0, suffix: "", tint: "bg-paper-violet/[0.16]", ink: "text-accent" },
  { key: "boards", to: 5, suffix: "", tint: "bg-paper-mint/[0.2]", ink: "text-mint" },
  { key: "languages", to: 2, suffix: "", tint: "bg-paper-peach/[0.22]", ink: "text-ink" },
  { key: "checks", to: 600, suffix: "+", tint: "bg-paper-blush/[0.18]", ink: "text-accent" },
] as const;

// The tiles used to be staggered (`lg:mt-10` on the 2nd and 4th) to borrow the
// competitor's loose, playful baseline. It did not survive contact with real
// copy: grid items stretch, so the BOTTOMS stayed pinned to the row while the
// tops stepped down — four cards of visibly different heights with a ragged
// top edge, which reads as a layout bug rather than as a deliberate rhythm.
// A stagger only works when the tiles are free-standing and equal-sized; here
// they are neither. Straight row, equal heights.

export default function StatStrip() {
  const { t } = useTranslation("marketing");
  const ref = useRef<HTMLUListElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });

  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:py-20">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
          {t("stats.kicker")}
        </p>
        <h2 className="mt-3 text-3xl font-bold tracking-[-0.025em] text-ink sm:text-[2.4rem] sm:leading-[1.12]">
          {t("stats.title")}
        </h2>
      </Reveal>

      <ul ref={ref} className="mt-12 grid grid-cols-2 gap-4 sm:gap-5 lg:grid-cols-4">
        {STATS.map((s) => (
          <li
            key={s.key}
            className={`flex flex-col rounded-xl3 border border-line/70 p-5 sm:p-6 ${s.tint}`}
          >
            {/* `dir="ltr"` on an INLINE span, not the block: a trailing "+" is a
                bidi-neutral character, so inside the RTL page "600+" would be
                reordered to "+600". Isolating just the numeral fixes the glyph
                order while the block stays end-aligned with the Hebrew label
                under it. */}
            <p className={`text-4xl font-bold tabular-nums tracking-tight sm:text-5xl ${s.ink}`}>
              <span dir="ltr" className="inline-block">
                {inView ? <CountUp to={s.to} suffix={s.suffix} duration={0.9} /> : 0}
              </span>
            </p>
            <p className="mt-2 text-sm font-semibold text-ink">{t(`stats.${s.key}.label`)}</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
              {t(`stats.${s.key}.note`)}
            </p>
          </li>
        ))}
      </ul>

      <Reveal delay={0.1}>
        <p className="mx-auto mt-8 max-w-2xl text-center text-[13px] leading-relaxed text-ink-faint">
          {t("stats.footnote")}
        </p>
      </Reveal>
    </section>
  );
}
