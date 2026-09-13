import { useEffect, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { CalendarCheck2, ExternalLink, Mail } from "lucide-react";
import { undoInboxEvent } from "../../api/client";
import { Badge, useToast } from "../ui";
import { apiErrorCode, apiErrorMessage } from "../../lib/apiError";
import { cn } from "../../lib/cn";
import { dateOfRecord } from "../../hooks/useTrackerMetrics";
import type { ApplicationOut, InboxEvent } from "../../types";

/**
 * What the inbox surfaces share: the email-kind badge, dates in the UI
 * language, "12 min ago", the line saying what an email did to the board, and
 * Undo.
 *
 * EVERY LABEL IS A LITERAL `t()` CALL IN A `switch`, never
 * t(`inbox.kinds.${kind}`). check-mirrors 29 resolves literal calls against
 * both locales and cannot read a template literal, so a kind added with no
 * string behind it would put a raw key on a card at 12px in Hebrew while the
 * build stayed green. The `default` branch gives a value a newer backend sends
 * a neutral label instead of a key.
 */

type Tone = NonNullable<ComponentProps<typeof Badge>["tone"]>;

/** The board's column tones, so a badge and the column it points toward agree:
 * an interview is warn, an offer mint, a rejection danger, a confirmation
 * accent. Everything else is neutral. */
const KIND_TONE: Record<string, Tone> = {
  confirmation: "accent",
  interview: "partial",
  offer: "mint",
  rejection: "danger",
};

/** The UI language as a date locale: the tag TrackerAnalytics and
 * VersionHistory already use, so a date reads the same on every tracker
 * surface. */
export function useLocaleTag(): string {
  const { i18n } = useTranslation();
  return i18n.language === "he" ? "he-IL" : "en-GB";
}

/** "3 Sept", or "3 Sept 2025" outside the current year. "" for a missing or
 * unreadable value, which every caller treats as unknown rather than printing.
 *
 * The inbox fields carry an explicit offset and are shown in the viewer's own
 * calendar. The tracker's older naive `created_at` parses as local time, which
 * lands on the same calendar day its raw string names, so the card's date does
 * not move by a day for a row that predates the offset. */
export function formatDay(iso: string | null | undefined, localeTag: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(localeTag, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(d);
}

/** Re-render once a minute, so "12 min ago" on a page left open does not stay
 * 12 for an hour. */
export function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
}

/** "12 min ago" for a past timestamp, or null when there is none to read.
 *
 * Whole phrases per unit, for lib/apiError's `retryMessage` reason: engines
 * disagree on Intl.RelativeTimeFormat's Hebrew fragment, and a translator needs
 * the phrase, not a slot. A timestamp a skewed clock puts in the future reads
 * "just now", never "in 2 min". */
export function useAgo(): (iso: string | null | undefined) => string | null {
  const { t } = useTranslation("tracker");
  return (iso) => {
    const ts = iso ? new Date(iso).getTime() : NaN;
    if (Number.isNaN(ts)) return null;
    const mins = Math.floor((Date.now() - ts) / 60_000);
    if (mins < 1) return t("inbox.ago.justNow");
    if (mins < 60) return t("inbox.ago.minutes", { count: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t("inbox.ago.hours", { count: hours });
    return t("inbox.ago.days", { count: Math.floor(hours / 24) });
  };
}

/** A tracker status key's own column label. The backend only ever writes the
 * five keys; any other value is data, shown as it came. */
export function useStatusLabel(): (status: string) => string {
  const { t } = useTranslation("tracker");
  return (status) => {
    switch (status) {
      case "saved":
        return t("status.saved");
      case "applied":
        return t("status.applied");
      case "interview":
        return t("status.interview");
      case "offer":
        return t("status.offer");
      case "rejected":
        return t("status.rejected");
      default:
        return status;
    }
  };
}

export function useKindLabel(): (kind: string) => string {
  const { t } = useTranslation("tracker");
  return (kind) => {
    switch (kind) {
      case "confirmation":
        return t("inbox.kinds.confirmation");
      case "viewed":
        return t("inbox.kinds.viewed");
      case "interview":
        return t("inbox.kinds.interview");
      // I5: an assessment is its own badge and moves no column. It is not an
      // interview, and labelling it one is how the Interviews tile and the
      // Interview column came to disagree.
      case "assessment":
        return t("inbox.kinds.assessment");
      case "offer":
        return t("inbox.kinds.offer");
      case "rejection":
        return t("inbox.kinds.rejection");
      case "recruiter":
        return t("inbox.kinds.recruiter");
      default:
        return t("inbox.kinds.other");
    }
  };
}

export function KindBadge({ kind, className }: { kind: string; className?: string }) {
  const label = useKindLabel();
  return (
    <Badge tone={KIND_TONE[kind] ?? "neutral"} className={className}>
      {label(kind)}
    </Badge>
  );
}

/** The column each kind moves a card into, for the kinds that move one. */
const STATUS_OF_KIND: Record<string, string> = {
  confirmation: "applied",
  interview: "interview",
  offer: "offer",
  rejection: "rejected",
};

/**
 * The newest email's kind on a tracker card, WHEN IT SAYS SOMETHING THE CARD
 * DOES NOT.
 *
 * Not whenever an email exists, and that was seen rather than guessed: on the
 * first browser pass an Interview card read "Interview" twice, this badge
 * beside the status chip in the same tone, and every Offer and Declined card
 * did the same. A kind that restates the column the card sits in is dropped;
 * one that adds to it (Viewed, Assessment, a recruiter) or disagrees with it
 * stays. "other" tells a card nothing either. The full history is one tap away
 * in the detail modal.
 *
 * A STATIC badge, never a control: the columns are overflow-hidden, so
 * anything that opened from here would be clipped. The mail glyph is what
 * separates it from the status chip at a glance, and the sentence behind it is
 * what a screen reader hears instead of a bare second label.
 */
export function CardEmailBadge({ app }: { app: ApplicationOut }) {
  const { t } = useTranslation("tracker");
  const label = useKindLabel();
  const kind = app.last_email_kind ?? "";
  if (!kind || kind === "other" || STATUS_OF_KIND[kind] === (app.status || "saved")) return null;
  const text = label(kind);
  const sentence = t("inbox.card.latestEmail", { kind: text });
  // `relative` anchors the sr-only sentence (position: absolute) to the badge.
  // Without it, the browser pass measured that span far outside its card, in
  // a column the board had scrolled away: an invisible box whose containing
  // block is a scroll container's ancestor can still widen what scrolls.
  return (
    <Badge tone={KIND_TONE[kind] ?? "neutral"} title={sentence} className="relative">
      <Mail size={11} aria-hidden />
      <span aria-hidden>{text}</span>
      <span className="sr-only">{sentence}</span>
    </Badge>
  );
}

/**
 * The card's date: "Applied 3 Sept" when the application has a date it was
 * SENT, otherwise the day it was added, unlabelled. A save date is never
 * called an application date.
 *
 * The value is `dateOfRecord`, the precedence the analytics buckets on, so the
 * card and the weekly chart cannot file one application under two days.
 */
export function CardDate({ app }: { app: ApplicationOut }) {
  const { t } = useTranslation("tracker");
  const locale = useLocaleTag();
  const day = formatDay(dateOfRecord(app), locale);
  return (
    <span className="text-[11px] text-ink-faint">
      {!day ? app.created_at?.slice(0, 10) : app.applied_at ? t("inbox.card.applied", { date: day }) : day}
    </span>
  );
}

/** "Applied 3 Sept" in the detail modal's badge row. Nothing when the date it
 * was sent is unknown: an unknown is not a date to print. */
export function AppliedBadge({ appliedAt }: { appliedAt?: string | null }) {
  const { t } = useTranslation("tracker");
  const locale = useLocaleTag();
  const day = formatDay(appliedAt, locale);
  if (!day) return null;
  return (
    <Badge tone="neutral">
      <CalendarCheck2 size={11} aria-hidden /> {t("inbox.card.applied", { date: day })}
    </Badge>
  );
}

/** What an email did to the board, in one line. "" for an action this build
 * does not know, which the caller then leaves out. */
export function useOutcomeText(): (ev: InboxEvent) => string {
  const { t } = useTranslation("tracker");
  const status = useStatusLabel();
  return (ev) => {
    let line = "";
    switch (ev.action) {
      case "created":
        line = ev.new_status
          ? t("inbox.outcome.created", { status: status(ev.new_status) })
          : t("inbox.outcome.createdPlain");
        break;
      case "updated":
        line = ev.prev_status
          ? t("inbox.outcome.updated", { from: status(ev.prev_status), to: status(ev.new_status) })
          : t("inbox.outcome.movedTo", { to: status(ev.new_status) });
        break;
      case "linked":
        line = t("inbox.outcome.linked");
        break;
      case "review":
        line = t("inbox.outcome.review");
        break;
      case "dismissed":
        line = t("inbox.outcome.dismissed");
        break;
      case "undone":
        line = t("inbox.outcome.undone");
        break;
    }
    // The interviewed flag moves no column, so it is the one change the line
    // would otherwise hide: an interview invite on a row already past
    // Interview still ticks it (I5).
    if (line && ev.set_interviewed && ev.action !== "undone")
      line += ` · ${t("inbox.outcome.interviewed")}`;
    return line;
  };
}

/** Undo exists for what an email changed on the board: a card it created, a
 * status it moved, and the interviewed flag it set on a card it only linked to
 * (I5, the one change that moves no column). Those are exactly the three the
 * backend reverts (`inbox_apply.undo`) and the three the recent view lists. A
 * plain link changed nothing, and an undone email has been undone. */
export function isUndoable(ev: InboxEvent): boolean {
  return ev.action === "created" || ev.action === "updated" || (ev.action === "linked" && ev.set_interviewed);
}

/**
 * Undo, optimistic with rollback: `toggleInterviewed`'s shape on TrackerPage,
 * not `changeStatus`'s (no catch, no rollback), which tracker.md records as the
 * defect to avoid copying.
 *
 * The row reads "Undone" at the tap and flips back, with an error toast, if the
 * request fails. Undo lives in the LIST, never in a toast: `Toast` carries text
 * only and is gone in 3.6 s, which is not long enough to find the button in.
 */
export function useUndoEvent(onDone: () => void) {
  const { t } = useTranslation("tracker");
  const toast = useToast();
  const refusal = useInboxRefusalText();
  return async (ev: InboxEvent, setAction: (id: number, action: string) => void): Promise<void> => {
    setAction(ev.id, "undone");
    try {
      await undoInboxEvent(ev.id);
      toast("success", t("inbox.toasts.undone"));
      onDone();
    } catch (e) {
      setAction(ev.id, ev.action);
      toast(isRefusal(e) ? "info" : "error", refusal(e, t("inbox.toasts.undoError")));
    }
  };
}

/** The refusals that ANSWER a request rather than fail it: the card was moved
 * by hand after the email (undoing would overwrite the user), the change can
 * no longer be undone, the email was already filed. A retry changes none of
 * them, so they are said as information, never as an error to try again. */
const ANSWERS = new Set(["inbox_changed_since", "inbox_not_undoable", "inbox_not_review"]);

export function isRefusal(e: unknown): boolean {
  return ANSWERS.has(apiErrorCode(e) ?? "");
}

/** The inbox routes' structured refusals (`{"code": "inbox_..."}`) as
 * sentences. The backend sends codes so they are translated here; anything
 * else goes through `apiErrorMessage` with the caller's fallback. */
export function useInboxRefusalText(): (e: unknown, fallback: string) => string {
  const { t } = useTranslation("tracker");
  return (e, fallback) => {
    switch (apiErrorCode(e)) {
      case "inbox_changed_since":
        return t("inbox.refusals.changedSince");
      case "inbox_not_undoable":
        return t("inbox.refusals.notUndoable");
      case "inbox_not_review":
        return t("inbox.refusals.notReview");
      case "inbox_application_not_found":
        return t("inbox.refusals.applicationGone");
      case "inbox_not_found":
      case "inbox_event_not_found":
        return t("inbox.refusals.eventGone");
      case "invite_only":
        return t("inbox.bar.inviteOnly");
      default:
        return apiErrorMessage(e, fallback);
    }
  };
}

/** "Open in Gmail", as a 44px target. Only for an https address: the link is
 * built server-side, and anything else is not a link worth following. */
export function GmailLink({ url, className }: { url?: string; className?: string }) {
  const { t } = useTranslation("tracker");
  if (!url || !url.startsWith("https://")) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-accent-soft hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        className,
      )}
    >
      <ExternalLink size={13} aria-hidden />
      {t("inbox.openInGmail")}
    </a>
  );
}

/** A sync error code (`InboxSyncResult.error_code`, `InboxStatus.last_error_code`)
 * as a sentence. The codes are app/core/inbox_sync.py's: each one the user can
 * act on, or should not bother acting on, gets its own sentence, and any other
 * gets the generic line, never the raw code. "" for no error. */
export function useSyncErrorText(): (code: string) => string {
  const { t } = useTranslation("tracker");
  return (code) => {
    switch (code) {
      case "":
        return "";
      // O3: a testing app's 7-day grant ran out. A date, not a fault.
      case "reauth_due":
        return t("inbox.errors.reauthDue");
      case "missing_scope":
        return t("inbox.errors.missingScope");
      case "needs_reauth":
      case "invalid_grant":
      case "token_unreadable":
        return t("inbox.errors.reauth");
      case "daily_limit":
        return t("inbox.errors.dailyLimit");
      // Another run (the cron, another tab) holds the mailbox.
      case "sync_in_progress":
        return t("inbox.errors.inProgress");
      // The server's problem, not the user's: there is nothing to reconnect.
      case "token_key_missing":
      case "google_not_configured":
      case "fake_disabled":
        return t("inbox.errors.server");
      default:
        return t("inbox.errors.generic");
    }
  };
}
