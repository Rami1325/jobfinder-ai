import { useId, useState } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Eyebrow, Rise } from "./ui";

/**
 * Six topics: accuracy, export behaviour, access, auto-apply, templates,
 * Hebrew. The answers are rewritten in product language — the previous set
 * explained the fabrication guard, the bidi line-breaker and the complex-script
 * properties Word reads, which are true and are not what a visitor deciding
 * whether to upload a CV needs.
 *
 * Two disclosures are kept because they are limitations the reader has to
 * know: formatting checks cannot promise a specific employer's screener will
 * pass you, and the two-column templates do not export the same LAYOUT to
 * Word. The old wording said every layout was identical across both files,
 * which the gallery contradicted one section earlier.
 *
 * The panel is rendered CONDITIONALLY and animated with opacity and transform
 * only. This accordion is where the `height: "auto"` tween that wedged seven
 * shipped reveals came from; check-mirrors 11 exists because of it.
 */

const KEYS = ["1", "2", "3", "4", "5", "6"] as const;

function Row({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="border-b border-line">
      <h3>
        <button
          type="button"
          id={`${id}-b`}
          aria-expanded={open}
          aria-controls={`${id}-p`}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-[64px] w-full items-center justify-between gap-6 py-4 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="text-[17px] font-medium leading-snug text-ink sm:text-[19px]">{q}</span>
          <Plus
            size={18}
            aria-hidden
            className={`shrink-0 text-ink-faint transition-transform duration-200 ease-out-quint ${
              open ? "rotate-45" : ""
            }`}
          />
        </button>
      </h3>
      {open && (
        <div id={`${id}-p`} role="region" aria-labelledby={`${id}-b`} className="lp-in">
          <p className="max-w-[68ch] pb-6 pe-8 text-[15px] leading-relaxed text-ink-muted sm:text-base">
            {a}
          </p>
        </div>
      )}
    </div>
  );
}

export default function LandingFaq() {
  const { t } = useTranslation("marketing");
  const headingId = useId();
  return (
    <section
      id="faq"
      aria-labelledby={headingId}
      className="px-5 py-16 sm:px-8 md:py-[7rem] lg:px-14"
    >
      <div className="mx-auto w-full max-w-[820px]">
        <Rise>
          <Eyebrow>{t("landing.faq.eyebrow")}</Eyebrow>
          <h2 id={headingId} className="lp-h2 mt-4 text-[2rem] text-ink sm:text-[2.75rem]">
            {t("landing.faq.title")}
          </h2>
        </Rise>
        <Rise className="mt-10 border-t border-line">
          {KEYS.map((k) => (
            <Row key={k} q={t(`landing.faq.q${k}`)} a={t(`landing.faq.a${k}`)} />
          ))}
        </Rise>
      </div>
    </section>
  );
}
