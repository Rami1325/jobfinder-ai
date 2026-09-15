import { useState } from "react";
import { useTranslation } from "react-i18next";
import { startGoogleSignIn } from "../../api/client";
import { Button } from "../../components/ui";
import i18n from "../../i18n";
import { apiErrorMessage } from "../../lib/apiError";
import { cn } from "../../lib/cn";
import { chromeIntentUrl, isAndroid, isInAppBrowser } from "../../lib/inAppBrowser";
import { FormError, authInputCls, authLinkCls } from "./shared";

/**
 * Continue with Google, under the email form on /login and /signup (Phase 30 F1).
 *
 * The page renders it only once /auth/me says this server offers it, and BELOW
 * the form's submit button. That answer can arrive seconds into a cold start,
 * and a button landing above the form would move the email field out from
 * under a tap already on its way (check-mirrors 32(l)).
 *
 * A tap starts the flow on the server and sends the whole document to Google.
 * `startGoogleSignIn` forgets the stored invite code and both caches first,
 * because nothing of ours runs on the way back. The loading state then stays
 * on: the page is leaving, and a second tap would start a second flow. A refusal
 * to START shows under the button; a refusal after Google comes back as
 * `?google=<code>`, which the page itself reads.
 *
 * Inside an app's embedded browser Google refuses to sign anyone in, so the
 * button is replaced by one line saying where it works (lib/inAppBrowser.ts).
 * The email form above keeps working either way.
 */
export default function GoogleButton({ next, page }: { next: string; page: "login" | "signup" }) {
  const { t } = useTranslation("auth");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const userAgent = navigator.userAgent;

  if (isInAppBrowser(userAgent)) return <InAppBrowserNote android={isAndroid(userAgent)} />;

  async function start() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const url = await startGoogleSignIn({
        next,
        page,
        // The language of any notice this sign-in mails.
        locale: i18n.resolvedLanguage === "he" ? "he" : "en",
      });
      window.location.assign(url);
    } catch (err) {
      setError(apiErrorMessage(err, t("errors.generic")));
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="my-4 flex items-center gap-3 text-xs text-ink-muted">
        <span aria-hidden className="h-px flex-1 bg-line" />
        {t("google.or")}
        <span aria-hidden className="h-px flex-1 bg-line" />
      </div>
      <Button
        type="button"
        variant="secondary"
        loading={busy}
        onClick={start}
        icon={<GoogleMark />}
        className="min-h-[44px] w-full"
      >
        {t("google.continue")}
      </Button>
      <FormError message={error} />
    </div>
  );
}

/**
 * What stands in for the button inside an embedded browser: one line, a way to
 * copy this page's link (its `next` included) for Chrome or Safari, and on
 * Android a link that opens the page in Chrome directly.
 *
 * When copying fails the link is shown in a field to copy by hand. The
 * clipboard is among the first things an embedded browser takes away.
 */
function InAppBrowserNote({ android }: { android: boolean }) {
  const { t } = useTranslation("auth");
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const href = window.location.href;

  async function copyLink() {
    setCopy((await copyText(href)) ? "done" : "failed");
  }

  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="flex flex-wrap items-center gap-x-3 text-sm leading-relaxed text-ink-muted">
        <span>{t("google.inApp")}</span>
        <button type="button" onClick={copyLink} className={authLinkCls}>
          {copy === "done" ? t("google.copied") : t("google.copyLink")}
        </button>
        {android && (
          <a href={chromeIntentUrl(window.location)} className={authLinkCls}>
            {t("google.openChrome")}
          </a>
        )}
      </p>
      {copy === "failed" && (
        <input
          readOnly
          dir="ltr"
          value={href}
          aria-label={t("google.copyLink")}
          onFocus={(e) => e.currentTarget.select()}
          className={cn(authInputCls, "mt-2")}
        />
      )}
    </div>
  );
}

/** Copies `text`, falling back to the older copy command, which many embedded
 * browsers still allow when they refuse the clipboard API. False when both fail. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

/** Google's "G", drawn as paths. Its sign-in branding asks for the mark on the button. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
