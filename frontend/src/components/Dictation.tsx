// The mic on an interview answer box, its "Listening" badge and its note
// (docs/handbook/interview.md). Every piece renders nothing where the browser
// has no speech recognition, so an unsupported browser shows the box exactly as
// before. Nothing here talks to a server (check-mirrors 89).
import { Mic, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Dictation } from "../hooks/useDictation";
import { cn } from "../lib/cn";

/**
 * A real toggle button: `aria-pressed` carries the state and the name stays
 * "Speak your answer" in both states, as a toggle's name should. What SHOWS the
 * state is not colour alone: the mic becomes a stop square, a ring pulses round
 * it, and the box carries a "Listening" badge (`ListeningBadge`). 44 px square
 * below `lg`, the same size in both states, so nothing beside it moves.
 */
export function DictateButton({ dictation }: { dictation: Dictation }) {
  const { t } = useTranslation("interview");
  if (!dictation.supported) return null;
  const on = dictation.listening;
  return (
    <>
      <button
        type="button"
        aria-pressed={on}
        aria-label={t("dictate.label")}
        title={t("dictate.label")}
        disabled={dictation.disabled}
        onClick={dictation.toggle}
        className={cn(
          // No colour transition: the state flips on the tap, not 150 ms later.
          "relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border lg:h-9 lg:w-9",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          "disabled:cursor-not-allowed disabled:opacity-50",
          on
            ? "border-danger/60 bg-danger/15 text-danger"
            : "border-line bg-panel-2 text-ink-muted hover:border-accent/60 hover:text-ink",
        )}
      >
        {on && (
          <span
            aria-hidden
            className="pointer-events-none absolute -inset-1 rounded-xl border-2 border-danger/50 motion-safe:animate-pulse"
          />
        )}
        {on ? <Square size={14} fill="currentColor" aria-hidden /> : <Mic size={18} aria-hidden />}
      </button>
      <span className="sr-only" aria-live="polite">
        {on ? t("dictate.on") : ""}
      </span>
    </>
  );
}

/** "Listening", sitting on the box's top edge while the mic is on. Absolutely
 * placed inside the box's `relative` wrapper, so it moves nothing. */
export function ListeningBadge({ dictation }: { dictation: Dictation }) {
  const { t } = useTranslation("interview");
  if (!dictation.supported || !dictation.listening) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute -top-2.5 end-3 z-[1] inline-flex items-center gap-1.5 rounded-full bg-danger px-2 text-[11px] font-semibold leading-5 text-white shadow-card"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-white motion-safe:animate-pulse" />
      {t("dictate.listening")}
    </span>
  );
}

/** Why the mic stopped, when the person should be told: a blocked microphone
 * and how to allow it, nothing heard, no connection to the speech service, the
 * answer's length limit. */
export function DictationNote({ dictation, className }: { dictation: Dictation; className?: string }) {
  const { t } = useTranslation("interview");
  if (!dictation.supported || !dictation.note) return null;
  return (
    <p role="status" className={cn("text-xs leading-relaxed text-ink-muted", className)}>
      {dictation.note === "denied" && t("dictate.note.denied")}
      {dictation.note === "service" && t("dictate.note.service")}
      {dictation.note === "noSpeech" && t("dictate.note.noSpeech")}
      {dictation.note === "network" && t("dictate.note.network")}
      {dictation.note === "noMic" && t("dictate.note.noMic")}
      {dictation.note === "cap" && t("dictate.note.cap")}
      {dictation.note === "stopped" && t("dictate.note.stopped")}
      {dictation.note === "failed" && t("dictate.note.failed")}
    </p>
  );
}
