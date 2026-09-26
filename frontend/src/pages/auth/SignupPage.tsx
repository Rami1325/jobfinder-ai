import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getAuthMe, signup } from "../../api/client";
import { Button } from "../../components/ui";
import { useTakeParam } from "../../hooks/useTakeParam";
import i18n from "../../i18n";
import { apiErrorCode, apiErrorMessage, googleErrorMessage } from "../../lib/apiError";
import { cn } from "../../lib/cn";
import { withNext } from "../../lib/safeNext";
import GoogleButton from "./GoogleButton";
import {
  AuthCard,
  EmailInput,
  Field,
  FormError,
  PasswordInput,
  authLinkCls,
  charCount,
  looksLikeEmail,
  primaryLinkCls,
  useNext,
} from "./shared";

/**
 * /signup.
 *
 * Success goes to /verify with a CLIENT-SIDE navigation, unlike every other
 * auth success. Nothing has been loaded for anyone yet, so there is no store to
 * clear, and the verify page reads `sentAt` from the router state to start its
 * resend countdown. A document load would drop that state.
 *
 * There is no Name field (PLAN 31.5/1): the resume carries the name, and the
 * account takes it from the first master-resume save.
 *
 * The client pre-checks (address shape, 8 characters) only save a round
 * trip for the obvious cases, in the user's language. The server's answer
 * decides, and its codes arrive through the same translation table.
 *
 * Continue with Google (Phase 30 F) comes first, above the form, as on /login,
 * in a slot held from the first paint, and its answer is stored before the
 * forwarding branch. A refusal comes back as `?google=<code>`,
 * read once with `next` kept: "sign-ups are paused" opens this page's own closed
 * card, a cancel shows nothing, and anything else goes in the error slot.
 */
export default function SignupPage() {
  const { t } = useTranslation("auth");
  const next = useNext();
  const navigate = useNavigate();
  const google = useTakeParam("google");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [taken, setTaken] = useState(false);
  const [closed, setClosed] = useState(false);
  // null until /auth/me answers: GoogleButton holds its slot until then.
  const [googleEnabled, setGoogleEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    getAuthMe()
      .then((me) => {
        if (!live) return;
        setGoogleEnabled(me.google_enabled === true);
        if (me.authenticated && me.verified) window.location.assign(next);
        else if (me.signup_open === false) setClosed(true);
      })
      .catch(() => {
        // The form still works; the server answers the submit. Google goes.
        if (live) setGoogleEnabled(false);
      });
    return () => {
      live = false;
    };
  }, [next]);

  // After mount, for /login's reason: the error slot announces a change.
  useEffect(() => {
    if (google === "signup_closed") setClosed(true);
    else if (google && google !== "cancelled") setError(googleErrorMessage(google));
  }, [google]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTaken(false);
    if (!looksLikeEmail(email)) {
      setError(t("errors.invalidEmail"));
      return;
    }
    if (charCount(password) < 8) {
      setError(t("errors.weakPassword.tooShort"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await signup({
        email: email.trim(),
        password,
        // The verification mail is written in this language.
        locale: i18n.resolvedLanguage === "he" ? "he" : "en",
      });
      navigate(withNext("/verify", next), { state: { sentAt: Date.now() } });
    } catch (err) {
      const code = apiErrorCode(err);
      if (code === "signup_closed") {
        setClosed(true);
      } else {
        setTaken(code === "email_taken");
        setError(apiErrorMessage(err, t("errors.generic")));
      }
      setBusy(false);
    }
  }

  if (closed) {
    return (
      <AuthCard title={t("signup.closedTitle")} sub={t("signup.closedBody")}>
        <Link to={withNext("/login", next)} className={primaryLinkCls}>
          {t("signup.logIn")}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("signup.title")} sub={t("signup.sub")}>
      <GoogleButton next={next} page="signup" enabled={googleEnabled} />

      <form onSubmit={submit} noValidate>
        <div className="space-y-4">
          <Field id="signup-email" label={t("fields.email")}>
            <EmailInput id="signup-email" value={email} onChange={setEmail} disabled={busy} />
          </Field>
          <Field id="signup-password" label={t("fields.password")} hint={t("fields.passwordHint")}>
            <PasswordInput
              id="signup-password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              disabled={busy}
            />
          </Field>
        </div>
        <FormError message={error} />
        {taken && (
          <Link
            to={withNext("/login", next)}
            state={{ email: email.trim() }}
            className={cn(authLinkCls, "text-sm")}
          >
            {t("signup.logInInstead")}
          </Link>
        )}
        {/* mt-1, not mt-4: the link's own 44px line box already supplies the
            room above the text, and mt-4 on top of it read as a gap twice the
            field spacing. */}
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          {t("signup.privacyNote")}{" "}
          <Link to="/privacy" className={cn(authLinkCls, "text-xs")}>
            {t("signup.privacyLink")}
          </Link>
        </p>
        <Button type="submit" loading={busy} className="mt-2 min-h-[44px] w-full">
          {t("signup.submit")}
        </Button>
      </form>

      <p className="mt-3 flex flex-wrap items-center justify-center gap-x-1.5 text-sm text-ink-muted">
        {t("signup.haveAccount")}
        <Link to={withNext("/login", next)} className={authLinkCls}>
          {t("signup.logIn")}
        </Link>
      </p>
    </AuthCard>
  );
}
