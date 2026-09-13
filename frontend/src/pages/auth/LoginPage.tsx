import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { getAuthMe, login } from "../../api/client";
import { Button } from "../../components/ui";
import { ACCESS_CODE_KEY } from "../../lib/accessCode";
import { apiErrorMessage } from "../../lib/apiError";
import { cn } from "../../lib/cn";
import { withNext } from "../../lib/safeNext";
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
 */
export default function LoginPage() {
  const { t } = useTranslation("auth");
  const next = useNext();
  const { state } = useLocation();
  const [email, setEmail] = useState<string>(() => (state as { email?: string } | null)?.email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    getAuthMe()
      .then((me) => {
        if (!live || !me.authenticated) return;
        if (me.verified) window.location.assign(next);
        else setPending(true);
      })
      .catch(() => {
        /* the form still works; the server answers the submit */
      });
    return () => {
      live = false;
    };
  }, [next]);

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
      setError(apiErrorMessage(err, t("errors.generic")));
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
              <Link to="/forgot" state={{ email: email.trim() }} className={cn(authLinkCls, "text-sm")}>
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

      <p className="mt-3 flex flex-wrap items-center justify-center gap-x-1.5 text-sm text-ink-muted">
        {t("login.noAccount")}
        <Link to={withNext("/signup", next)} className={authLinkCls}>
          {t("login.createAccount")}
        </Link>
      </p>

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
