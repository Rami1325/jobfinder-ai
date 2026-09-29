import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BadgeCheck,
  Copy,
  Eye,
  EyeOff,
  FileLock,
  Gauge,
  KeyRound,
  LogOut,
  MonitorSmartphone,
  Palette,
  Puzzle,
  RefreshCw,
  ShieldAlert,
  Trash2,
  UserRound,
} from "lucide-react";
import {
  changePassword,
  deleteAccount,
  deleteMyData,
  getExtensionKey,
  getResumePrefs,
  logoutOtherDevices,
  readAuthMe,
  rotateExtensionKey,
  updateResumePrefs,
} from "../api/client";
import { tabAccount } from "../lib/accountWatch";
import { ACCESS_CODE_KEY } from "../lib/accessCode";
import { apiErrorMessage } from "../lib/apiError";
import { clearKeyRotated, keyRotatedNotice, markKeyRotated, readKeyRotation } from "../lib/authResults";
import { clearProposalStash } from "../lib/proposalStash";
import { currentSubscription, pushPermission } from "../lib/push";
import { withNext } from "../lib/safeNext";
import { signOut } from "../lib/session";
import { formatUsesDate } from "../lib/usesStore";
import LanguageSwitch from "../components/LanguageSwitch";
import FunnelCard from "../components/FunnelCard";
import ThemeToggle from "../components/ThemeToggle";
import InboxSettingsCard from "../components/inbox/InboxSettingsCard";
import { useMasterResume } from "../hooks/useMasterResume";
import { AlertsCard } from "./jobs/AlertsCard";
import { Badge, Button, Card, CardTitle, useToast } from "../components/ui";
import { FormError, PasswordInput, charCount } from "./auth/shared";
import type { AuthMe, UsageOut } from "../types";

/** The hint beside an account action (Sign out, Change password, Sign out
 * other devices). `min-w-[12rem]`, not `min-w-0`. With `min-w-0` the hint could
 * shrink without limit, so it never pushed a long button onto its own row, and
 * at 390px "Sign out other devices" squeezed its hint into a four-line column
 * of one or two words per line. With a floor the row wraps and the button drops
 * underneath instead; on wider screens both still sit side by side. */
const ACTION_HINT = "min-w-[12rem] flex-1 text-xs leading-relaxed text-ink-muted";

// Every button on this page is a 44 px BOX, `min-h-11` (the second tap-target
// pass, 2026-09-29; `size="sm"` drew them 34 px, the extension key's Show and
// Copy among them). A box, not a layer: pairs wrap on a phone 8 px apart, and
// Show and Copy sit 8 px under the key's own text, so a layer would lie over
// its neighbour, and this page has no rows-a-screen budget to spend. The theme
// and language switches in Appearance are the exception: they take `tap-44`,
// whose layer stays inside their row's 12 px padding.

/** One labelled setting: name + hint on the start side, control on the end.
 * `flex-wrap`, not a two-column grid — at 390px the Hebrew hints run to two
 * lines and a fixed grid crushes the control to nothing rather than letting it
 * drop to its own row. */
/** Which home-screen hint this device gets (PLAN 31.2/11), or null inside the
 * installed app itself, where it would be advice to do what was already done.
 * iPadOS reports itself as a Mac, so a touch Mac counts as iOS. */
function installTarget(): "ios" | "other" | null {
  if (typeof window === "undefined") return null;
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standalone) return null;
  const ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios ? "ios" : "other";
}

function Row({ label, hint, children }: { label: string; hint: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{hint}</p>
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}

/** A destructive action behind a two-step confirm — the shape the privacy wipe
 * already had in the feedback dialog, kept because it works: the first tap only
 * reveals what is about to happen, so nothing irreversible is one tap away.
 *
 * `confirming` is state on THIS component, so the two Danger-zone actions each
 * arm independently. A shared flag would let a user who opened "Delete all my
 * data" tap "Yes" under the wrong heading. */
function DangerAction({
  cta,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  disabledReason,
}: {
  cta: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  /** True = it worked and this component is on its way off screen; the button
   * must STAY disabled. False = it failed and is pressable again. */
  onConfirm: () => Promise<boolean>;
  disabledReason?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);

  async function go() {
    if (running) return;
    setRunning(true);
    try {
      // Only a FAILURE re-enables. A blanket `finally { setRunning(false) }`
      // reopened the button for the whole 800ms the success path spends
      // waiting to redirect, and a second tap in that window goes out against
      // an account the server has already switched off: a 401, the client's
      // UNAUTHORIZED_EVENT, and a redirect to /login over the top of the
      // success toast.
      if (!(await onConfirm())) setRunning(false);
    } catch {
      setRunning(false);
    }
  }

  if (disabledReason) {
    return (
      <div className="space-y-2">
        <Button size="sm" variant="danger" disabled icon={<Trash2 size={14} />} className="min-h-11">
          {cta}
        </Button>
        <p className="text-xs leading-relaxed text-ink-muted">{disabledReason}</p>
      </div>
    );
  }

  // The description is NOT held back until the confirm step, and that is the
  // whole reason both actions can ship side by side: their labels differ by
  // three words, and what actually separates them -- whether your account
  // survives -- is unreadable from "Delete all my data" vs "Close my account".
  // Held back, the choice can only be made by arming one and reading what it
  // then admits to, which is the wrong order for an irreversible action. It
  // stays muted at rest and turns danger-coloured once armed, so arming still
  // changes something visible. Button first, prose under it -- the same shape
  // `disabledReason` above already uses, so the card reads one way throughout.
  return (
    <div className="space-y-2">
      {!confirming ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirming(true)}
          icon={<Trash2 size={14} />}
          className="min-h-11 hover:border-danger/50 hover:text-danger"
        >
          {cta}
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="danger" onClick={go} loading={running} className="min-h-11">
            {confirmLabel}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setConfirming(false)}
            disabled={running}
            className="min-h-11"
          >
            {cancelLabel}
          </Button>
        </div>
      )}
      <p className={`text-xs leading-relaxed ${confirming ? "text-danger" : "text-ink-muted"}`}>
        {body}
      </p>
    </div>
  );
}

/**
 * Change password, inline in the account card.
 *
 * Opens IN PLACE with an opacity/transform entrance. Never a height tween
 * (check-mirrors 11), and never a modal: a two-field form does not earn an
 * overlay on a phone.
 *
 * The hidden username field is for password managers. Without it, a manager
 * saving the new password cannot tell which account it belongs to and files it
 * under the site with no username.
 */
function PasswordChange({
  email,
  method,
  onKeyRotated,
}: {
  email: string;
  method: AuthMe["method"];
  onKeyRotated: () => void;
}) {
  const { t } = useTranslation("settings");
  const { t: ta } = useTranslation("auth");
  const { t: tCommon } = useTranslation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [fresh, setFresh] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function close() {
    setOpen(false);
    setCurrent("");
    setFresh("");
    setError("");
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (charCount(fresh) < 8) {
      setError(ta("errors.weakPassword.tooShort"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const rotation = readKeyRotation(await changePassword({ current_password: current, new_password: fresh }));
      if (rotation.rotated) {
        // An invite-code device signs in WITH that key: a returned key is
        // stored at once, or its next request 401s on the key just replaced.
        if (method === "invite_code" && rotation.key) localStorage.setItem(ACCESS_CODE_KEY, rotation.key);
        onKeyRotated();
      }
      toast("success", rotation.rotated ? t("account.password.doneKey") : t("account.password.done"));
      close();
    } catch (err) {
      setError(apiErrorMessage(err, ta("errors.generic")));
    }
    setBusy(false);
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      {!open ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className={ACTION_HINT}>
            {t("account.password.hint")}
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setOpen(true)}
            icon={<KeyRound size={14} />}
            className="min-h-11"
          >
            {t("account.password.cta")}
          </Button>
        </div>
      ) : (
        <form onSubmit={save} noValidate className="animate-fade-up space-y-3">
          <input
            type="email"
            autoComplete="username"
            value={email}
            readOnly
            tabIndex={-1}
            aria-hidden
            className="hidden"
          />
          <div>
            <label htmlFor="settings-current-password" className="mb-1.5 block text-sm font-medium text-ink">
              {ta("fields.currentPassword")}
            </label>
            <PasswordInput
              id="settings-current-password"
              value={current}
              onChange={setCurrent}
              autoComplete="current-password"
              disabled={busy}
            />
          </div>
          <div>
            <label htmlFor="settings-new-password" className="mb-1.5 block text-sm font-medium text-ink">
              {ta("fields.newPassword")}
            </label>
            <PasswordInput
              id="settings-new-password"
              value={fresh}
              onChange={setFresh}
              autoComplete="new-password"
              disabled={busy}
            />
            <p className="mt-1.5 text-xs text-ink-muted">{ta("fields.passwordHint")}</p>
          </div>
          <FormError message={error} />
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="submit" size="sm" loading={busy} className="min-h-11">
              {t("account.password.save")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={close} disabled={busy} className="min-h-11">
              {tCommon("actions.cancel")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** One button: every other session on this account ends, this one stays. No
 * confirm step, because nothing is lost. The other devices just sign in again.
 *
 * And their notifications stop (the phone polish pass, 2026-09-28): a signed-out
 * phone kept getting the morning's job titles. This browser's own subscription is
 * read (read-only, `currentSubscription`) and named, so the server keeps it; the
 * toast says what stopped, and when this browser could not name its own while
 * notifications are allowed here, that this one may have stopped too. */
function OtherDevices({ method, onKeyRotated }: { method: AuthMe["method"]; onKeyRotated: () => void }) {
  const { t } = useTranslation("settings");
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function go() {
    if (busy) return;
    setBusy(true);
    try {
      const mine = await currentSubscription();
      const result = await logoutOtherDevices(mine?.endpoint ?? "");
      const rotation = readKeyRotation(result);
      if (rotation.rotated) {
        // PasswordChange's reason: an invite-code device stores the new key.
        if (method === "invite_code" && rotation.key) localStorage.setItem(ACCESS_CODE_KEY, rotation.key);
        onKeyRotated();
      }
      const done = rotation.rotated ? t("account.others.doneKey") : t("account.others.done");
      const stopped = result.push_removed ?? 0;
      const push =
        stopped > 0
          ? !mine && pushPermission() === "granted"
            ? t("account.others.pushStoppedAll")
            : t("account.others.pushStopped")
          : "";
      toast("success", push ? `${done} ${push}` : done);
    } catch {
      toast("error", t("account.others.error"));
    }
    setBusy(false);
  }

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line pt-4">
      <p className={ACTION_HINT}>{t("account.others.hint")}</p>
      <Button
        size="sm"
        variant="secondary"
        loading={busy}
        onClick={go}
        icon={<MonitorSmartphone size={14} />}
        className="min-h-11"
      >
        {t("account.others.cta")}
      </Button>
    </div>
  );
}

/**
 * "Add a password", for an account that signs in with Google only (Phase 30 F4).
 *
 * Not PasswordChange: there is no current password to confirm, and the server
 * refuses a change on such an account (`password_not_set`). A password is added
 * through Forgot password instead, which proves the mailbox — that is what keeps
 * a stolen Google session from becoming a lasting password. The address is
 * filled in, and the reset lands back on this page.
 *
 * What saving it does is stated BEFORE the tap, the danger zone's rule: a reset
 * signs out every other device and replaces the extension key.
 */
function AddPassword({ email }: { email: string }) {
  const { t } = useTranslation("settings");
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line pt-4">
      <p className={ACTION_HINT}>{t("account.addPassword.hint")}</p>
      <Link
        to={withNext("/forgot", "/settings")}
        state={{ email }}
        className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:border-accent/60 hover:bg-panel-2/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <KeyRound size={14} aria-hidden />
        {t("account.addPassword.cta")}
      </Link>
    </div>
  );
}

/**
 * The key the Chrome extension signs in with.
 *
 * MASKED until asked for, and fetched only then. It is a credential: a key on
 * screen by default is a key in every screenshot of this page.
 *
 * Replacing it states its cost AT REST, the danger zone's rule, because the
 * cost is invisible at the moment of the tap: the extension, and for an
 * invite-code account every other device using that code, stops working until
 * the new key is pasted in. For an invite-code account the key IS the code this
 * device signs in with, so a successful replace also stores the new code here.
 * Otherwise this device's next request would 401 on the code it just replaced.
 *
 * The admin cannot replace it here. Its key is APP_ACCESS_CODE, which the
 * server rewrites on every cold start, so a replace would be undone
 * unannounced. The note says where it is changed instead.
 */
function ExtensionKeyCard({
  method,
  isAdmin,
  notice,
  onSeen,
}: {
  method: AuthMe["method"];
  isAdmin: boolean;
  /** The key was replaced by a password change, a reset or "sign out other
   * devices". Shown until the user reveals or copies the new key. */
  notice: boolean;
  onSeen: () => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation();
  const toast = useToast();
  const [key, setKey] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [arming, setArming] = useState(false);
  const [replacing, setReplacing] = useState(false);

  // A key loaded before the rotation is the old one: forget it, so Show and
  // Copy fetch the key that works now.
  useEffect(() => {
    if (!notice) return;
    setKey(null);
    setShown(false);
  }, [notice]);

  async function load(): Promise<string | null> {
    if (key) return key;
    setLoading(true);
    setError("");
    try {
      const k = await getExtensionKey();
      setKey(k);
      return k;
    } catch (err) {
      setError(apiErrorMessage(err, t("extension.loadError")));
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    if (shown) {
      setShown(false);
      return;
    }
    if (await load()) {
      setShown(true);
      if (notice) onSeen();
    }
  }

  async function copy() {
    const k = await load();
    if (!k) return;
    try {
      await navigator.clipboard.writeText(k);
      toast("success", tCommon("actions.copied"));
      if (notice) onSeen();
    } catch {
      toast("error", t("extension.copyError"));
    }
  }

  async function replace() {
    if (replacing) return;
    setReplacing(true);
    setError("");
    try {
      const k = await rotateExtensionKey();
      if (method === "invite_code") localStorage.setItem(ACCESS_CODE_KEY, k);
      setKey(k);
      setShown(true);
      setArming(false);
      toast("success", t("extension.rotated"));
    } catch (err) {
      setError(apiErrorMessage(err, t("extension.rotateError")));
    }
    setReplacing(false);
  }

  return (
    <Card>
      <CardTitle className="flex items-center gap-2">
        <Puzzle size={16} className="text-accent-soft" /> {t("extension.title")}
      </CardTitle>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t("extension.body")}</p>
      {notice && (
        <p
          role="status"
          className="mt-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm leading-relaxed text-warn"
        >
          {t("extension.rotatedNotice")}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code
          dir="ltr"
          className="min-w-0 basis-full truncate rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono text-sm text-ink sm:flex-1 sm:basis-0"
        >
          {shown && key ? key : "••••••••••••"}
        </code>
        <Button
          size="sm"
          variant="secondary"
          onClick={toggle}
          loading={loading && !shown}
          icon={shown ? <EyeOff size={14} /> : <Eye size={14} />}
          className="min-h-11"
        >
          {shown ? t("extension.hide") : t("extension.reveal")}
        </Button>
        <Button size="sm" variant="secondary" onClick={copy} icon={<Copy size={14} />} className="min-h-11">
          {tCommon("actions.copy")}
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-4 border-t border-line pt-4">
        {isAdmin ? (
          <p className="text-xs leading-relaxed text-ink-muted">{t("extension.adminNote")}</p>
        ) : (
          <div className="space-y-2">
            {!arming ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setArming(true)}
                icon={<RefreshCw size={14} />}
                className="min-h-11"
              >
                {t("extension.rotate")}
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="danger" onClick={replace} loading={replacing} className="min-h-11">
                  {t("extension.rotateConfirm")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setArming(false)}
                  disabled={replacing}
                  className="min-h-11"
                >
                  {t("extension.rotateCancel")}
                </Button>
              </div>
            )}
            <p className={`text-xs leading-relaxed ${arming ? "text-danger" : "text-ink-muted"}`}>
              {method === "invite_code" ? t("extension.rotateBodyCode") : t("extension.rotateBody")}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * What a TAILORED resume may leave out. One switch today.
 *
 * The switch shows only what the server has STORED. While the read is
 * pending it is disabled and marked busy, and a failed read replaces it with a
 * sentence rather than a switch drawn "off", because off would be a false
 * statement about a setting the user may have turned on.
 *
 * A tap is optimistic: the switch moves at once, then settles on whatever the
 * PUT says was stored. On failure it goes back and a toast says so. A second
 * tap while a save is in flight is ignored, so two saves can never land out of
 * order and leave the switch showing the one the server did not keep.
 *
 * `role="switch"` on a real <button>: Space and Enter work with no key
 * handler. The hit target is 44px (`min-h-11 min-w-11`) around a smaller
 * drawn track. The knob slides with the reading direction: it starts at the
 * inline start and moves toward the inline end in both English and Hebrew.
 */
function ResumePrivacyCard() {
  const { t } = useTranslation("settings");
  const toast = useToast();
  const labelId = useId();
  const hintId = useId();
  const [hide, setHide] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    getResumePrefs()
      .then((p) => {
        if (live) setHide(p.hide_arabic_in_israel);
      })
      .catch(() => {
        if (live) setLoadFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  async function flip() {
    if (hide === null || saving) return;
    const next = !hide;
    setHide(next);
    setSaving(true);
    try {
      const stored = await updateResumePrefs({ hide_arabic_in_israel: next });
      setHide(stored.hide_arabic_in_israel);
    } catch (err) {
      setHide(!next);
      toast("error", apiErrorMessage(err, t("resumePrivacy.saveError")));
    }
    setSaving(false);
  }

  const on = hide === true;

  return (
    <Card>
      <CardTitle className="flex items-center gap-2">
        <FileLock size={16} className="text-accent-soft" /> {t("resumePrivacy.title")}
      </CardTitle>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
        <div className="min-w-0 flex-1">
          <p id={labelId} className="text-sm font-medium text-ink">
            {t("resumePrivacy.arabic")}
          </p>
          <p id={hintId} className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            {t("resumePrivacy.arabicHint")}
          </p>
        </div>
        {loadFailed ? (
          <p role="alert" className="basis-full text-xs leading-relaxed text-danger">
            {t("resumePrivacy.loadError")}
          </p>
        ) : (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-labelledby={labelId}
            aria-describedby={hintId}
            aria-busy={hide === null || saving}
            disabled={hide === null}
            onClick={() => void flip()}
            className="group inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg disabled:cursor-wait disabled:opacity-50"
          >
            <span
              aria-hidden
              className={`relative inline-block h-6 w-11 rounded-full border transition-colors group-focus-visible:ring-2 group-focus-visible:ring-accent/60 ${
                on ? "border-accent bg-accent" : "border-line bg-bg-soft"
              }`}
            >
              <span
                className={`absolute start-0.5 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow transition-transform ${
                  on ? "translate-x-5 rtl:-translate-x-5" : "translate-x-0"
                }`}
              />
            </span>
          </button>
        )}
      </div>
    </Card>
  );
}

/** This month's uses on the free plan (Phase 30 / C6): the allowance, what was
 * used on what, when it resets, and what never counts.
 *
 * Only for a plan with a monthly limit. The admin and plan "unlimited" have no
 * limit to show, and a card calling them "Free plan" would be false. It reads the
 * /auth/me answer this page already fetched, because the per-feature breakdown
 * lives only there. Its `uses.*` keys are literal calls through `tCommon`, the
 * name this file already binds to common.json, for check-mirrors 32(d).
 *
 * The breakdown appends each count to its feature's own label with a space, so
 * a LABEL THAT IS A CLAUSE swallows the number it is given: "Screening answers,
 * extension autofill included 3" read as a sentence about the extension rather
 * than as this month's three. The label is the short name now and the extension
 * belongs to its own line, shown only when screening is in the breakdown --
 * check-mirrors 32(b) refuses a feature name carrying a comma. */
function PlanCard({ usage }: { usage: UsageOut }) {
  const { t: tCommon } = useTranslation();
  const { i18n } = useTranslation();
  const spent = Object.entries(usage.by_feature ?? {})
    .filter(([, n]) => typeof n === "number" && n > 0)
    .sort((a, b) => b[1] - a[1]);
  const used = spent.map(
    ([feature, n]) =>
      `${tCommon(`uses.features.${feature}`, { defaultValue: tCommon("uses.plan.other") })} ${n}`,
  );
  const resets = formatUsesDate(usage.resets_on, i18n.language);
  return (
    <Card>
      <CardTitle className="flex items-center gap-2">
        <Gauge size={16} className="text-accent-soft" /> {tCommon("uses.plan.title")}
      </CardTitle>
      <div className="mt-3 space-y-1 text-sm">
        <p className="text-ink">{tCommon("uses.plan.free", { count: usage.limit ?? 0 })}</p>
        <p className="text-ink-muted">{used.length ? used.join(" · ") : tCommon("uses.plan.none")}</p>
        {spent.some(([feature]) => feature === "screening") && (
          <p className="text-xs text-ink-faint">{tCommon("uses.plan.screeningNote")}</p>
        )}
        {resets && <p className="text-ink-muted">{tCommon("uses.plan.resets", { date: resets })}</p>}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-muted">{tCommon("uses.plan.alwaysFree")}</p>
    </Card>
  );
}

/** The account surface: appearance, who you are, the extension key, and the
 * two ways out.
 *
 * An account now signs in one of two ways, and the page says which. With an
 * email sign-in ("session") it can change its password and sign out its other
 * devices. With an invite code (the friends beta, and every device still using
 * one) there is no password to change and no session list to end, so neither
 * control appears.
 *
 * The two destructive actions stay genuinely different things. "Delete all my
 * data" empties the account and leaves it signed in, and "Close my account"
 * also switches it off everywhere. Both ship, clearly separated, because a
 * tester wanting a clean slate and someone leaving for good are not the same
 * person. */
export default function SettingsPage() {
  const { t } = useTranslation("settings");
  // The wipe copy is reused VERBATIM from common.json rather than restated
  // here: it is the sentence that promises the account keeps working, and two
  // translations of one promise is how they drift apart.
  const { t: tCommon } = useTranslation();
  const toast = useToast();
  const [auth, setAuth] = useState<AuthMe | null>(null);
  const { hash, key } = useLocation();
  // The alert's own customize panel derives from the master resume (PLAN 31.5/3).
  const { master } = useMasterResume();
  // "Your extension key was replaced", kept on this device until the new key
  // has been looked at: a reset sets it on a page where Settings is not shown.
  const [keyRotated, setKeyRotated] = useState(keyRotatedNotice);
  const onKeyRotated = () => {
    markKeyRotated();
    setKeyRotated(true);
  };
  const onKeySeen = () => {
    clearKeyRotated();
    setKeyRotated(false);
  };

  /** Honour `#danger` and `#alerts`, because nothing else does. `#alerts` is
   * the Jobs page's way to the alert form (PLAN 31.5/3).
   *
   * `main.tsx` mounts a plain `<BrowserRouter>`: react-router never acts on a
   * hash, and `history.pushState` does not trigger the browser's own fragment
   * navigation either — so the account menu's "Close my account" landed at the
   * TOP of this page with the danger zone four cards below the fold at 390px.
   * `ScrollToTop` had already run by then (it fires on `pathname`, and this
   * effect runs after it: a child's effect completes before its ancestors').
   *
   * Keyed on `key` as well as `hash`. Arriving from /settings itself changes
   * only the hash, so the SECOND tap of the same item would move nothing —
   * react-router mints a fresh location key even when it replaces an identical
   * path, and that is what re-fires this.
   *
   * `scroll-padding-top: 5rem` in styles.css clears the sticky header. The
   * card, not a button, is the target: `getAuthMe` can add identity lines and
   * the account controls above it a moment later, and a whole card absorbs
   * that shift where a 32px control would be pushed out from under the scroll.
   */
  useEffect(() => {
    if (hash !== "#danger" && hash !== "#alerts") return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
    // THE CARDS ABOVE LOAD AFTER THIS RUNS (the account lines, the extension
    // key, Gmail), and each one pushed the target back down: measured at 390 px,
    // `#alerts` ended 619-658 px down the screen instead of at its top. So while
    // the page settles, the target is put back whenever the page grows, until
    // the reader scrolls themself or three seconds pass.
    let reading = false;
    const stop = () => {
      reading = true;
    };
    const events = ["wheel", "touchmove", "keydown"] as const;
    for (const e of events) window.addEventListener(e, stop, { passive: true });
    const settle = new ResizeObserver(() => {
      if (!reading) el.scrollIntoView({ block: "start" });
    });
    settle.observe(document.body);
    const done = window.setTimeout(() => settle.disconnect(), 3000);
    return () => {
      settle.disconnect();
      window.clearTimeout(done);
      for (const e of events) window.removeEventListener(e, stop);
    };
  }, [hash, key]);

  // Best-effort: the identity lines and the account controls are niceties, so
  // a failure hides them and leaves every other section — including Sign out —
  // fully usable. Nothing on this page waits on it.
  //
  // readAuthMe, never getAuthMe: this page mounts on every in-app visit, and
  // getAuthMe re-stamps the resume draft's owner from whatever the answer says,
  // so an expired session or another account signed in from another tab would
  // claim this tab's unsaved edits. readAuthMe writes the uses count only for
  // this tab's own account and never touches the draft.
  useEffect(() => {
    let live = true;
    readAuthMe(tabAccount())
      .then((a) => {
        if (live) setAuth(a);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const user = auth?.user ?? null;
  const method = auth?.method ?? null;
  // An email sign-in is exactly a session-authenticated request: invite-code
  // accounts have no login, and "dev" is the gate being off locally.
  const hasEmailLogin = method === "session";
  // A Google-only account (Phase 30 F4) has a login row, so it is a session like
  // any email account, and no password: it says so on its own line, and gets
  // "Add a password" where an email account gets "Change password".
  const googleOnly = hasEmailLogin && !!user?.google_linked && !user.has_password;
  const methodLine =
    method === "session"
      ? googleOnly
        ? t("account.methodGoogle")
        : t("account.methodSession")
      : method === "invite_code"
        ? t("account.methodCode")
        : method === "dev"
          ? t("account.methodDev")
          : "";

  // `signOut` is IMPORTED, not re-implemented: "forget this user" is precisely
  // the list that drifts. The day a fifth module-level store is added, only one
  // of two copies would get it, and the other would repaint the marketing page
  // with the previous user's CV one tab away.

  async function wipe() {
    try {
      await deleteMyData();
      // The proposal tool's page kept in this tab (lib/proposalStash) is data
      // this person asked to delete; the other tabs' copies die with them.
      clearProposalStash();
      toast("success", tCommon("privacy.wiped"));
      // Same reasoning as signOut: reload rather than navigate, so nothing keeps
      // painting rows the server no longer has. Jobs, because the account still
      // works and that is where a cleared account starts again.
      setTimeout(() => window.location.assign("/jobs"), 800);
      return true;
    } catch {
      toast("error", tCommon("privacy.wipeError"));
      return false;
    }
  }

  async function close() {
    try {
      await deleteAccount();
      // The account is switched off on the server now, so an invite code goes
      // at once. Leaving it would 401 any request in the next 800ms and send
      // the user to /login to retype a code guaranteed never to work again.
      localStorage.removeItem(ACCESS_CODE_KEY);
      toast("success", t("danger.closed"));
      // Then the ONE sign-out, once the toast has been seen. It forgets this
      // device's account-scoped state (the resume draft, an old onboarding
      // role, both caches) and ends in a document load to the landing, so
      // a closed account leaves nothing behind for the next person to sign in.
      setTimeout(() => void signOut("/"), 800);
      return true;
    } catch {
      toast("error", t("danger.closeError"));
      return false;
    }
  }

  const [install] = useState(installTarget);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">{t("title")}</h1>
        <p className="mt-1 text-sm text-ink-muted">{t("sub")}</p>
      </div>

      <Card>
        <CardTitle className="flex items-center gap-2">
          <Palette size={16} className="text-accent-soft" /> {t("appearance.title")}
        </CardTitle>
        {/* Both controls are the SAME components the header mounts, not copies:
            they own the theme/language state, and a second implementation would
            be a second source of truth for it. */}
        <div className="mt-1 divide-y divide-line">
          {/* 44 px targets at their 32 px size (`tap-44`): the layer adds 6 px
              round each, inside the row's 12 px padding. The header mounts the
              same two at their own size, from lg only. */}
          <Row label={t("appearance.theme")} hint={t("appearance.themeHint")}>
            <ThemeToggle className="tap-44" />
          </Row>
          <Row label={t("appearance.language")} hint={t("appearance.languageHint")}>
            <LanguageSwitch className="tap-44" />
          </Row>
          {/* PLAN 31.2/11: installed from here, JobFinder opens on /app (the
              manifest's start_url; it opened on the landing). Phones only, and
              never inside the installed app. The browser's own menu installs;
              nothing on this page can, so it is a line, not a button. */}
          {install && (
            <div className="lg:hidden">
              <Row
                label={t("appearance.install")}
                hint={install === "ios" ? t("appearance.installIos") : t("appearance.installOther")}
              />
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle className="flex items-center gap-2">
          <UserRound size={16} className="text-accent-soft" /> {t("account.title")}
        </CardTitle>
        <div className="mt-3 space-y-1 text-sm">
          {user?.name && (
            <p className="text-ink">
              <span className="text-ink-muted">{t("account.name")}: </span>
              {user.name}
            </p>
          )}
          {user?.email && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink">
              {/* Wrapped in a bidi isolate: an address is Latin text inside a
                  Hebrew line, and without this the RTL paragraph reorders the
                  punctuation around it. */}
              <span className="min-w-0 break-all">
                <span className="text-ink-muted">{t("account.email")}: </span>
                <bdi>{user.email}</bdi>
              </span>
              {hasEmailLogin && auth?.verified && (
                <Badge tone="mint">
                  <BadgeCheck size={12} aria-hidden />
                  {t("account.verified")}
                </Badge>
              )}
            </p>
          )}
        </div>
        {methodLine && <p className="mt-3 text-xs leading-relaxed text-ink-muted">{methodLine}</p>}

        {hasEmailLogin && user?.has_password && (
          <PasswordChange email={user.email} method={method} onKeyRotated={onKeyRotated} />
        )}
        {googleOnly && user && <AddPassword email={user.email} />}
        {hasEmailLogin && <OtherDevices method={method} onKeyRotated={onKeyRotated} />}

        {/* Not a <Row>: the hint IS the label here, and a Row would print
            "Sign out" twice — once as the row name, once on the button. */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line pt-4">
          <p className={ACTION_HINT}>
            {t("account.signOutHint")}
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void signOut("/")}
            // The door glyph points out to the right; in RTL "out" is the other
            // way, so it mirrors with the reading direction.
            icon={<LogOut size={14} className="rtl:-scale-x-100" />}
            className="min-h-11"
          >
            {t("account.signOut")}
          </Button>
        </div>
      </Card>

      {/* Each person's first steps (PLAN 31.8), the admin's only. */}
      {user?.is_admin && <FunnelCard />}

      {/* Hidden for the admin and plan "unlimited" (their limit is null), and
          while /auth/me is unread. */}
      {auth?.usage && auth.usage.limit !== null && <PlanCard usage={auth.usage} />}

      {auth?.verified && user && (
        <ExtensionKeyCard
          method={method}
          isAdmin={user.is_admin}
          notice={keyRotated}
          onSeen={onKeySeen}
        />
      )}

      <ResumePrivacyCard />

      {/* Gmail sync. It reads its own status and renders nothing when the
          server has no Gmail set up, so it needs no gate here. `id="inbox"` is
          the tracker's Connect link target, scrolled to by the card itself. */}
      <InboxSettingsCard />

      {/* The alert form lives HERE since PLAN 31.5/3, and the Jobs page keeps
          only its switch (AlertSwitch), which links to `#alerts`. Before, this
          was a pointer back to Jobs, where the whole form sat under the search
          and pushed the matches down. ONE form, so it is still one place to
          set the daily email. The wrapper always exists, because the card
          renders nothing until the alert has been read and `#alerts` needs a
          target the moment the page mounts. */}
      <div id="alerts">
        <AlertsCard resume={master?.resume ?? null} seedContext={() => null} />
      </div>

      {/* id="danger" is a link target — the account menu jumps straight here,
          via the `#danger` effect above (react-router will not do it, and the
          browser cannot: pushState skips fragment navigation).
          `html { scroll-padding-top: 5rem }` in styles.css already clears the
          mobile sticky header (border + py-3 around a 2rem control), so this
          needs no scroll-mt of its own.
          ORDER IS PART OF THE MEANING: the wipe first, the close second, least
          destructive to most. The menu entry that lands here is named after
          the SECOND button, word for word, so a user who tapped "Close my
          account" cannot mistake the first one for what they asked for. */}
      <Card id="danger" className="border-danger/30">
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert size={16} className="text-danger" /> {t("danger.title")}
        </CardTitle>
        <p className="mt-1 text-xs text-ink-muted">{t("danger.sub")}</p>
        <div className="mt-4 space-y-5">
          <DangerAction
            cta={tCommon("privacy.wipeCta")}
            body={tCommon("privacy.wipeConfirmBody")}
            confirmLabel={tCommon("privacy.wipeConfirm")}
            cancelLabel={tCommon("privacy.wipeCancel")}
            onConfirm={wipe}
          />
          <div className="border-t border-line pt-5">
            <DangerAction
              cta={t("danger.closeCta")}
              body={t("danger.closeBody")}
              confirmLabel={t("danger.closeConfirm")}
              cancelLabel={t("danger.closeCancel")}
              onConfirm={close}
              // The backend refuses an admin close with a 400 (the admin code is
              // the only way back into a deployed instance). Showing the reason
              // up front beats letting the user arm the confirm, tap "Yes", and
              // meet an error toast for a decision that was never theirs to make.
              disabledReason={user?.is_admin ? t("danger.closeAdminBlocked") : undefined}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}
