import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { RESUME_TEMPLATES, type ResumeTemplate } from "../api/client";
import TemplateThumb from "./TemplateThumb";
import { cn } from "../lib/cn";

/**
 * Two-column designs the PDF engine can draw but the ATS-safe DOCX cannot
 * (no tables, no text boxes — that rule is not negotiable). Their Word
 * download falls back to the closest single-column sibling, so every surface
 * that offers a .docx has to say so out loud.
 */
export const PDF_ONLY_TEMPLATES: readonly ResumeTemplate[] = ["split", "panel"];

export function isPdfOnlyTemplate(id: ResumeTemplate): boolean {
  return PDF_ONLY_TEMPLATES.includes(id);
}

interface TemplatePickerProps {
  value: ResumeTemplate;
  onChange: (id: ResumeTemplate) => void;
  /** Accessible name for the radiogroup (the pages own their own wording). */
  label: string;
  className?: string;
}

/**
 * The visual template picker: eleven hand-drawn miniatures instead of eleven
 * text pills, because a name alone can't tell you a template has a colour band
 * or a sidebar.
 *
 * Accessibility is a real radiogroup — arrow keys move focus *and* the
 * selection (the WAI-ARIA pattern), Home/End jump to the ends, and only the
 * checked option is tabbable, so the group is one Tab stop. Arrow direction is
 * read off `<html dir>` at keypress time, so it stays right across a language
 * switch without re-rendering.
 *
 * Layout: below `sm` this is a snap rail that scrolls itself — `body` is
 * `overflow-x: clip` under 1024px, so a region that scrolls sideways must own
 * its own scroll container. The `-mx-5 / px-5` pair bleeds the rail to the
 * edge of the surrounding `Card` (p-5) and pads it back; keep the picker
 * inside a p-5 card or the bleed won't line up.
 */
export default function TemplatePicker({ value, onChange, label, className }: TemplatePickerProps) {
  const { t } = useTranslation("tailor");
  const uid = useId();
  // Whatever the pointer or keyboard is on right now; falls back to the
  // selection, so the one-liner strip is never empty.
  const [preview, setPreview] = useState<ResumeTemplate | null>(null);
  const btns = useRef<Array<HTMLButtonElement | null>>([]);
  const active = preview ?? value;

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onChange(RESUME_TEMPLATES[i]);
      return;
    }
    const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
    const step =
      e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowUp"
          ? -1
          : e.key === "ArrowRight"
            ? rtl
              ? -1
              : 1
            : e.key === "ArrowLeft"
              ? rtl
                ? 1
                : -1
              : 0;

    let next: number;
    if (step !== 0) next = i + step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = RESUME_TEMPLATES.length - 1;
    else return;

    e.preventDefault();
    const n = RESUME_TEMPLATES.length;
    const target = ((next % n) + n) % n;
    onChange(RESUME_TEMPLATES[target]);
    btns.current[target]?.focus();
  }

  return (
    <div className={className}>
      <div
        role="radiogroup"
        aria-label={label}
        className={cn(
          "-mx-5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 py-3",
          "sm:mx-0 sm:grid sm:snap-none sm:grid-cols-4 sm:overflow-visible sm:px-0 sm:py-2",
          "md:grid-cols-5 xl:grid-cols-6",
        )}
      >
        {RESUME_TEMPLATES.map((id, i) => {
          const selected = id === value;
          const descId = `${uid}-${id}`;
          return (
            <button
              key={id}
              ref={(el) => {
                btns.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-describedby={descId}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              onMouseEnter={() => setPreview(id)}
              onMouseLeave={() => setPreview((p) => (p === id ? null : p))}
              onFocus={() => setPreview(id)}
              onBlur={() => setPreview((p) => (p === id ? null : p))}
              className={cn(
                "relative w-[116px] shrink-0 snap-start rounded-xl border p-2 text-start sm:w-auto",
                // Transition duration is neutralised by the global
                // prefers-reduced-motion rule in styles.css.
                "transition duration-200 ease-out-quint",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                selected
                  ? "-translate-y-0.5 border-accent bg-accent/10 shadow-glow ring-1 ring-accent"
                  : "border-line bg-panel-2 hover:-translate-y-0.5 hover:border-accent/40",
              )}
            >
              <TemplateThumb id={id} />
              {isPdfOnlyTemplate(id) && (
                <span className="pointer-events-none absolute end-3 top-3 rounded-full bg-bg/85 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-ink-muted backdrop-blur-sm">
                  {t("download.pdfOnlyBadge")}
                </span>
              )}
              <span className="mt-2 block truncate text-xs font-semibold text-ink">
                {t(`download.templates.${id}.name`)}
              </span>
              {/* The one-liner is read out per option; it is shown visually in
                  the shared strip below so eleven cards stay the same height. */}
              <span id={descId} className="sr-only">
                {t(`download.templates.${id}.desc`)}
              </span>
            </button>
          );
        })}
      </div>
      <p aria-hidden className="mt-1 text-xs leading-relaxed text-ink-muted">
        <span className="me-1 font-semibold text-ink">
          {t(`download.templates.${active}.name`)}
        </span>
        {t(`download.templates.${active}.desc`)}
      </p>
    </div>
  );
}
