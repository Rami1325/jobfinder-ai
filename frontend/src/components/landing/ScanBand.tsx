import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Cta, Rise } from "./ui";

/**
 * The free scan, as one calm band rather than another card.
 *
 * The old strip carried a competitor's monthly price. That was a claim about
 * someone else's pricing with no dated source behind it, and pricing research
 * is not part of a landing redesign — so it is gone, and the sentence that
 * replaces it describes what the scan actually returns.
 *
 * "No account or access code required" is verified rather than assumed:
 * `POST /public/scan` is outside the access gate and the whole check is
 * deterministic Python, which is also why it can be free.
 */
export default function ScanBand() {
  const { t } = useTranslation("marketing");
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="px-5 sm:px-8 lg:px-14">
      <div className="mx-auto w-full max-w-[1160px]">
        <Rise className="rounded-[20px] border border-line bg-bg-soft px-6 py-10 sm:px-10 sm:py-12">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between lg:gap-14">
            <div className="max-w-[52ch]">
              <h2 id={headingId} className="lp-h2 text-[1.75rem] text-ink sm:text-[2.25rem]">
                {t("landing.scan.title")}
              </h2>
              <p className="mt-4 text-[16px] leading-relaxed text-ink-muted sm:text-[17px]">
                {t("landing.scan.body")}
              </p>
              <p className="mt-3 text-[13px] text-ink-faint">{t("landing.scan.note")}</p>
            </div>
            <div className="shrink-0">
              <Cta to="/scan" arrow>
                {t("landing.hero.ctaSecondary")}
              </Cta>
            </div>
          </div>
        </Rise>
      </div>
    </section>
  );
}
