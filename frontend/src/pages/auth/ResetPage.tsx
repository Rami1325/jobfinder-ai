import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { resetPassword } from "../../api/client";
import { Button } from "../../components/ui";
import { markKeyRotated, readKeyRotation } from "../../lib/authResults";
import { takeResetNext } from "../../lib/safeNext";
import { apiErrorCode, apiErrorMessage } from "../../lib/apiError";
import { cn } from "../../lib/cn";
import {
  AuthCard,
  Field,
  FormError,
  PasswordInput,
  charCount,
  primaryLinkCls,
} from "./shared";

/**
 * /reset?token=… — the link from the password-reset mail.
 *
 * A reset proves the person controls the address, so the server also marks it
 * verified, ends every other session and signs this browser in. Success is
 * therefore straight into the app, as a document load.
 *
 * A spent or expired link locks the form and offers the only useful next step,
 * a new link. A form that stayed editable over a token that can never work
 * again would invite a second, third and fourth identical failure.
 */
export default function ResetPage() {
  const { t } = useTranslation("auth");
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dead, setDead] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || dead) return;
    if (charCount(password) < 8) {
      setError(t("errors.weakPassword.tooShort"));
      return;
    }
    if (password !== confirm) {
      setError(t("reset.mismatch"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await resetPassword(token, password);
      // Settings is not on screen after a reset, so the news that the
      // extension key changed waits there for the user (lib/authResults.ts).
      if (readKeyRotation(r).rotated) markKeyRotated();
      // Where the visitor was going when they asked for the link on this
      // device, validated again on the way out; otherwise /app.
      window.location.assign(takeResetNext());
    } catch (err) {
      const code = apiErrorCode(err);
      if (code === "expired" || code === "used") setDead(true);
      setError(apiErrorMessage(err, t("errors.generic")));
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthCard title={t("reset.title")}>
        <FormError message={t("reset.missingToken")} />
        <Link to="/forgot" className={cn(primaryLinkCls, "mt-5")}>
          {t("reset.requestNew")}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("reset.title")} sub={t("reset.sub")}>
      <form onSubmit={submit} noValidate>
        <div className="space-y-4">
          <Field id="reset-password" label={t("fields.newPassword")} hint={t("fields.passwordHint")}>
            <PasswordInput
              id="reset-password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              disabled={busy || dead}
            />
          </Field>
          <Field id="reset-confirm" label={t("fields.confirmPassword")}>
            <PasswordInput
              id="reset-confirm"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
              disabled={busy || dead}
            />
          </Field>
        </div>
        <FormError message={error} />
        {dead ? (
          <Link to="/forgot" className={cn(primaryLinkCls, "mt-5")}>
            {t("reset.requestNew")}
          </Link>
        ) : (
          <Button type="submit" loading={busy} className="mt-5 min-h-[44px] w-full">
            {t("reset.submit")}
          </Button>
        )}
      </form>
    </AuthCard>
  );
}
