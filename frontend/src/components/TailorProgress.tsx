import { useTranslation } from "react-i18next";
import { Check, Circle, Loader2 } from "lucide-react";
import { TAILOR_STAGES, stageStates, type TailorStage } from "../lib/tailorStages";
import { cn } from "../lib/cn";

/**
 * The running tailor's REAL stages, over the paper while it runs (PLAN 31.3/2).
 *
 * A tailor takes about 20 s, and the page showed two grey skeletons for all of
 * it, below the document, where a phone never scrolled. Now it shows the five
 * stages the pipeline reports over `POST /tailor/stream`: done, the one running,
 * and the ones still to come. A stage moves only when the server said so
 * (`stageStates`), the rule `ScanPanel` follows for the boards: "never animate
 * progress that is not being measured". The one spinner is on the stage the
 * server said started; the rest stand still.
 *
 * Screen readers hear each stage once as it starts, from one polite line, not
 * the whole list on every change.
 */
export default function TailorProgress({ stages }: { stages: readonly TailorStage[] }) {
  const { t } = useTranslation("tailor");
  const states = stageStates(stages);
  const active = TAILOR_STAGES.find((s) => states[s] === "active");
  return (
    <section className="rounded-xl border border-line bg-panel px-3 py-2.5 shadow-sm">
      <p className="text-xs font-semibold text-ink">{t("progress.title")}</p>
      <p className="sr-only" aria-live="polite">
        {active ? t(`progress.stages.${active}`) : ""}
      </p>
      <ol className="mt-2 grid gap-1">
        {TAILOR_STAGES.map((s) => (
          <li
            key={s}
            className={cn("flex items-center gap-2 text-xs", states[s] === "pending" ? "text-ink-faint" : "text-ink")}
          >
            {states[s] === "done" ? (
              <Check size={13} aria-hidden className="shrink-0 text-mint" />
            ) : states[s] === "active" ? (
              <Loader2 size={13} aria-hidden className="shrink-0 animate-spin text-accent" />
            ) : (
              <Circle size={13} aria-hidden className="shrink-0 text-line" />
            )}
            <span>{t(`progress.stages.${s}`)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
