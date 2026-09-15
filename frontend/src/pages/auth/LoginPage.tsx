import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { getAuthMe, login } from "../../api/client";
import { Button } from "../../components/ui";
import { useTakeParam } from "../../hooks/useTakeParam";
import { ACCESS_CODE_KEY } from "../../lib/accessCode";
import { apiErrorMessage, googleErrorMessage, loginErrorMessage } from "../../lib/apiError";
import { cn } from "../../lib/cn";
import { withNext } from "../../lib/safeNext";
import GoogleButton from "./GoogleButton";
import {
  AuthCard,
  EmailInput,
  Field,
  FormError,
  PasswordInput,
  authInputCls,
  authLinkCls,
  looksLikeEmail,
  useNext,
} from "./shared";

/**
 * /login.
 *
 * A signed-in, VERIFIED visitor is forwarded to `next` at once. That includes
 * the dev admin when the gate is off locally, which is why this page is only
 * reachable locally with APP_ACCESS_CODE set.
 *
 * A signed-in but UNVERIFIED visitor is NOT forwarded. The form stays, with a
 * line pointing at /verify. Forwarding would make this page unreachable for
 * the one person who most needs it: someone holding a half-finished signup on a
 * shared device who wants to sign in to a different, verified account (the
 * server allows that login).
 *
 * Every success ends in a DOCUMENT LOAD (`location.assign`), for AccessGate's
 * reason: the stores that outlive the router must not survive a change of who
 * is signed in.
 *
 * Continue with Google (Phase 30 F) sits under the form once /auth/me says this
 * server offers it. That answer is stored BEFORE the signed-in branches return,
 * because a signed-out visitor is exactly who the button is for. A sign-in
 * Google refused comes back here as `?google=<code>`: read once, taken out of
 * the address with `next` kept, and shown in the form's error slot. A cancel
 * shows nothing, since the person chose it.
 */
export default function LoginPage() {
  const { t } = useTranslation("auth");
  const next = useNext();
  const { state } = useLocation();
  const google = useTakeParam("google");
  const [email, setEmail] = useState<string>(() => (state as { email?: string } | null)?.email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    let live = true;
    getAuthMe()
      .then((me) => {
        if (!live) return;
        // Before the early return below: the button is for signed-out visitors.
        setGoogleEnabled(me.google_enabled === true);
        if (!me.authenticated) return;
        if (me.verified) window.location.assign(next);
        else setPending(true);
      })
      .catch(() => {
        /* the form still works; the server answers the submit, and Google stays hidden */
      });
    return () => {
      live = false;
    };
  }, [next]);

  // Set after mount, not as the first state: FormError's live region announces
  // a CHANGE, and a message already there when the region mounts is often not
  // read out at all.
  useEffect(() => {
    if (google && google !== "cancelled") setError(googleErrorMessage(google));
  }, [google]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!looksLikeEmail(email)) {
      setError(t("errors.invalidEmail"));
      return;
    }
    if (!password) {
      setError(t("login.missingPassword"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const me = await login({ email: email.trim(), password });
      // Busy stays on: the document is leaving, and a second tap would post a
      // second login into a page that is already unloading.
      window.location.assign(me.verified ? next : withNext("/verify", next));
    } catch (err) {
      setError(loginErrorMessage(err, googleEnabled, t("errors.generic")));
      setBusy(false);
    }
  }

  return (
    <AuthCard title={t("login.title")} sub={t("login.sub")}>
      {pending && (
        <p className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-3 py-1 text-sm leading-relaxed text-ink">
          {t("login.pending")}{" "}
          <Link to={withNext("/verify", next)} className={authLinkCls}>
            {t("login.pendingCta")}
          </Link>
        </p>
      )}

      <form onSubmit={submit} noValidate>
        <div className="space-y-4">
          <Field id="login-email" label={t("fields.email")}>
            <EmailInput id="login-email" value={email} onChange={setEmail} disabled={busy} />
          </Field>
          <Field
            id="login-password"
            label={t("fields.password")}
            trailing={
              <Link to={withNext("/forgot", next)} state={{ email: email.trim() }} className={cn(authLinkCls, "text-sm")}>
                {t("login.forgot")}
              </Link>
            }
          >
            <PasswordInput
              id="login-password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              disabled={busy}
            />
          </Field>
        </div>
        <FormError message={error} />
        <Button type="submit" loading={busy} className="mt-5 min-h-[44px] w-full">
          {t("login.submit")}
        </Button>
      </form>

      {googleEnabled && <GoogleButton next={next} page="login" />}

      <p className="mt-3 flex flex-wrap items-center justify-center gap-x-1.5 text-sm text-ink-muted">
        {t("login.noAccount")}
        <Link to={withNext("/signup", next)} className={authLinkCls}>
          {t("login.createAccount")}
        </Link>
      </p>

      {/* An invite code and a Google account are two different accounts, even on
          the same address, so a friend from the beta is told before tapping. */}
      {googleEnabled && (
        <p className="mb-1 text-center text-xs leading-relaxed text-ink-muted">{t("login.inviteGoogle")}</p>
      )}
      <InviteCode next={next} />
    </AuthCard>
  );
}

/**
 * "Have an invite code?" — the friends beta's way in, kept for every device
 * that already has one, and closed by default because a new visitor has none.
 *
 * The code is CHECKED before this page moves on. Stored blind, a wrong code
 * would send the visitor to the app, get a 401, be forgotten by the client and
 * land back here with no word about what happened. /auth/me says which
 * credential it recognised: "invite_code" means this code worked, and "dev"
 * means the gate is off locally, where any code does. Anything else, including
 * an account cookie answering in the code's place, means the code did not.
 *
 * Its own <form>, after the login form rather than inside it: HTML forbids
 * nested forms, and a nested one would submit the login form with Enter.
 */
function InviteCode({ next }: { next: string }) {
  const { t } = useTranslation("auth");
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = code.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    localStorage.setItem(ACCESS_CODE_KEY, value);
    try {
      const me = await getAuthMe();
      if (me.method === "invite_code" || me.method === "dev") {
        window.location.assign(next);
        return;
      }
      setError(t("login.inviteInvalid"));
    } catch (err) {
      setError(apiErrorMessage(err, t("errors.generic")));
    }
    localStorage.removeItem(ACCESS_CODE_KEY);
    setBusy(false);
  }

  return (
    <div className="mt-2 border-t border-line pt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? "login-invite" : undefined}
        className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg text-sm font-medium text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <KeyRound size={15} aria-hidden />
        {t("login.inviteToggle")}
      </button>
      {/* Rendered conditionally with an opacity/transform entrance — never a
          height tween, for the reason check-mirrors 11 exists. */}
      {open && (
        <form id="login-invite" onSubmit={submit} noValidate className="animate-fade-up pt-2">
          <Field id="login-invite-code" label={t("login.inviteLabel")}>
            <input
              id="login-invite-code"
              type="password"
              dir="ltr"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={busy}
              className={authInputCls}
            />
          </Field>
          <FormError message={error} />
          <Button
            type="submit"
            variant="secondary"
            loading={busy}
            className="mt-4 min-h-[44px] w-full"
          >
            {t("login.inviteSubmit")}
          </Button>
        </form>
      )}
    </div>
  );
}
