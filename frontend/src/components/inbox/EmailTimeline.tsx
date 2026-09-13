import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Undo2 } from "lucide-react";
import { Button } from "../ui";
import type { InboxEvent } from "../../types";
import {
  GmailLink,
  KindBadge,
  formatDay,
  isUndoable,
  useLocaleTag,
  useOutcomeText,
  useUndoEvent,
} from "./shared";

/** Rows before "Show all". Five fit the first screen of the modal on a phone,
 * and the tailored resume starts directly underneath. */
const SHOWN = 5;

function newestFirst(a: InboxEvent, b: InboxEvent): number {
  return new Date(b.received_at).getTime() - new Date(a.received_at).getTime();
}

/**
 * The emails behind one application, inside the tracker's detail modal.
 *
 * ABOVE the resume view, and that placement is most of the point. The modal is
 * the badge row, the notes, then a tailored resume thousands of pixels tall; a
 * timeline under that is one nobody scrolls to, and "why did this card move to
 * Interview?" is exactly what someone opens the modal to ask after a sync.
 *
 * Undo flips a row in place (`useUndoEvent`), and the parent then re-reads the
 * application, because undoing a CREATE deletes the very card this modal is
 * showing.
 */
export default function EmailTimeline({
  events,
  onUndone,
}: {
  events: InboxEvent[];
  onUndone: () => void;
}) {
  const { t } = useTranslation("tracker");
  const locale = useLocaleTag();
  const outcome = useOutcomeText();
  const undo = useUndoEvent(onUndone);
  const [list, setList] = useState(() => [...events].sort(newestFirst));
  const [all, setAll] = useState(false);

  // A re-read application arrives as a new array, and the server's answer wins
  // over whatever this list flipped optimistically.
  useEffect(() => setList([...events].sort(newestFirst)), [events]);

  if (list.length === 0) return null;

  const setAction = (id: number, action: string) =>
    setList((prev) => prev.map((ev) => (ev.id === id ? { ...ev, action } : ev)));
  const shown = all ? list : list.slice(0, SHOWN);

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted rtl:tracking-normal">
        {t("inbox.timeline.title")}
      </h3>
      <ol className="divide-y divide-line/60 rounded-xl border border-line bg-bg-soft">
        {shown.map((ev) => {
          const line = outcome(ev);
          const undoable = isUndoable(ev);
          return (
            <li key={ev.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <KindBadge kind={ev.kind} />
                <span className="text-[11px] tabular-nums text-ink-faint">
                  {formatDay(ev.received_at, locale)}
                </span>
              </div>
              {/* dir="auto" per subject: one timeline holds a Hebrew recruiter's
                  subject line and an English ATS one. */}
              {ev.subject && (
                <p dir="auto" className="mt-1.5 line-clamp-2 break-words text-sm text-ink">
                  {ev.subject}
                </p>
              )}
              {line && <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{line}</p>}
              {(ev.gmail_url || undoable) && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <GmailLink url={ev.gmail_url} />
                  {undoable && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Undo2 size={14} className="rtl:-scale-x-100" />}
                      onClick={() => void undo(ev, setAction)}
                      className="min-h-11"
                    >
                      {t("inbox.undo")}
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {list.length > SHOWN && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="mt-1 inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-accent-soft hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          {all ? t("inbox.timeline.fewer") : t("inbox.timeline.all", { count: list.length })}
        </button>
      )}
    </section>
  );
}
