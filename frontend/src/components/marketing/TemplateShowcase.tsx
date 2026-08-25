import { Link } from "react-router-dom";
import { ArrowRight, Columns2, Languages, ScanLine } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, WeightedCard } from "../ui";
import Reveal from "./Reveal";
import ResumeMiniature, { MINIATURE_TEMPLATES, PDF_ONLY_TEMPLATES } from "./ResumeMiniature";

const PROOF = [
  { icon: ScanLine, key: "ats" },
  { icon: Languages, key: "bilingual" },
  { icon: Columns2, key: "pages" },
] as const;

/**
 * The templates, shown as documents.
 *
 * This is the section the whole landing was rebuilt around: the product is a
 * rendered page, so the page is what the marketing site has to show. The
 * miniatures are drawn from the real TemplateSpec values — see
 * ResumeMiniature.tsx. Adding a template to the backend means adding it to
 * MINIATURE_TEMPLATES and adding its two locale strings.
 */
export default function TemplateShowcase() {
  const { t } = useTranslation("marketing");
  return (
    <section id="templates" className="relative mx-auto max-w-6xl px-4 py-16 sm:py-20">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
          {t("templates.kicker")}
        </p>
        <h2 className="mt-3 text-3xl font-bold tracking-[-0.025em] text-ink sm:text-[2.6rem] sm:leading-[1.1]">
          {t("templates.title")}
        </h2>
        <p className="mt-4 text-base leading-relaxed text-ink-muted sm:text-lg">
          {t("templates.sub")}
        </p>
      </Reveal>

      <ul className="mt-12 grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-6 lg:grid-cols-4">
        {MINIATURE_TEMPLATES.map((id, i) => (
          <li key={id}>
            <Reveal delay={(i % 4) * 0.07}>
              {/* Weighted hover: the cursor presses the sheet into the page and
                  the corner under it bears the load. Every card gets it —
                  animating only the first would read as a bug. */}
              <WeightedCard className="rounded-[10px] bg-white ring-1 ring-ink/[0.07]">
                <ResumeMiniature
                  template={id}
                  label={t("templates.alt", { name: t(`templates.${id}.name`) })}
                  className="block h-auto w-full rtl:-scale-x-100"
                />
                {/* Two-column layouts render in the PDF only — the DOCX falls
                    back to a single-column sibling. Saying so on the thumbnail
                    is cheaper than a surprise at download time. */}
                {PDF_ONLY_TEMPLATES.includes(id) && (
                  <span className="absolute end-2 top-2 rounded-full bg-ink/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white backdrop-blur-sm">
                    {t("templates.pdfOnly")}
                  </span>
                )}
              </WeightedCard>
              <h3 className="mt-4 text-sm font-semibold text-ink">{t(`templates.${id}.name`)}</h3>
              <p className="mt-1 text-[13px] leading-snug text-ink-muted">
                {t(`templates.${id}.desc`)}
              </p>
            </Reveal>
          </li>
        ))}
      </ul>

      <Reveal delay={0.1}>
        <ul className="mt-14 grid gap-6 border-t border-line pt-10 sm:grid-cols-3">
          {PROOF.map((p) => (
            <li key={p.key} className="flex gap-3">
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
                <p.icon size={17} />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-ink">{t(`templates.proof.${p.key}.title`)}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                  {t(`templates.proof.${p.key}.body`)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Reveal>

      <Reveal delay={0.15}>
        <div className="mt-10 flex justify-center">
          <Link to="/app">
            <Button size="lg" icon={<ArrowRight size={18} className="rtl:-scale-x-100" />}>
              {t("templates.cta")}
            </Button>
          </Link>
        </div>
      </Reveal>
    </section>
  );
}
