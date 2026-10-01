import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useTakeParam } from "../hooks/useTakeParam";
import { withNext } from "../lib/safeNext";

/**
 * "You're signed in with Google, and the password from your unfinished sign-up
 * was removed" (Phase 30 F3).
 *
 * A Google sign-in on an address that had an UNVERIFIED email sign-up takes that
 * sign-up over (E3). The password chosen before the address was confirmed is
 * deleted, because whoever chose it never proved they own the address. The
 * server says so by adding `google=superseded` to wherever the sign-in lands,
 * and this reads it once, takes it out of the address, and shows the notice
 * until it is closed, with the way to set a password (the address filled in).
 *
 * Mounted in AppLayout AFTER the auth guard passes (check-mirrors 32(l)). In
 * the spinner branch it would take the flag out of the address and be unmounted
 * before anyone saw it. It lives outside the directories check 29 walks, so
 * 32(k) holds it to check 29's table.
 */
export default function GoogleNotice({ email }: { email: string }) {
  const { t } = useTranslation("auth");
  const { t: tCommon } = useTranslation();
  const google = useTakeParam("google");
  const [open, setOpen] = useState(google === "superseded");
  if (!open) return null;

  return (
    <div
      role="status"
      className="mb-6 flex items-start gap-2 rounded-lg border border-accent/40 bg-accent/10 py-2 pe-1 ps-3 text-sm leading-relaxed text-ink"
    >
      <div className="min-w-0 flex-1 pt-1">
        <p>{t("google.superseded")}</p>
        <Link
          to={withNext("/forgot", "/settings")}
          state={{ email }}
          className="inline-flex min-h-11 items-center font-medium text-accent-soft hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          {t("google.setPassword")}
        </Link>
      </div>
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label={tCommon("actions.close")}
        title={tCommon("actions.close")}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
