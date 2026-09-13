import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link2, Plus, Undo2 } from "lucide-react";
import { dismissInboxEvent, listInboxEvents, resolveInboxEvent } from "../../api/client";
import { Button, Modal, Skeleton, useToast } from "../ui";
import { apiErrorCode } from "../../lib/apiError";
import type { ApplicationOut, InboxEvent } from "../../types";
import {
  GmailLink,
  KindBadge,
  formatDay,
  isRefusal,
  isUndoable,
  useInboxRefusalText,
  useLocaleTag,
  useOutcomeText,
  useStatusLabel,
  useUndoEvent,
} from "./shared";

const REVIEW_LIMIT = 50;
const RECENT_LIMIT = 20;

function newestFirst(a: InboxEvent, b: InboxEvent): number {
  return new Date(b.received_at).getTime() - new Date(a.received_at).getTime();
}

/** A company name reduced to what two spellings of it share: case, quote marks
 * (ASCII and Hebrew geresh/gershayim) and punctuation dropped. For ordering a
 * picker only. Which application an email belongs to is the server's call, and
 * this never makes it. */
function companyKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/["'׳״]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The applications a needs-review email can be linked to: the ones from its
 * company, or every one when none matches. A picker filtered down to nothing is
 * a dead end, and the email usually lands in review precisely because the
 * company did not match cleanly. */
function linkCandidates(ev: InboxEvent, apps: ApplicationOut[]): { options: ApplicationOut[]; matched: boolean } {
  const key = companyKey(ev.company);
  if (!key) return { options: apps, matched: false };
  const same = apps.filter((a) => {
    const k = companyKey(a.company);
    if (!k) return false;
    return k === key || (Math.min(k.length, key.length) >= 4 && (k.includes(key) || key.includes(k)));
  });
  return same.length ? { options: same, matched: true } : { options: apps, matched: false };
}

/**
 * The emails the scanner was not sure about, and the changes it made on its own.
 *
 * A portalled `Modal`, never a popover. The board's columns are
 * `overflow-hidden`, so anything anchored inside a card is clipped, and a sheet
 * is the one surface a phone can give this list whole.
 *
 * Needs review: every action is OPTIMISTIC. The row leaves the list at the tap
 * and comes back, with a toast saying why, when nothing happened on the server.
 * An email another tab or a sync already filed stays out, because it has left
 * the queue either way. Each row is a decision the user has already made, and
 * making them wait on a spinner per email is how a queue of twelve stops
 * getting cleared.
 *
 * Recent automatic updates: Undo lives HERE (and in the detail modal), never in
 * a toast, because `Toast` has no action slot and is gone in 3.6 s.
 */
export default function InboxReviewSheet({
  open,
  onClose,
  apps,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  apps: ApplicationOut[];
  /** Something on the board may have changed: refresh it and the counts. */
  onChanged: () => void;
}) {
  const { t } = useTranslation("tracker");
  const { t: tc } = useTranslation();
  const toast = useToast();
  const locale = useLocaleTag();
  const outcome = useOutcomeText();
  const statusLabel = useStatusLabel();
  const undo = useUndoEvent(onChanged);
  const refusal = useInboxRefusalText();
  const [review, setReview] = useState<InboxEvent[] | null>(null);
  const [recent, setRecent] = useState<InboxEvent[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [linking, setLinking] = useState<number | null>(null);
  const [choice, setChoice] = useState("");

  // Re-read on every open. A cron or another tab may have filed half of these
  // since the last look, and a stale row's action would 404.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setReview(null);
    setRecent(null);
    setLoadError(false);
    setLinking(null);
    Promise.all([listInboxEvents("review", REVIEW_LIMIT), listInboxEvents("recent", RECENT_LIMIT)])
      .then(([r, c]) => {
        if (!live) return;
        setReview([...r].sort(newestFirst));
        setRecent([...c].sort(newestFirst));
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [open]);

  async function act(ev: InboxEvent, run: () => Promise<unknown>, done: string) {
    setLinking(null);
    setChoice("");
    setReview((prev) => prev?.filter((x) => x.id !== ev.id) ?? prev);
    try {
      await run();
      toast("success", done);
      onChanged();
      // A filed email becomes an automatic update the user can undo, so the
      // second list is re-read rather than left one row short.
      listInboxEvents("recent", RECENT_LIMIT)
        .then((c) => setRecent([...c].sort(newestFirst)))
        .catch(() => {});
    } catch (e) {
      // Already filed (another tab, or a sync that got there first) or gone:
      // the row really has left the queue, so it stays out and the board is
      // re-read. Anything else puts it back, because nothing happened.
      const code = apiErrorCode(e);
      const left = code === "inbox_not_review" || code === "inbox_not_found" || code === "inbox_event_not_found";
      if (!left) setReview((prev) => [...(prev ?? []), ev].sort(newestFirst));
      toast(isRefusal(e) ? "info" : "error", refusal(e, t("inbox.sheet.actionError")));
      if (left) onChanged();
    }
  }

  const setRecentAction = (id: number, action: string) =>
    setRecent((prev) => prev?.map((ev) => (ev.id === id ? { ...ev, action } : ev)) ?? prev);

  const heading = "text-sm font-semibold text-ink";

  return (
    <Modal open={open} onClose={onClose} title={t("inbox.sheet.title")} maxWidth="max-w-xl">
      {loadError ? (
        <p className="text-sm text-danger">{t("inbox.sheet.loadError")}</p>
      ) : !review || !recent ? (
        <div className="space-y-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-20" />
        </div>
      ) : (
        <div className="space-y-7">
          <section>
            <h3 className={heading}>{t("inbox.sheet.reviewTitle")}</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">{t("inbox.sheet.reviewHint")}</p>
            {review.length === 0 ? (
              <p className="mt-3 text-sm text-ink-faint">{t("inbox.sheet.reviewEmpty")}</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {review.map((ev) => {
                  const who = ev.from_name || ev.from_email;
                  const quote = ev.evidence || ev.snippet;
                  const { options, matched } = linkCandidates(ev, apps);
                  return (
                    <li key={ev.id} className="rounded-xl border border-line bg-bg-soft p-3">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <KindBadge kind={ev.kind} />
                        <span className="text-[11px] tabular-nums text-ink-faint">
                          {formatDay(ev.received_at, locale)}
                        </span>
                        {/* In the header row, not under the actions: at 390px the
                            three buttons already wrap to two rows, and the link
                            under them added a third row to every email. */}
                        <GmailLink url={ev.gmail_url} className="ms-auto" />
                      </div>
                      <p dir="auto" className="mt-1 break-words text-sm font-semibold text-ink">
                        {[ev.company, ev.job_title].filter(Boolean).join(" · ") || t("inbox.sheet.noCompany")}
                      </p>
                      {(who || ev.subject) && (
                        // Two isolates: a Latin address beside a Hebrew subject
                        // reorders the separator between them otherwise.
                        <p className="mt-0.5 break-words text-xs text-ink-muted">
                          {who && <bdi>{who}</bdi>}
                          {who && ev.subject && " · "}
                          {ev.subject && <bdi>{ev.subject}</bdi>}
                        </p>
                      )}
                      {quote && (
                        <blockquote
                          dir="auto"
                          className="mt-2 break-words border-s-2 border-accent/40 ps-2.5 text-xs leading-relaxed text-ink-muted"
                        >
                          {quote}
                        </blockquote>
                      )}

                      {linking === ev.id ? (
                        <div className="animate-fade-up mt-3 space-y-2">
                          {apps.length === 0 ? (
                            <p className="text-xs leading-relaxed text-ink-muted">{t("inbox.sheet.noApps")}</p>
                          ) : (
                            <>
                              <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
                                {t("inbox.sheet.linkLabel")}
                                <select
                                  value={choice}
                                  onChange={(e) => setChoice(e.target.value)}
                                  className="min-h-11 w-full rounded-lg border border-line bg-bg px-2.5 text-sm text-ink focus:border-accent/60 focus:outline-none"
                                >
                                  <option value="">{t("inbox.sheet.linkPlaceholder")}</option>
                                  {options.map((a) => (
                                    <option key={a.id} value={a.id}>
                                      {`${a.job_title || "—"} · ${a.company || "—"} · ${statusLabel(a.status || "saved")}`}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              {!matched && ev.company && (
                                <p className="text-xs leading-relaxed text-ink-faint">{t("inbox.sheet.linkAll")}</p>
                              )}
                            </>
                          )}
                          <div className="flex flex-wrap gap-2">
                            {apps.length > 0 && (
                              <Button
                                size="sm"
                                disabled={!choice}
                                onClick={() =>
                                  void act(
                                    ev,
                                    () => resolveInboxEvent(ev.id, { application_id: Number(choice) }),
                                    t("inbox.sheet.linked"),
                                  )
                                }
                                className="min-h-11"
                              >
                                {t("inbox.sheet.linkConfirm")}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setLinking(null)}
                              className="min-h-11"
                            >
                              {tc("actions.cancel")}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            icon={<Plus size={14} />}
                            onClick={() =>
                              void act(ev, () => resolveInboxEvent(ev.id, { create: true }), t("inbox.sheet.added"))
                            }
                            className="min-h-11"
                          >
                            {t("inbox.sheet.add")}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={<Link2 size={14} />}
                            onClick={() => {
                              setLinking(ev.id);
                              setChoice("");
                            }}
                            className="min-h-11"
                          >
                            {t("inbox.sheet.link")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void act(ev, () => dismissInboxEvent(ev.id), t("inbox.sheet.ignored"))}
                            className="min-h-11"
                          >
                            {t("inbox.sheet.ignore")}
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h3 className={heading}>{t("inbox.sheet.recentTitle")}</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">{t("inbox.sheet.recentHint")}</p>
            {recent.length === 0 ? (
              <p className="mt-3 text-sm text-ink-faint">{t("inbox.sheet.recentEmpty")}</p>
            ) : (
              <ul className="mt-2 divide-y divide-line/60">
                {recent.map((ev) => {
                  const line = outcome(ev);
                  const undoable = isUndoable(ev);
                  return (
                    <li key={ev.id} className="py-3">
                      <div className="flex items-center gap-2">
                        <KindBadge kind={ev.kind} />
                        <span dir="auto" className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                          {[ev.company, ev.job_title].filter(Boolean).join(" · ") || t("inbox.sheet.noCompany")}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
                          {formatDay(ev.received_at, locale)}
                        </span>
                      </div>
                      {line && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{line}</p>}
                      {(undoable || ev.gmail_url) && (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {undoable && (
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<Undo2 size={14} className="rtl:-scale-x-100" />}
                              onClick={() => void undo(ev, setRecentAction)}
                              className="min-h-11"
                            >
                              {t("inbox.undo")}
                            </Button>
                          )}
                          <GmailLink url={ev.gmail_url} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
