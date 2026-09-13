import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, Inbox, RefreshCw, Unplug } from "lucide-react";
import {
  connectFakeInbox,
  disconnectInbox,
  getInboxStatus,
  startInboxGoogle,
  updateInboxSettings,
} from "../../api/client";
import { Badge, Button, Card, CardTitle, useToast } from "../ui";
import { apiErrorMessage } from "../../lib/apiError";
import { cn } from "../../lib/cn";
import type { InboxStatus } from "../../types";
import { formatDay, useAgo, useInboxRefusalText, useLocaleTag, useMinuteTick, useSyncErrorText } from "./shared";

/** The look-back choices offered before connecting. The server accepts 7-180;
 * three choices is a decision a thumb makes, and a slider is not. */
const BACKFILL_CHOICES = [30, 60, 90];
const DEFAULT_BACKFILL = 60;

/**
 * Gmail sync in Settings: the one place that asks for consent, so the
 * explanation sits beside the button that gives it.
 *
 * Before connecting it says, in three lines, what is read and what is kept,
 * and offers a look-back window. The tracker's "Connect Gmail" links here
 * rather than starting OAuth from a one-line bar, so nobody reaches Google's
 * consent screen without having been shown that.
 *
 * Disconnect is arm-then-confirm, and its consequence is visible AT REST, the
 * danger zone's rule: "your tracker keeps every card" is what someone deciding
 * whether to disconnect needs to read before tapping, not after.
 *
 * Renders nothing when the server has no Gmail set up at all, and one line when
 * this account is not on the invite list. A CONNECTED account always gets the
 * card, even one taken off the list since: it must still be able to disconnect.
 */
export default function InboxSettingsCard() {
  const { t } = useTranslation("settings");
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { hash, key } = useLocation();
  const locale = useLocaleTag();
  const ago = useAgo();
  const errorText = useSyncErrorText();
  const refusal = useInboxRefusalText();
  useMinuteTick();
  const [status, setStatus] = useState<InboxStatus | null>(null);
  const [days, setDays] = useState(DEFAULT_BACKFILL);
  // Google sends a failed connection back as ?inbox=<code>. Read once, and the
  // flag is taken out of the address below, so a reload does not repeat an old
  // failure over a card that has since moved on.
  const [callback] = useState(() => params.get("inbox") ?? "");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [armed, setArmed] = useState(false);
  const [purge, setPurge] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    let live = true;
    if (params.has("inbox")) {
      const next = new URLSearchParams(params);
      next.delete("inbox");
      setParams(next, { replace: true });
    }
    // Best-effort, like every other Settings read: a failure hides this card
    // and leaves the rest of the page working.
    getInboxStatus()
      .then((s) => {
        if (!live) return;
        setStatus(s);
        if (BACKFILL_CHOICES.includes(s.backfill_days)) setDays(s.backfill_days);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `#inbox` (the tracker's Connect link) and a return from Google both land on
  // this card. SettingsPage's own `#danger` effect cannot do it: this card
  // exists only once its status has arrived, after that effect has run.
  const loaded = status !== null;
  useEffect(() => {
    if (!loaded || (hash !== "#inbox" && !callback)) return;
    document.getElementById("inbox")?.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [loaded, hash, key, callback]);

  if (!status) return null;
  const inviteOnly = !status.ready && status.reason === "invite_only";
  if (!status.connected && !status.ready && !inviteOnly) return null;

  // `ready` without Google means the server offers only the demo mailbox.
  const demo = status.ready && !status.google_ready;
  const isDemo = status.provider === "fake";
  const reauth = status.connected && status.status === "needs_reauth";
  // An ordinary failed run leaves the connection "active" and says so only in
  // `last_error_code`, which the next good run clears (app/core/inbox_sync.py).
  const failed = status.connected && !reauth && !!status.last_error_code;
  // The reasons that say more than "reconnect": the weekly testing expiry, and
  // a grant that no longer includes Gmail.
  const reauthReason =
    status.last_error_code === "reauth_due" || status.last_error_code === "missing_scope"
      ? errorText(status.last_error_code)
      : "";
  const due = formatDay(status.reauth_due_at, locale);
  const when = ago(status.last_sync_at);

  function callbackMessage(code: string): string {
    switch (code) {
      case "missing_scope":
        return t("inbox.callback.missingScope");
      // The callback's three ways a flow can be stale or not this browser's
      // (app/api/inbox_routes.py), and one remedy for all of them.
      case "state_mismatch":
      case "state_invalid":
      case "state_expired":
        return t("inbox.callback.stateMismatch");
      case "access_denied":
        return t("inbox.callback.accessDenied");
      case "invite_only":
        return t("inbox.inviteOnly");
      case "no_refresh_token":
        return t("inbox.callback.noRefreshToken");
      default:
        return t("inbox.callback.generic");
    }
  }

  async function connect() {
    if (connecting) return;
    setConnecting(true);
    setConnectError("");
    try {
      if (demo) {
        await connectFakeInbox(days);
        // The same landing Google's callback uses, so the demo import runs
        // through exactly the code a real connection does.
        navigate("/tracker?inbox=connected");
        return;
      }
      // A document load: the next page is Google's. `connecting` stays set.
      window.location.assign(await startInboxGoogle(days));
    } catch (e) {
      setConnectError(refusal(e, t("inbox.connectError")));
      setConnecting(false);
    }
  }

  async function reconnect() {
    if (connecting) return;
    setConnecting(true);
    try {
      window.location.assign(await startInboxGoogle());
    } catch (e) {
      toast("error", refusal(e, t("inbox.connectError")));
      setConnecting(false);
    }
  }

  async function setAutoSync(next: boolean) {
    setStatus((s) => (s ? { ...s, auto_sync: next } : s));
    try {
      setStatus(await updateInboxSettings({ auto_sync: next }));
    } catch (e) {
      setStatus((s) => (s ? { ...s, auto_sync: !next } : s));
      toast("error", apiErrorMessage(e, t("inbox.saveError")));
    }
  }

  async function disconnect() {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await disconnectInbox(purge);
      toast("success", t("inbox.disconnected"));
      setArmed(false);
      setPurge(false);
      const fresh = await getInboxStatus().catch(() => null);
      setStatus((s) => fresh ?? (s ? { ...s, connected: false, provider: "", email: "", status: "" } : s));
    } catch (e) {
      toast("error", apiErrorMessage(e, t("inbox.disconnectError")));
    }
    setDisconnecting(false);
  }

  return (
    <Card id="inbox">
      <CardTitle className="flex items-center gap-2">
        <Inbox size={16} className="text-accent-soft" /> {t("inbox.title")}
      </CardTitle>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t("inbox.body")}</p>

      {callback && callback !== "connected" && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm leading-relaxed text-danger"
        >
          {callbackMessage(callback)}
        </p>
      )}

      {!status.connected ? (
        inviteOnly ? (
          <p className="mt-3 text-sm leading-relaxed text-ink">{t("inbox.inviteOnly")}</p>
        ) : (
          <>
            <div className="mt-4 rounded-xl border border-line bg-bg-soft px-3 pt-3">
              <p className="text-sm font-medium text-ink">{t("inbox.readTitle")}</p>
              <ul className="mt-2 space-y-1.5">
                {[t("inbox.read1"), t("inbox.read2"), t("inbox.read3")].map((line) => (
                  <li key={line} className="flex gap-2 text-sm leading-relaxed text-ink-muted">
                    <Check size={14} className="mt-[3px] shrink-0 text-mint" aria-hidden />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              <Link
                to="/privacy"
                className="inline-flex min-h-11 items-center text-sm font-medium text-accent-soft hover:underline"
              >
                {t("inbox.privacyLink")}
              </Link>
            </div>

            <fieldset className="mt-4" disabled={connecting}>
              <legend className="text-sm font-medium text-ink">{t("inbox.lookBack")}</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {BACKFILL_CHOICES.map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={days === d}
                    onClick={() => setDays(d)}
                    className={cn(
                      "inline-flex min-h-11 min-w-[5.5rem] items-center justify-center rounded-full border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-50",
                      days === d
                        ? "border-accent/60 bg-accent/15 text-accent-soft"
                        : "border-line text-ink-muted hover:text-ink",
                    )}
                  >
                    {t("inbox.days", { days: d })}
                  </button>
                ))}
              </div>
            </fieldset>

            {/* O3, before anyone connects: Google ends a testing app's grant
                every 7 days. Shown only when the server says it is in testing,
                because it is a claim about the server. */}
            {demo ? (
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">{t("inbox.demoHint")}</p>
            ) : status.oauth_testing ? (
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">{t("inbox.testing")}</p>
            ) : null}

            <Button
              onClick={() => void connect()}
              loading={connecting}
              icon={<Inbox size={16} />}
              className="mt-4 min-h-11 w-full sm:w-auto"
            >
              {demo ? t("inbox.demo") : t("inbox.connect")}
            </Button>
            <div aria-live="polite">
              {connectError && <p className="mt-2 text-sm leading-relaxed text-danger">{connectError}</p>}
            </div>
          </>
        )
      ) : (
        <>
          <div className="mt-3 space-y-1.5 text-sm">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink">
              {/* A bidi isolate, SettingsPage's account-email reason. */}
              <span className="min-w-0 break-all">
                <span className="text-ink-muted">
                  {isDemo ? t("inbox.providerDemo") : t("inbox.providerGmail")}:{" "}
                </span>
                <bdi>{status.email}</bdi>
              </span>
              <Badge tone={reauth || failed ? "partial" : "mint"}>
                {reauth ? t("inbox.state.needsReauth") : failed ? t("inbox.state.error") : t("inbox.state.active")}
              </Badge>
            </p>
            <p className="text-xs leading-relaxed text-ink-muted">
              {when ? t("inbox.lastSync", { when }) : t("inbox.neverSynced")}
              {" · "}
              {t("inbox.detected", { count: status.events_total })}
            </p>
            {failed && (
              <p className="text-xs leading-relaxed text-warn">{errorText(status.last_error_code)}</p>
            )}
          </div>

          {!isDemo && (reauth || due) && (
            <div
              className={cn(
                "mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border px-3 py-2",
                reauth ? "border-warn/40 bg-warn/10" : "border-line bg-bg-soft",
              )}
            >
              <p className={cn("min-w-[12rem] flex-1 text-xs leading-relaxed", reauth ? "text-warn" : "text-ink-muted")}>
                {reauth ? reauthReason || t("inbox.needsReauth") : t("inbox.reconnectBy", { date: due })}
              </p>
              <Button
                size="sm"
                variant={reauth ? "primary" : "secondary"}
                loading={connecting}
                onClick={() => void reconnect()}
                icon={<RefreshCw size={14} />}
                className="min-h-11"
              >
                {t("inbox.reconnect")}
              </Button>
            </div>
          )}

          <label className="mt-4 flex cursor-pointer items-start gap-3 border-t border-line pt-3">
            <input
              type="checkbox"
              checked={status.auto_sync}
              onChange={(e) => void setAutoSync(e.target.checked)}
              className="mt-3 h-4 w-4 shrink-0 accent-accent"
            />
            <span className="flex min-h-11 flex-col justify-center py-1">
              <span className="text-sm font-medium text-ink">{t("inbox.autoSync")}</span>
              <span className="text-xs leading-relaxed text-ink-muted">{t("inbox.autoSyncHint")}</span>
            </span>
          </label>

          <Link
            to="/privacy"
            className="inline-flex min-h-11 items-center text-sm font-medium text-accent-soft hover:underline"
          >
            {t("inbox.privacyLink")}
          </Link>

          <div className="mt-2 space-y-2 border-t border-line pt-4">
            {!armed ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setArmed(true)}
                icon={<Unplug size={14} />}
                className="min-h-11 hover:border-danger/50 hover:text-danger"
              >
                {t("inbox.disconnect")}
              </Button>
            ) : (
              <div className="animate-fade-up space-y-2">
                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={purge}
                    disabled={disconnecting}
                    onChange={(e) => setPurge(e.target.checked)}
                    className="h-4 w-4 shrink-0 accent-accent"
                  />
                  {t("inbox.purge")}
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    loading={disconnecting}
                    onClick={() => void disconnect()}
                    className="min-h-11"
                  >
                    {t("inbox.disconnectConfirm")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={disconnecting}
                    onClick={() => {
                      setArmed(false);
                      setPurge(false);
                    }}
                    className="min-h-11"
                  >
                    {t("inbox.disconnectCancel")}
                  </Button>
                </div>
              </div>
            )}
            <p className={cn("text-xs leading-relaxed", armed ? "text-danger" : "text-ink-muted")}>
              {t("inbox.disconnectBody")}
            </p>
          </div>
        </>
      )}
    </Card>
  );
}
