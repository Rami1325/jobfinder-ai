import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResumeTemplate } from "../../api/client";
import { PDF_ONLY, TEMPLATE_IDS } from "../../lib/templateSpecs";
import ResumeMiniature from "../marketing/ResumeMiniature";
import { Cta, Eyebrow, Rise, Section } from "./ui";
import { cn } from "../../lib/cn";

/**
 * The product, shown as the product: one upright A4 page, large, with a
 * compact picker beside it.
 *
 * The old gallery drew all twelve sheets at once, which made the page a
 * contact sheet rather than a product shot. Every template is still reachable
 * — the picker is the inventory — but only one is ever the subject.
 *
 * THE SET IS READ FROM `TEMPLATE_IDS`, never counted into copy. That list is
 * the frontend mirror of `backend/app/render/templates.py` and check-mirrors 23
 * fails the build when the two drift, so a template added to the renderer
 * appears here the moment its spec is mirrored — and no sentence on this page
 * has to be edited to agree with it.
 *
 * The preview is `ResumeMiniature`, the same honest miniature engine the old
 * gallery used: real text, real margins, real type sizes, every geometric fact
 * taken from the template's own spec.
 */

/** A4 at 1pt = 1 unit, so the stage reserves its box before anything draws. */
const A4_RATIO = "595 / 842";

export default function TemplateStage() {
  const { t } = useTranslation("marketing");
  const [template, setTemplate] = useState<ResumeTemplate>(TEMPLATE_IDS[0]);
  const selectId = useId();
  const headingId = useId();

  const name = (id: ResumeTemplate) => t(`templates.${id}.name`);
  const pdfOnly = PDF_ONLY(template);

  return (
    <Section id="templates" labelledBy={headingId}>
      <Rise className="max-w-[680px]">
        <Eyebrow>{t("landing.templates.eyebrow")}</Eyebrow>
        <h2 id={headingId} className="lp-h2 mt-4 text-[2rem] text-ink sm:text-[2.75rem] lg:text-[3.25rem]">
          {t("landing.templates.title")}
        </h2>
        <p className="mt-5 max-w-[58ch] text-[17px] leading-relaxed text-ink-muted">
          {t("landing.templates.sub")}
        </p>
      </Rise>

      <Rise className="mt-12 grid gap-8 lg:mt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.72fr)] lg:items-start lg:gap-14">
        {/* ---- the picker. Above the sheet on a phone, beside it on a desktop,
                which is why it comes first in the DOM and is re-ordered with
                `lg:order-2` rather than duplicated. ---- */}
        <div className="lg:order-2">
          {/* Native select below `lg`: a twelve-item grid of buttons on a
              390px screen is a wall, and the platform picker is better at
              being a picker than anything drawn here. */}
          <div className="lg:hidden">
            <label htmlFor={selectId} className="mb-2 block text-[13px] font-medium text-ink-muted">
              {t("landing.templates.pickerLabel")}
            </label>
            <select
              id={selectId}
              value={template}
              onChange={(e) => setTemplate(e.target.value as ResumeTemplate)}
              className="min-h-[48px] w-full rounded-xl border border-ink/20 bg-panel px-3 text-[15px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {TEMPLATE_IDS.map((id) => (
                <option key={id} value={id}>
                  {name(id)}
                </option>
              ))}
            </select>
          </div>

          <div className="hidden lg:block">
            <p className="text-[13px] font-medium text-ink-muted" id={`${selectId}-lbl`}>
              {t("landing.templates.pickerLabel")}
            </p>
            <ul
              aria-labelledby={`${selectId}-lbl`}
              className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1"
            >
              {TEMPLATE_IDS.map((id) => {
                const on = id === template;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setTemplate(id)}
                      className={cn(
                        "flex min-h-[44px] w-full items-center rounded-lg px-3 text-start text-[15px] transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                        on
                          ? "bg-ink/[0.10] font-medium text-ink"
                          : "text-ink-muted hover:bg-ink/[0.05] hover:text-ink",
                      )}
                    >
                      {name(id)}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* The selected template's own description and its real export
              behaviour, next to the choice they describe. */}
          <div className="mt-7 border-t border-line pt-6">
            <h3 className="text-[21px] font-medium text-ink">{name(template)}</h3>
            <p className="mt-2 max-w-[46ch] text-[15px] leading-relaxed text-ink-muted">
              {t(`templates.${template}.desc`)}
            </p>
            <p className="mt-4 max-w-[46ch] text-[13px] leading-relaxed text-ink-faint">
              {pdfOnly ? t("landing.templates.pdfOnly") : t("landing.templates.bothFormats")}
            </p>
          </div>

          <div className="mt-8">
            <Cta to="/signup" arrow>
              {t("landing.hero.ctaPrimary")}
            </Cta>
          </div>
        </div>

        {/* ---- the sheet ---- */}
        <div className="lg:order-1">
          <div className="rounded-[20px] border border-line bg-panel p-4 sm:p-7">
            {/* The box is reserved by aspect ratio, so switching template
                crossfades inside a stage that never changes size. */}
            <div
              className="relative mx-auto w-full overflow-hidden rounded-[6px] shadow-doc"
              style={{ aspectRatio: A4_RATIO }}
            >
              <ResumeMiniature
                key={template}
                template={template}
                /* The demo CV is English, so the DOCUMENT is left-to-right even
                   when the interface is Hebrew. */
                mirror={false}
                label={t("templates.alt", { name: name(template) })}
                className="lp-swap absolute inset-0 block h-full w-full"
              />
            </div>
          </div>
          <p className="mt-4 text-center text-[13px] text-ink-faint">
            {t("landing.templates.caption")}
          </p>
        </div>
      </Rise>
    </Section>
  );
}
