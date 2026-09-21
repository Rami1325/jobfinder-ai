import { useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { forgotPassword } from "../../api/client";
import { Button } from "../../components/ui";
import { apiErrorMessage } from "../../lib/apiError";
import { cn } from "../../lib/cn";
import { rememberResetNext, withNext } from "../../lib/safeNext";
import {
  AuthCard,
  EmailInput,
  Field,
  FormError,
  authLinkCls,
  looksLikeEmail,
  primaryLinkCls,
  useNext,
} from "./shared";

/**
 * /forgot.
 *
 * The confirmation reads the same for every address, known or not, and is
 * phrased as "if an account exists". The server answers the same body, and at
 * the same moment unless the reset mail itself takes longer than its minimum
 * response time (`accounts.forgot`, P29-FORGOT-TIMING). That is all this page
 * proves: signup still says when an address is taken. A request that never
 * arrived (no network, the server unreachable) is still shown as an error: "we
 * sent a link" over it is a promise nobody will keep. A failed send is not an
 * error here; the server answers {ok} for it by contract. The wait can be a
 * few seconds, which the button's loading state already covers.
 */
export default function ForgotPage() {
  const { t } = useTranslation("auth");
  const { state } = useLocation();
  const next = useNext();
  const [email, setEmail] = useState<string>(() => (state as { email?: string } | null)?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentTo, setSentTo] = useState("");

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
      await forgotPassword(value);
      // The mail link carries no `next`. Remembered here, it is picked up by
      // /reset when the link is opened on this device (lib/safeNext.ts).
      rememberResetNext(next);
      setSentTo(value);
    } catch (err) {
      setError(apiErrorMessage(err, t("errors.generic")));
    }
    setBusy(false);
  }

  if (sentTo) {
    return (
      <AuthCard title={t("forgot.sentTitle")}>
        <p className="text-sm leading-relaxed text-ink-muted">{t("forgot.sentBody")}</p>
        <p className="mt-2 break-all text-sm font-medium text-ink">
          <bdi>{sentTo}</bdi>
        </p>
        <Link to={withNext("/login", next)} state={{ email: sentTo }} className={cn(primaryLinkCls, "mt-5")}>
          {t("forgot.back")}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("forgot.title")} sub={t("forgot.sub")}>
      <form onSubmit={submit} noValidate>
        <Field id="forgot-email" label={t("fields.email")}>
          <EmailInput id="forgot-email" value={email} onChange={setEmail} disabled={busy} />
        </Field>
        <FormError message={error} />
        <Button type="submit" loading={busy} className="mt-5 min-h-[44px] w-full">
          {t("forgot.submit")}
        </Button>
      </form>
      <p className="mt-2 text-center">
        <Link to={withNext("/login", next)} state={{ email: email.trim() }} className={cn(authLinkCls, "text-sm")}>
          {t("forgot.back")}
        </Link>
      </p>
    </AuthCard>
  );
}
