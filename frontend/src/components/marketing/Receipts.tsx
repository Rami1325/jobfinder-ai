import { AlertTriangle, FileCheck2, Quote, TrendingUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import Reveal from "./Reveal";

/**
 * The testimonial slot — filled honestly.
 *
 * Every competitor puts star ratings and quotes here. We have no users to
 * quote yet, and fabricating them on a page that sells a fabrication guard
 * would be self-refuting. So the slot keeps the testimonial SHAPE (quote
 * mark, body, attribution) and swaps the content for real product output:
 * the lines the guard, the scorer and the ATS scan actually print. The
 * heading says so out loud, which is a stronger pitch than five fake stars.
 *
 * When there ARE real testimonials to show, see the TODO_SOCIAL_PROOF note in
 * locales/{en,he}/marketing.json.
 */
const RECEIPTS = [
  { key: "guard", icon: AlertTriangle, tone: "text-danger", tint: "bg-danger/10" },
  { key: "score", icon: TrendingUp, tone: "text-mint", tint: "bg-mint/10" },
  { key: "ats", icon: FileCheck2, tone: "text-accent", tint: "bg-accent/10" },
] as const;

/** Loose vertical stagger on desktop, like a wall of pinned notes. */
const OFFSETS = ["", "lg:mt-8", "lg:mt-16"] as const;

export default function Receipts() {
  const { t } = useTranslation("marketing");
  return (
    <section className="relative mx-auto max-w-6xl px-4 py-16 sm:py-20">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
          {t("receipts.kicker")}
        </p>
        <h2 className="mt-3 text-3xl font-bold tracking-[-0.025em] text-ink sm:text-[2.6rem] sm:leading-[1.1]">
          {t("receipts.title")}
        </h2>
        <p className="mt-4 text-base leading-relaxed text-ink-muted sm:text-lg">
          {t("receipts.sub")}
        </p>
      </Reveal>

      <ul className="mt-12 grid gap-5 lg:grid-cols-3">
        {RECEIPTS.map((r, i) => (
          <li key={r.key} className={OFFSETS[i]}>
            <Reveal delay={i * 0.08} className="h-full">
              <div className="flex h-full flex-col rounded-xl3 border border-line bg-panel p-6 shadow-card">
                <div className="flex items-start justify-between gap-3">
                  <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${r.tint} ${r.tone}`}>
                    <r.icon size={17} />
                  </span>
                  <Quote size={22} className="shrink-0 text-line rtl:-scale-x-100" aria-hidden />
                </div>
                <p className="mt-5 text-[17px] font-semibold leading-snug text-ink">
                  {t(`receipts.${r.key}.quote`)}
                </p>
                <p className="mt-3 flex-1 text-sm leading-relaxed text-ink-muted">
                  {t(`receipts.${r.key}.body`)}
                </p>
                <p className="mt-5 border-t border-line pt-4 text-[13px] font-medium text-ink-faint">
                  {t(`receipts.${r.key}.source`)}
                </p>
              </div>
            </Reveal>
          </li>
        ))}
      </ul>
    </section>
  );
}
