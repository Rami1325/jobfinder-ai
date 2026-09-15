import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2, MailCheck } from "lucide-react";
import { changeEmail, getAuthMe, resendVerification, verifyEmail } from "../../api/client";
import { Button } from "../../components/ui";
import { apiErrorCode, apiErrorMessage, isSessionEnded, retryAfterSeconds } from "../../lib/apiError";
import { cn } from "../../lib/cn";
import { withNext } from "../../lib/safeNext";
import { signOut } from "../../lib/session";
import { consumeStoredLink, rememberVerifyLink } from "../../lib/verifyLink";
import type { AuthMe } from "../../types";
import {
  AuthCard,
  EmailInput,
  Field,
  FormError,
  FormNotice,
  authInputCls,
  authLinkCls,
  looksLikeEmail,
  primaryLinkCls,
  useNext,
} from "./shared";

const CODE_LENGTH = 6;
/** How often the code page asks whether the address was verified elsewhere. */
const POLL_MS = 5000;
/** The server's resend cooldown, used when a response does not state its own. */
const RESEND_COOLDOWN_S = 60;

/** 75 -> "1:15". Digits and a colon read the same in both languages, so the
 * countdown needs no plural forms. */
function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * /verify: the email link (`?token=`) or the 6-digit code.
 *
 * Both confirm the address only from a signed-in session of that account
 * (FIXB B1: otherwise a squatter who signs up with someone else's address has
 * that person's tap confirm the squatter's account). The code covers the
 * device the person signed up on. The link covers any device once they log in
 * there: opened without that session, its token is kept for the tab
 * (lib/verifyLink.ts), and the code page spends it right after the log in.
 */
export default function VerifyPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  return token ? <ConfirmLink token={token} /> : <EnterCode />;
}

/**
 * The email link.
 *
 * ONE BUTTON, and the page never presses it by itself. Mail security scanners
 * fetch every link in an incoming message before the person does, so a link
 * that verified on load would be spent by a robot and its owner would meet
 * "already used". A scanner fetches; it does not tap a button that POSTs.
 *
 * `signed_in` only says whether THIS browser already held the session that has
 * just become verified. It picks between "Continue" and "log in". The link
 * itself never signs anyone in.
 *
 * Without a session of the link's account the server answers session_required.
 * The token is then kept for this tab, and /auth/me is asked who this browser
 * is BEFORE a card renders, because the two answers point different ways.
 * Signed out: log in here, or enter the code where you signed up. Signed in,
 * which can only be another account (a session of this one would have
 * confirmed): /login forwards a signed-in visitor straight past its form, so
 * the card offers "Log out and continue" through the shared sign-out, or
 * staying. Nothing here navigates by itself, because only the reader knows
 * which device and which account they mean. check-mirrors 30 pins all of it.
 */
function ConfirmLink({ token }: { token: string }) {
  const { t } = useTranslation("auth");
  const next = useNext();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ signedIn: boolean } | null>(null);
  // Set once the link could not be confirmed from this browser: who /auth/me
  // says is signed in here, or "unknown" when it could not be asked. That is a
  // direction, not an error, and the gate's own 401 detail is English whatever
  // the page is in.
  const [ended, setEnded] = useState<AuthMe | "unknown" | null>(null);
  const [leaving, setLeaving] = useState(false);

  async function whoIsHere(): Promise<AuthMe | "unknown"> {
    try {
      return await getAuthMe();
    } catch {
      return "unknown";
    }
  }

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await verifyEmail({ token });
      setDone({ signedIn: r.signed_in });
    } catch (err) {
      if (isSessionEnded(err)) {
        // Kept for this tab, so the log in that follows finishes confirming.
        rememberVerifyLink(token);
        setEnded(await whoIsHere());
      } else setError(apiErrorMessage(err, t("errors.generic")));
    }
    setBusy(false);
  }

  async function askAgain() {
    setBusy(true);
    setEnded(await whoIsHere());
    setBusy(false);
  }

  function logOutAndContinue() {
    if (leaving) return;
    setLeaving(true);
    // The shared sign-out ends in the document load to the log in, and it
    // leaves the kept link where it is.
    void signOut(withNext("/login", next));
  }

  if (ended === "unknown") {
    return (
      <AuthCard title={t("verify.linkTitle")}>
        <FormError message={t("verify.loadError")} />
        <Button
          type="button"
          variant="secondary"
          loading={busy}
          onClick={askAgain}
          className="mt-4 min-h-[44px] w-full"
        >
          {t("verify.retry")}
        </Button>
      </AuthCard>
    );
  }

  if (ended?.authenticated) {
    const email = ended.user?.email ?? "";
    return (
      <AuthCard
        title={t("verify.linkTitle")}
        sub={
          email ? (
            <>
              {t("verify.otherAccountAs")} <bdi className="break-all font-medium text-ink">{email}</bdi>
            </>
          ) : (
            t("verify.otherAccountAnon")
          )
        }
      >
        <p className="text-sm leading-relaxed text-ink">{t("verify.otherAccountBody")}</p>
        {/* Said at rest, before the tap: the sign-out forgets a saved invite
            code, and it may be this browser's only way back in. */}
        {ended.method === "invite_code" && (
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t("verify.otherAccountCode")}</p>
        )}
        <Button
          type="button"
          loading={leaving}
          onClick={logOutAndContinue}
          className="mt-4 min-h-[44px] w-full"
        >
          {t("verify.otherAccountLogOut")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={leaving}
          onClick={() => window.location.assign(next)}
          className="mt-2 min-h-[44px] w-full"
        >
          {t("verify.otherAccountStay")}
        </Button>
      </AuthCard>
    );
  }

  if (ended) {
    return (
      <AuthCard title={t("verify.endedTitle")} sub={t("verify.endedLinkBody")}>
        <Link to={withNext("/login", next)} className={primaryLinkCls}>
          {t("verify.endedLogIn")}
        </Link>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard title={t("verify.doneTitle")} sub={t("verify.doneBody")}>
        {done.signedIn ? (
          <Button
            type="button"
            className="min-h-[44px] w-full"
            onClick={() => window.location.assign(next)}
          >
            {t("verify.continue")}
          </Button>
        ) : (
          <Link to={withNext("/login", next)} className={primaryLinkCls}>
            {t("verify.doneLogIn")}
          </Link>
        )}
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("verify.linkTitle")} sub={t("verify.linkBody")}>
      <Button
        type="button"
        loading={busy}
        onClick={confirm}
        icon={<MailCheck size={16} aria-hidden />}
        className="min-h-[44px] w-full"
      >
        {t("verify.linkSubmit")}
      </Button>
      <FormError message={error} />
      {/* A spent or expired link has one way on: a new code, which needs this
          browser's session. /verify without a token asks for it, and sends a
          browser with no session to log in first. */}
      {error && (
        <p className="mt-2 text-center">
          <Link to={withNext("/verify", next)} className={cn(authLinkCls, "text-sm")}>
            {t("verify.resend")}
          </Link>
        </p>
      )}
    </AuthCard>
  );
}

/**
 * The code, entered in the browser that holds the pending session.
 *
 * The page POLLS /auth/me while it is visible and moves on the moment the
 * account reads verified. The link may well be opened on another device, and
 * a page that waited for its own form would sit here while the account was
 * already usable.
 */
function EnterCode() {
  const { t } = useTranslation("auth");
  const next = useNext();
  const { state } = useLocation();
  const [me, setMe] = useState<AuthMe | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // This browser's session is gone (a reset or "sign out other devices"
  // elsewhere, cleared cookies). Resend and Change email cannot work from
  // here, so the page says so in the reader's language and offers log in.
  const [ended, setEnded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // The value last sent. `busy` is state, so two submits in the same tick (an
  // autofilled code and the Enter that follows it) would both read it as false.
  const inFlight = useRef("");

  // Seeded by signup, which has just sent a code. Otherwise the button starts
  // enabled and the server's own cooldown answers a too-early tap.
  const [cooldownUntil, setCooldownUntil] = useState<number>(() => {
    const sentAt = (state as { sentAt?: unknown } | null)?.sentAt;
    return typeof sentAt === "number" ? sentAt + RESEND_COOLDOWN_S * 1000 : 0;
  });
  const [now, setNow] = useState(() => Date.now());
  const remaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= cooldownUntil) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);

  function startCooldown(seconds: number) {
    const at = Date.now();
    setNow(at);
    setCooldownUntil(at + seconds * 1000);
  }

  useEffect(() => {
    let live = true;
    getAuthMe()
      .then(async (m) => {
        if (!live) return;
        if (!m.authenticated) window.location.assign(withNext("/login", next));
        else if (m.verified) window.location.assign(next);
        else {
          // A confirmation link this tab kept before the log in (ConfirmLink)
          // finishes here, with this session. Never through redirected(): a
          // kept link of ANOTHER account answers session_required, and that
          // leaves the person on this form rather than sending them to log in
          // again. Mail scanners cannot reach this: it is a POST made after a
          // person logged in.
          const link = await consumeStoredLink((kept) => verifyEmail({ token: kept }));
          // Not gated on `live`: the token is forgotten once it verified, so a
          // dropped result would leave nothing to move this page on.
          if (link === "verified") window.location.assign(next);
          else if (live) setMe(m);
        }
      })
      .catch(() => {
        if (live) setLoadFailed(true);
      });
    return () => {
      live = false;
    };
  }, [next]);

  const waiting = me !== null;
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    const check = () => {
      // Hidden tabs do not ask: a page nobody is looking at has no one to
      // move on for, and `visibilitychange` asks the moment it is shown again.
      if (document.visibilityState !== "visible") return;
      getAuthMe()
        .then((m) => {
          if (!live) return;
          if (m.authenticated && m.verified) window.location.assign(next);
          // Signed out elsewhere, e.g. a password reset ended this session.
          else if (!m.authenticated) window.location.assign(withNext("/login", next));
        })
        .catch(() => {
          /* a missed poll is retried in five seconds */
        });
    };
    const id = window.setInterval(check, POLL_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      live = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", check);
    };
  }, [waiting, next]);

  /**
   * Two refusals are directions, not errors to show.
   *
   * `already_verified`: the address was confirmed somewhere else in the
   * meantime (the link, on another device), so this does now what the poll
   * would do a few seconds later. `session_required`: this browser no longer
   * holds the signup session, so no code can work here and logging in is the
   * way on. Returns true when it navigated.
   */
  function redirected(err: unknown): boolean {
    const code = apiErrorCode(err);
    if (code === "already_verified") {
      window.location.assign(next);
      return true;
    }
    if (code === "session_required") {
      window.location.assign(withNext("/login", next));
      return true;
    }
    return false;
  }

  async function submitCode(value: string) {
    if (value.length !== CODE_LENGTH || inFlight.current === value) return;
    inFlight.current = value;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await verifyEmail({ code: value });
      if (r.verified) {
        window.location.assign(next);
        return;
      }
      setError(t("errors.wrongCode"));
    } catch (err) {
      if (redirected(err)) return;
      setError(apiErrorMessage(err, t("errors.generic")));
    }
    // A refused code is cleared, so the next attempt starts from an empty box
    // instead of the user deleting six digits first.
    inFlight.current = "";
    setCode("");
    setBusy(false);
    inputRef.current?.focus();
  }

  /** Keeps the digits of whatever arrived, typed, autofilled or pasted as
   * "123 456", and submits at six. */
  function take(raw: string) {
    const digits = raw.replace(/[^0-9]/g, "").slice(0, CODE_LENGTH);
    setCode(digits);
    if (digits.length === CODE_LENGTH) void submitCode(digits);
  }

  /** `maxLength` truncates a paste BEFORE onChange sees it, so "123 456" would
   * arrive as "123 45". The paste is taken here instead, whole. */
  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (!text.replace(/[^0-9]/g, "")) return;
    e.preventDefault();
    take(text);
  }

  async function resend() {
    if (resending || remaining > 0) return;
    setResending(true);
    setError("");
    setNotice("");
    try {
      const r = await resendVerification();
      startCooldown(r.cooldown_s > 0 ? r.cooldown_s : RESEND_COOLDOWN_S);
      setNotice(t("verify.resent"));
    } catch (err) {
      if (isSessionEnded(err)) {
        setEnded(true);
        setResending(false);
        return;
      }
      if (redirected(err)) return;
      const wait = retryAfterSeconds(err);
      if (apiErrorCode(err) === "too_many_attempts" && wait) startCooldown(Math.ceil(wait));
      setError(apiErrorMessage(err, t("errors.generic")));
    }
    setResending(false);
  }

  function onChanged(m: AuthMe) {
    if (m.verified) {
      window.location.assign(next);
      return;
    }
    setMe(m);
    setCode("");
    inFlight.current = "";
    setError("");
    setNotice(t("verify.changed"));
    startCooldown(RESEND_COOLDOWN_S);
  }

  if (loadFailed) {
    return (
      <AuthCard title={t("verify.title")}>
        <FormError message={t("verify.loadError")} />
        <Button
          type="button"
          variant="secondary"
          className="mt-4 min-h-[44px] w-full"
          onClick={() => window.location.reload()}
        >
          {t("verify.retry")}
        </Button>
      </AuthCard>
    );
  }

  if (ended) {
    return (
      <AuthCard title={t("verify.endedTitle")} sub={t("verify.endedBody")}>
        <Link to={withNext("/login", next)} className={primaryLinkCls}>
          {t("verify.endedLogIn")}
        </Link>
      </AuthCard>
    );
  }

  if (!me) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <Loader2 className="h-6 w-6 animate-spin text-ink-muted" aria-hidden />
      </div>
    );
  }

  const email = me.user?.email ?? "";
  const lower = email.toLowerCase();
  const onGmail = lower.endsWith("@gmail.com") || lower.endsWith("@googlemail.com");

  return (
    <AuthCard
      title={t("verify.title")}
      sub={
        <>
          {t("verify.sentTo")} <bdi className="break-all font-medium text-ink">{email}</bdi>
        </>
      }
    >
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void submitCode(code);
        }}
        noValidate
      >
        <Field id="verify-code" label={t("fields.code")}>
          <input
            ref={inputRef}
            id="verify-code"
            type="text"
            dir="ltr"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={CODE_LENGTH}
            autoComplete="one-time-code"
            autoFocus
            value={code}
            onChange={(e) => take(e.target.value)}
            onPaste={onPaste}
            // readOnly, not disabled: a disabled input cannot take focus, so a
            // refused code could not hand the caret straight back.
            readOnly={busy}
            className={cn(authInputCls, "text-center")}
            // Inline: a type="text" input takes `font: inherit` from the
            // global rule, which outranks any size or weight class. On phones
            // styles.css pins every input to 16px anyway, to stop iOS zooming.
            style={{
              fontSize: "1.375rem",
              fontWeight: 600,
              letterSpacing: "0.35em",
              paddingLeft: "calc(10px + 0.35em)",
              fontVariantNumeric: "tabular-nums",
            }}
          />
        </Field>
        <FormError message={error} />
        <FormNotice message={notice} />
        <Button
          type="submit"
          loading={busy}
          disabled={code.length !== CODE_LENGTH}
          className="mt-5 min-h-[44px] w-full"
        >
          {t("verify.submit")}
        </Button>
      </form>

      <div className="mt-2 flex flex-col items-center">
        <Button
          type="button"
          variant="ghost"
          onClick={resend}
          loading={resending}
          disabled={remaining > 0}
          className="min-h-[44px] w-full"
        >
          {remaining > 0 ? (
            <>
              {t("verify.resendIn")} <bdi className="tabular-nums">{clock(remaining)}</bdi>
            </>
          ) : (
            t("verify.resend")
          )}
        </Button>
        {onGmail && (
          <a
            href="https://mail.google.com/mail/u/0/#inbox"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(authLinkCls, "gap-1.5 text-sm")}
          >
            {t("verify.openGmail")}
            <ExternalLink size={14} aria-hidden />
          </a>
        )}
      </div>

      <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-ink-muted">
        {t("verify.autoContinue")}
      </p>

      <div className="mt-1">
        <ChangeEmail
          current={email}
          onChanged={onChanged}
          onRefused={redirected}
          onEnded={() => setEnded(true)}
        />
      </div>
      <p className="text-center">
        <Link to={withNext("/login", next)} className={cn(authLinkCls, "text-sm")}>
          {t("verify.otherAccount")}
        </Link>
      </p>
    </AuthCard>
  );
}

/**
 * "Wrong address? Change it" — for an account that is not verified yet.
 *
 * The server sends a new code to the corrected address, and every code sent to
 * the old one stops working. Otherwise a typo would leave a live code sitting
 * in a stranger's inbox that verifies the account for the new address.
 *
 * `onRefused` is EnterCode's `redirected`, so an address confirmed elsewhere in
 * the meantime continues the same way from here as from the code form.
 */
function ChangeEmail({
  current,
  onChanged,
  onRefused,
  onEnded,
}: {
  current: string;
  onChanged: (me: AuthMe) => void;
  onRefused: (err: unknown) => boolean;
  /** The session is gone: EnterCode replaces the page with "log in again". */
  onEnded: () => void;
}) {
  const { t } = useTranslation("auth");
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const value = email.trim();
    if (!looksLikeEmail(value)) {
      setError(t("errors.invalidEmail"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const me = await changeEmail(value);
      setOpen(false);
      onChanged(me);
    } catch (err) {
      if (isSessionEnded(err)) {
        onEnded();
        return;
      }
      if (onRefused(err)) return;
      setError(apiErrorMessage(err, t("errors.generic")));
    }
    setBusy(false);
  }

  if (!open) {
    return (
      <p className="flex flex-wrap items-center justify-center gap-x-1.5 text-sm text-ink-muted">
        {t("verify.wrongAddress")}
        <button
          type="button"
          onClick={() => {
            setEmail(current);
            setError("");
            setOpen(true);
          }}
          className={authLinkCls}
        >
          {t("verify.changeIt")}
        </button>
      </p>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="animate-fade-up py-2">
      <Field id="verify-new-email" label={t("verify.changeLabel")}>
        <EmailInput id="verify-new-email" value={email} onChange={setEmail} disabled={busy} autoFocus />
      </Field>
      <FormError message={error} />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit" loading={busy} className="min-h-[44px] flex-1">
          {t("verify.changeSubmit")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => setOpen(false)}
          className="min-h-[44px]"
        >
          {t("verify.cancel")}
        </Button>
      </div>
    </form>
  );
}
