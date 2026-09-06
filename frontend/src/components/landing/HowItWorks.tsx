import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Eyebrow, Rise, Section } from "./ui";

/**
 * Three steps, then one small demonstration of the thing the steps describe.
 *
 * The proof block replaces four paragraphs about an immutable facts ledger.
 * It is STATIC — the same two sentences every time, no cycling — because a
 * rewrite that keeps re-animating is a slot machine, not evidence.
 *
 * THE FIGURES ARE THE POINT, so they are marked in both sentences: the wording
 * moved, the numbers did not. They are Latin numerals in both locales, which
 * is why the marked substrings can live here as data instead of needing a
 * per-language segmentation of the sentence.
 */

const STEPS = ["upload", "role", "review"] as const;
const MARKS = ["4.1%", "1.6%"];

/** Split a sentence on the marked figures and tint them. Order-independent. */
function marked(text: string): ReactNode[] {
  const pattern = new RegExp(`(${MARKS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return text.split(pattern).map((part, i) =>
    MARKS.includes(part) ? (
      <mark
        key={i}
        className="rounded bg-accent/20 px-1 py-0.5 text-ink [unicode-bidi:isolate]"
      >
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export default function HowItWorks() {
  const { t } = useTranslation("marketing");
  const headingId = useId();

  return (
    <Section id="how" labelledBy={headingId}>
      <Rise className="max-w-[680px]">
        <Eyebrow>{t("landing.how.eyebrow")}</Eyebrow>
        <h2 id={headingId} className="lp-h2 mt-4 text-[2rem] text-ink sm:text-[2.75rem] lg:text-[3.25rem]">
          {t("landing.how.title")}
        </h2>
      </Rise>

      {/* A row of three on a desktop, separated by hairlines rather than by
          three elevated cards. `divide-*` follows the writing direction, so
          the rules land between the steps in Hebrew too. */}
      <Rise className="mt-12 grid gap-px border-t border-line md:mt-16 md:grid-cols-3">
        {STEPS.map((k, i) => (
          <div
            key={k}
            className="border-b border-line py-8 md:border-b-0 md:border-e md:pe-8 md:last:border-e-0 md:[&:not(:first-child)]:ps-8"
          >
            <p className="text-[13px] font-medium tabular-nums text-ink-faint">
              {String(i + 1).padStart(2, "0")}
            </p>
            <h3 className="mt-4 text-[21px] font-medium leading-snug text-ink sm:text-[23px]">
              {t(`landing.how.${k}.title`)}
            </h3>
            <p className="mt-3 max-w-[42ch] text-[15px] leading-relaxed text-ink-muted">
              {t(`landing.how.${k}.body`)}
            </p>
          </div>
        ))}
      </Rise>

      <Rise className="mt-12 md:mt-16">
        <div className="rounded-[18px] border border-line bg-panel p-6 sm:p-9">
          <h3 className="text-[19px] font-medium text-ink sm:text-[21px]">
            {t("landing.how.proof.title")}
          </h3>

          <dl className="mt-6 grid gap-5 md:grid-cols-2 md:gap-8">
            <div>
              <dt className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-faint rtl:tracking-normal">
                {t("landing.how.proof.beforeLabel")}
              </dt>
              <dd className="mt-2 text-[15px] leading-relaxed text-ink-muted sm:text-base">
                {marked(t("landing.how.proof.before"))}
              </dd>
            </div>
            <div>
              <dt className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-faint rtl:tracking-normal">
                {t("landing.how.proof.afterLabel")}
              </dt>
              <dd className="mt-2 text-[15px] leading-relaxed text-ink sm:text-base">
                {marked(t("landing.how.proof.after"))}
              </dd>
            </div>
          </dl>

          <p className="mt-6 border-t border-line pt-5 text-[14px] leading-relaxed text-ink-muted">
            {t("landing.how.proof.note")}
          </p>
          <p className="mt-2 text-[13px] text-ink-faint">{t("landing.how.proof.caption")}</p>
        </div>
      </Rise>
    </Section>
  );
}
