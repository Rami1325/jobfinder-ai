import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BadgeCheck,
  BellRing,
  Copy,
  Eye,
  EyeOff,
  FileLock,
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
  getAuthMe,
  getExtensionKey,
  getResumePrefs,
  logoutOtherDevices,
  rotateExtensionKey,
  updateResumePrefs,
} from "../api/client";
import { signOut } from "../layouts/AppLayout";
import { ACCESS_CODE_KEY } from "../lib/accessCode";
import { apiErrorMessage } from "../lib/apiError";
import { clearKeyRotated, keyRotatedNotice, markKeyRotated, readKeyRotation } from "../lib/authResults";
import LanguageSwitch from "../components/LanguageSwitch";
import ThemeToggle from "../components/ThemeToggle";
import InboxSettingsCard from "../components/inbox/InboxSettingsCard";
import { Badge, Button, Card, CardTitle, useToast } from "../components/ui";
import { FormError, PasswordInput, charCount } from "./auth/shared";
import type { AuthMe } from "../types";

/** The hint beside an account action (Sign out, Change password, Sign out
 * other devices). `min-w-[12rem]`, not `min-w-0`. With `min-w-0` the hint could
 * shrink without limit, so it never pushed a long button onto its own row, and
 * at 390px "Sign out other devices" squeezed its hint into a four-line column
 * of one or two words per line. With a floor the row wraps and the button drops
 * underneath instead; on wider screens both still sit side by side. */
const ACTION_HINT = "min-w-[12rem] flex-1 text-xs leading-relaxed text-ink-muted";

/** One labelled setting: name + hint on the start side, control on the end.
 * `flex-wrap`, not a two-column grid — at 390px the Hebrew hints run to two
 * lines and a fixed grid crushes the control to nothing rather than letting it
 * drop to its own row. */
function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
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
        <Button size="sm" variant="danger" disabled icon={<Trash2 size={14} />}>
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
          className="hover:border-danger/50 hover:text-danger"
        >
          {cta}
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="danger" onClick={go} loading={running}>
            {confirmLabel}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setConfirming(false)}
            disabled={running}
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
            <Button type="submit" size="sm" loading={busy}>
              {t("account.password.save")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={close} disabled={busy}>
              {tCommon("actions.cancel")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** One button: every other session on this account ends, this one stays. No
 * confirm step, because nothing is lost. The other devices just sign in again. */
function OtherDevices({ method, onKeyRotated }: { method: AuthMe["method"]; onKeyRotated: () => void }) {
  const { t } = useTranslation("settings");
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function go() {
    if (busy) return;
    setBusy(true);
    try {
      const rotation = readKeyRotation(await logoutOtherDevices());
      if (rotation.rotated) {
        // PasswordChange's reason: an invite-code device stores the new key.
        if (method === "invite_code" && rotation.key) localStorage.setItem(ACCESS_CODE_KEY, rotation.key);
        onKeyRotated();
      }
      toast("success", rotation.rotated ? t("account.others.doneKey") : t("account.others.done"));
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
      >
        {t("account.others.cta")}
      </Button>
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
        >
          {shown ? t("extension.hide") : t("extension.reveal")}
        </Button>
        <Button size="sm" variant="secondary" onClick={copy} icon={<Copy size={14} />}>
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
              >
                {t("extension.rotate")}
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="danger" onClick={replace} loading={replacing}>
                  {t("extension.rotateConfirm")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setArming(false)}
                  disabled={replacing}
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

  /** Honour `#danger`, because nothing else does.
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
    if (hash !== "#danger") return;
    const el = document.getElementById("danger");
    if (!el) return;
    el.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [hash, key]);

  // Best-effort: the identity lines and the account controls are niceties, so
  // a failure hides them and leaves every other section — including Sign out —
  // fully usable. Nothing on this page waits on it.
  useEffect(() => {
    let live = true;
    getAuthMe()
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
  const methodLine =
    method === "session"
      ? t("account.methodSession")
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
      // device's account-scoped state (the resume draft, the onboarding
      // answers, both caches) and ends in a document load to the landing, so
      // a closed account leaves nothing behind for the next person to sign in.
      setTimeout(() => void signOut(), 800);
      return true;
    } catch {
      toast("error", t("danger.closeError"));
      return false;
    }
  }

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
          <Row label={t("appearance.theme")} hint={t("appearance.themeHint")}>
            <ThemeToggle />
          </Row>
          <Row label={t("appearance.language")} hint={t("appearance.languageHint")}>
            <LanguageSwitch />
          </Row>
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
            onClick={() => void signOut()}
            // The door glyph points out to the right; in RTL "out" is the other
            // way, so it mirrors with the reading direction.
            icon={<LogOut size={14} className="rtl:-scale-x-100" />}
          >
            {t("account.signOut")}
          </Button>
        </div>
      </Card>

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

      <Card>
        <CardTitle className="flex items-center gap-2">
          <BellRing size={16} className="text-accent-soft" /> {t("alerts.title")}
        </CardTitle>
        {/* A pointer, not a second copy of AlertsCard. Alerts are configured
            against the search that produces them, and two places to set one
            daily email is one place too many. */}
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t("alerts.body")}</p>
        <Link
          to="/jobs"
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent-soft hover:underline"
        >
          {t("alerts.cta")}
        </Link>
      </Card>

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
