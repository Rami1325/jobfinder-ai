import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Inbox, ListChecks, RefreshCw, X } from "lucide-react";
import { getInboxStatus, startInboxGoogle, syncInbox } from "../../api/client";
import { Button, useToast } from "../ui";
import { cn } from "../../lib/cn";
import { hideInboxHint, isInboxHintHidden, type InboxHint } from "../../lib/inboxHint";
import type { ApplicationOut, InboxStatus, InboxSyncResult } from "../../types";
import InboxReviewSheet from "./InboxReviewSheet";
import { formatDay, useAgo, useInboxRefusalText, useLocaleTag, useMinuteTick, useSyncErrorText } from "./shared";

/** Opening the tracker syncs in the background only past this. The cron runs
 * twice a day, and a sync per visit would spend the daily classification cap
 * on a user who checks the board every few minutes. */
const STALE_MS = 30 * 60_000;

/** I2: an import of past mail runs at most three rounds in the foreground. The
 * cron carries an unfinished import on, so a phone held open on this page is
 * never how a 60-day import has to finish, and the copy says so. */
const IMPORT_ROUNDS = 3;

// Module-level, for TrackerPage's `appsCache` reason: switching tabs must not
// flash the bar away and back while the status is re-read.
let statusCache: InboxStatus | null = null;
// One sync per tab. The mount's background sync, a tap on Sync and the
// connect-time import would otherwise stack three runs of the same mailbox.
let inflight: Promise<void> | null = null;
// An unfinished import outlives leaving the page, so coming back still says
// it is running rather than going quiet mid-import.
let importCache: { days: number; read: number } | null = null;

type Mode = "manual" | "background" | "import";

function HintRow({ label, onHide, children }: { label: string; onHide: () => void; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-xl2 border border-line bg-panel/60 py-1 pe-1 ps-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent-soft">
        <Inbox size={16} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3">{children}</div>
      <button
        type="button"
        onClick={onHide}
        aria-label={label}
        title={label}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-panel-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

/**
 * Gmail sync on the tracker: one compact bar above the board, never sticky.
 *
 * It says only what the board needs: whether mail is being read, how fresh the
 * board is, what is waiting for a decision, and the one action each state
 * needs. Everything that is a SETTING (the look-back window, auto-sync,
 * disconnecting, what is read) lives in Settings, and "Connect Gmail" goes
 * there, so consent is asked for in one place with the explanation beside it.
 *
 * States, in order:
 *   - not allowed (`reason: "invite_only"`): one line, hideable.
 *   - not configured on the server: nothing at all.
 *   - not connected: one line + Connect, hideable.
 *   - needs reconnecting: warning tone + Reconnect.
 *   - connected: "Gmail · synced 12 min ago", Review (with the count), Sync, and
 *     "Reconnect by <date>" while Google keeps the app in testing (O3).
 *
 * `onChanged` is called only when a sync WROTE something. A background sync that
 * found nothing must not reload a board the user is in the middle of reading.
 */
export default function InboxBar({ apps, onChanged }: { apps: ApplicationOut[]; onChanged: () => void }) {
  const { t } = useTranslation("tracker");
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const locale = useLocaleTag();
  const ago = useAgo();
  const errorText = useSyncErrorText();
  const refusal = useInboxRefusalText();
  useMinuteTick();
  const [status, setStatus] = useState<InboxStatus | null>(statusCache);
  const [syncing, setSyncing] = useState(false);
  const [importing, setImporting] = useState(importCache);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [hidden, setHidden] = useState(() => ({
    connect: isInboxHintHidden("connect"),
    inviteOnly: isInboxHintHidden("inviteOnly"),
  }));
  const alive = useRef(true);
  // The page's `refresh` is a new function every render; a ref keeps the sync
  // closures calling the current one without re-running any effect.
  const changed = useRef(onChanged);
  changed.current = onChanged;

  async function reloadStatus(): Promise<InboxStatus | null> {
    try {
      const s = await getInboxStatus();
      statusCache = s;
      if (alive.current) setStatus(s);
      return s;
    } catch {
      // Best-effort, the nudges strip's rule: a backend without /inbox, or a
      // failed read, hides the bar and never touches the board.
      return null;
    }
  }

  function sync(mode: Mode, days = 0): Promise<void> {
    if (inflight) return inflight;
    const job = (async () => {
      setSyncing(true);
      if (mode === "import") {
        importCache = { days, read: 0 };
        setImporting(importCache);
      }
      let wrote = false;
      let updates = 0;
      let last: InboxSyncResult | null = null;
      try {
        const rounds = mode === "import" ? IMPORT_ROUNDS : 1;
        for (let i = 0; i < rounds; i++) {
          // A page left mid-import stops asking. The cron finishes the job,
          // which is what "you can leave this page" promised.
          if (i > 0 && !alive.current) break;
          last = await syncInbox();
          updates += last.created + last.updated + last.review;
          wrote = wrote || updates > 0 || last.events > 0;
          if (importCache) {
            importCache =
              last.has_more && !last.error_code ? { ...importCache, read: importCache.read + last.scanned } : null;
            if (alive.current) setImporting(importCache);
          }
          if (last.error_code || !last.has_more) break;
        }
        if (last?.error_code) {
          // A run already holding the mailbox is not a fault worth red.
          if (mode !== "background")
            toast(last.error_code === "sync_in_progress" ? "info" : "error", errorText(last.error_code));
        } else if (mode === "import" && last && !last.has_more) {
          toast("success", t("inbox.toasts.importDone"));
        } else if (mode === "manual") {
          if (updates > 0) toast("success", t("inbox.toasts.updates", { count: updates }));
          else if (!last?.has_more) toast("info", t("inbox.toasts.nothingNew"));
        }
      } catch (e) {
        importCache = null;
        if (alive.current) setImporting(null);
        if (mode !== "background") toast("error", refusal(e, t("inbox.toasts.syncError")));
      } finally {
        inflight = null;
        if (alive.current) setSyncing(false);
        await reloadStatus();
        if (wrote) changed.current();
      }
    })();
    inflight = job;
    return job;
  }

  useEffect(() => {
    alive.current = true;
    let live = true;

    // Google's callback lands here as ?inbox=connected. The flag is taken out
    // of the address at once, so a reload cannot start a second import.
    const justConnected = params.get("inbox") === "connected";
    if (justConnected) {
      const next = new URLSearchParams(params);
      next.delete("inbox");
      setParams(next, { replace: true });
    }

    // A sync started before this mount (the tab switched away mid-run) still
    // has to be reflected here when it lands.
    if (inflight) {
      setSyncing(true);
      void inflight.finally(() => {
        if (!live) return;
        setSyncing(false);
        setImporting(importCache);
        changed.current();
      });
    }

    void (async () => {
      const s = await reloadStatus();
      if (!live || !s?.connected) return;
      if (justConnected) {
        toast("success", t("inbox.toasts.connected"));
        void sync("import", s.backfill_days);
        return;
      }
      if (inflight || s.status === "needs_reauth" || !s.auto_sync) return;
      const lastSync = s.last_sync_at ? new Date(s.last_sync_at).getTime() : NaN;
      if (Number.isNaN(lastSync) || Date.now() - lastSync > STALE_MS) void sync("background");
    })();

    return () => {
      live = false;
      alive.current = false;
    };
    // Mount only: the sync loop reads the latest callbacks through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function hide(hint: InboxHint) {
    hideInboxHint(hint);
    setHidden((h) => ({ ...h, [hint]: true }));
  }

  async function reconnect() {
    if (reconnecting) return;
    setReconnecting(true);
    try {
      // A document load: the next page is Google's. `reconnecting` stays set,
      // so the button cannot fire twice while the page is leaving.
      window.location.assign(await startInboxGoogle());
    } catch (e) {
      // Through the refusal hook, never apiErrorMessage directly: a 403
      // invite_only here read "Couldn't start reconnecting" (check-mirrors 37).
      toast("error", refusal(e, t("inbox.toasts.reconnectError")));
      setReconnecting(false);
    }
  }

  if (!status) return null;

  if (!status.connected && !status.ready) {
    if (status.reason !== "invite_only" || hidden.inviteOnly) return null;
    return (
      <HintRow label={t("inbox.bar.dismiss")} onHide={() => hide("inviteOnly")}>
        <p className="py-2 text-sm leading-relaxed text-ink-muted">{t("inbox.bar.inviteOnly")}</p>
      </HintRow>
    );
  }

  if (!status.connected) {
    if (hidden.connect) return null;
    // `ready` without Google means the server offers only the demo mailbox.
    const demo = !status.google_ready;
    return (
      <HintRow label={t("inbox.bar.dismiss")} onHide={() => hide("connect")}>
        <p className="min-w-[10rem] flex-1 py-2 text-sm leading-relaxed text-ink">
          {demo ? t("inbox.bar.demoPitch") : t("inbox.bar.connectPitch")}
        </p>
        <Link
          to={{ pathname: "/settings", hash: "#inbox" }}
          className="inline-flex min-h-11 items-center rounded-lg px-1 text-sm font-semibold text-accent-soft hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          {demo ? t("inbox.bar.demoCta") : t("inbox.bar.connectCta")}
        </Link>
      </HintRow>
    );
  }

  const reauth = status.status === "needs_reauth";
  const code = status.last_error_code;
  const provider = status.provider === "fake" ? t("inbox.provider.fake") : t("inbox.provider.gmail");
  const when = ago(status.last_sync_at);
  const due = reauth ? "" : formatDay(status.reauth_due_at, locale);
  // The backend keeps a connection "active" through an ordinary failed run and
  // records the failure only in `last_error_code`, which the next good run
  // clears, so a code on an active connection IS "the last sync did not
  // finish". While it needs reconnecting, the first line already says so; a
  // second line is worth it only for the two reasons that add something: the
  // weekly testing expiry, and a grant that no longer includes Gmail.
  const problem = reauth
    ? code === "reauth_due" || code === "missing_scope"
      ? errorText(code)
      : ""
    : errorText(code);
  const importDays = importing?.days ?? (status.backfilling ? status.backfill_days : 0);

  return (
    <section
      aria-label={t("inbox.bar.label")}
      className={cn(
        "rounded-xl2 border px-3 py-1",
        reauth ? "border-warn/50 bg-warn/10" : "border-line bg-panel/60",
      )}
    >
      {/* flex-wrap with a 12rem floor on the status text, SettingsPage's
          ACTION_HINT rule: without the floor the text shrinks to a truncated
          sliver beside the two buttons at 390px; with it the buttons drop to
          their own row. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <div className="flex min-w-[12rem] flex-1 items-center gap-2.5 py-1.5">
          <span
            className={cn(
              "grid h-8 w-8 shrink-0 place-items-center rounded-lg",
              reauth ? "bg-warn/15 text-warn" : "bg-accent/12 text-accent-soft",
            )}
          >
            {reauth ? <AlertTriangle size={16} aria-hidden /> : <Inbox size={16} aria-hidden />}
          </span>
          {/* Wraps, never truncates. The needs-reconnecting sentence and an
              error are the lines here that must be read whole, and at 390px
              `truncate` cut the first to "Syncing is pa…". */}
          <div className="min-w-0">
            <p className="break-words text-sm font-medium leading-snug text-ink">
              {reauth
                ? t("inbox.bar.needsReauth")
                : `${provider} · ${when ? t("inbox.bar.synced", { when }) : t("inbox.bar.neverSynced")}`}
            </p>
            {(problem || due) && (
              <p className={cn("mt-0.5 break-words text-xs leading-snug", problem ? "text-warn" : "text-ink-muted")}>
                {problem || t("inbox.bar.reconnectBy", { date: due })}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 py-1">
          <Button
            size="sm"
            variant="secondary"
            icon={<ListChecks size={14} />}
            onClick={() => setSheetOpen(true)}
            className={cn("min-h-11", status.review_count > 0 && "border-warn/50 text-warn")}
          >
            {status.review_count > 0
              ? t("inbox.bar.review", { count: status.review_count })
              : t("inbox.bar.updates")}
          </Button>
          {reauth ? (
            <Button size="sm" loading={reconnecting} onClick={() => void reconnect()} className="min-h-11">
              {t("inbox.bar.reconnect")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              loading={syncing}
              icon={<RefreshCw size={14} />}
              onClick={() => void sync("manual")}
              className="min-h-11"
            >
              {t("inbox.bar.sync")}
            </Button>
          )}
        </div>
      </div>
      {/* The live region is always mounted and only its text changes, for
          auth/shared's FormError reason: a region that mounts together with
          its message is often never announced. */}
      <div aria-live="polite">
        {importDays > 0 && (
          <p className="animate-fade-up border-t border-line/60 py-2 text-xs leading-relaxed text-ink-muted">
            {t("inbox.bar.importing", { days: importDays })}
            {importing && importing.read > 0 && ` ${t("inbox.bar.read", { count: importing.read })}`}
          </p>
        )}
      </div>
      <InboxReviewSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        apps={apps}
        onChanged={() => {
          void reloadStatus();
          changed.current();
        }}
      />
    </section>
  );
}
