// Search in plain words (Phase 32): one line, Hebrew or English, read by the
// server into the search form's OWN fields (app/core/search_query.py: rules
// first, the model only for what they leave). The page fills the fields and
// opens them; nothing is searched until the user taps Find jobs, because a
// search is a monthly use and a misread line must be seen before it costs one.
// The line and what was understood live on the PAGE (`usePlainSearch`), so the
// search card can fold and unfold around this box without losing either.
import { useEffect, useId, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { readSearchQuery } from "../../api/client";
import { Button } from "../../components/ui";
import { apiErrorMessage } from "../../lib/apiError";
import type { SearchQueryReading } from "../../types";
import { LOCATION_PRESETS, parseWorkModes, readingUnderstood } from "./shared";

// The page's box stops here; the server refuses more than 1 KB as kind "query".
export const PLAIN_MAX_CHARS = 300;

export interface PlainSearchState {
  text: string;
  setText: (text: string) => void;
  reading: SearchQueryReading | null;
  setReading: (r: SearchQueryReading | null) => void;
  error: string;
  setError: (e: string) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  /** Answers received, and answers brought into view. A submit's answer is
   * scrolled into view ONCE, by whichever box renders it (the card unfolds on a
   * fill, so that is a new box); a box that mounts later, when a search folds
   * the card again, never pulls the page back up to it. */
  answered: MutableRefObject<number>;
  shown: MutableRefObject<number>;
}

/** The box's state, owned by the page so both states of the search card show
 * the same line and the same answer. */
export function usePlainSearch(): PlainSearchState {
  const [text, setText] = useState("");
  const [reading, setReading] = useState<SearchQueryReading | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const answered = useRef(0);
  const shown = useRef(0);
  return { text, setText, reading, setReading, error, setError, busy, setBusy, answered, shown };
}

export function PlainSearch({
  state,
  onRead,
  disabled = false,
  className = "",
}: {
  state: PlainSearchState;
  /** Called only with a reading that said something; the page fills its form. */
  onRead: (r: SearchQueryReading) => void;
  /** While the form is being prefilled from the resume, whose answer would land
   * over what this box filled in. */
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("jobs");
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const answer = useRef<HTMLDivElement>(null);
  const { text, setText, reading, setReading, error, setError, busy, setBusy, answered, shown } = state;
  // A phone's keyboard can still be up when the answer lands: bring the answer
  // into view, the least scroll that shows it, once per submit.
  useEffect(() => {
    if (answered.current > shown.current) {
      shown.current = answered.current;
      answer.current?.scrollIntoView({ block: "nearest" });
    }
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const line = text.trim();
    if (!line || busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      const r = await readSearchQuery(line);
      setReading(r);
      answered.current += 1;
      if (readingUnderstood(r)) onRead(r);
      // Close the phone's keyboard, so what was filled in is what the screen shows.
      input.current?.blur();
    } catch (err) {
      setReading(null);
      setError(apiErrorMessage(err, t("plain.error")));
      answered.current += 1;
    } finally {
      setBusy(false);
    }
  }

  const place = (value: string) => {
    const preset = LOCATION_PRESETS.find((p) => p.value === value);
    return preset ? t(`search.presets.${preset.key}`) : value;
  };
  const chips: string[] = [];
  if (reading) {
    chips.push(...reading.job_titles);
    if (reading.location) chips.push(place(reading.location));
    const modes = parseWorkModes(reading.work_mode);
    if (reading.work_mode && modes.length === 0) chips.push(t("workModes.any"));
    for (const m of modes) chips.push(t(`workModes.${m}`));
    if (reading.include_worldwide) chips.push(t("plain.worldwide"));
  }

  return (
    <form role="search" onSubmit={submit} className={className}>
      <label htmlFor={inputId} className="sr-only">
        {t("plain.label")}
      </label>
      <div className="flex items-center gap-2 sm:max-w-xl">
        <div className="relative min-w-0 flex-1">
          <Sparkles
            size={16}
            aria-hidden
            className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-accent-soft"
          />
          {/* 16 px text on a phone: iOS zooms the page into any smaller input
              on focus, and nothing here may move under the thumb. */}
          <input
            ref={input}
            id={inputId}
            dir="auto"
            value={text}
            maxLength={PLAIN_MAX_CHARS}
            enterKeyHint="search"
            autoComplete="off"
            onChange={(e) => setText(e.target.value)}
            placeholder={t("plain.placeholder")}
            className="h-11 w-full rounded-lg border border-line bg-bg-soft pe-3 ps-9 text-base text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none sm:text-sm"
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          loading={busy}
          disabled={disabled || !text.trim()}
          className="h-11 min-w-[44px] shrink-0"
        >
          {t("plain.fill")}
        </Button>
      </div>
      {/* Clear of the phone's tab bar (3.5 rem and the safe area) when scrolled to. */}
      <div ref={answer} aria-live="polite" className="scroll-mb-24 lg:scroll-mb-4">
        {reading && readingUnderstood(reading) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
            <span>{t("plain.filled")}</span>
            {chips.map((chip, i) => (
              <span
                key={`${i}-${chip}`}
                dir="auto"
                className="inline-block max-w-full truncate rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 align-middle font-medium leading-4 text-ink"
              >
                {chip}
              </span>
            ))}
          </div>
        )}
        {reading && readingUnderstood(reading) && reading.notes.includes("region") && (
          <p className="mt-1 text-xs text-ink-faint">{t("plain.noteRegion")}</p>
        )}
        {reading && readingUnderstood(reading) && reading.notes.includes("places") && (
          <p className="mt-1 text-xs text-ink-faint">{t("plain.notePlaces", { place: place(reading.location) })}</p>
        )}
        {reading && reading.notes.includes("experience") && (
          <p className="mt-1 text-xs text-ink-faint">{t("plain.noteExperience")}</p>
        )}
        {reading && !readingUnderstood(reading) && <p className="mt-2 text-xs text-ink-muted">{t("plain.nothing")}</p>}
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </div>
    </form>
  );
}
