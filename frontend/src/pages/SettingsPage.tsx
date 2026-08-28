import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BellRing, LogOut, Palette, ShieldAlert, Trash2, UserRound } from "lucide-react";
import { deleteAccount, deleteMyData, getMe } from "../api/client";
import { signOut } from "../layouts/AppLayout";
import { ACCESS_CODE_KEY } from "../lib/accessCode";
import LanguageSwitch from "../components/LanguageSwitch";
import ThemeToggle from "../components/ThemeToggle";
import { Button, Card, CardTitle, useToast } from "../components/ui";
import type { Me } from "../types";

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
      // waiting to redirect, and a second tap in that window goes out with the
      // access code already removed from localStorage: a 401, the client's
      // UNAUTHORIZED_EVENT, and the AccessGate covering the screen asking for
      // the one string guaranteed never to work again — over the top of the
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
  // three words, and what actually separates them -- whether your access code
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

/** The account surface: appearance, who you are, and the two ways out.
 *
 * There are no passwords here — a deployed instance is gated by an access code
 * that maps to a User row, so "sign out" means forgetting the code on this
 * device and the two destructive actions are genuinely different things:
 * "Delete all my data" empties the account and leaves the code working,
 * "Close my account" also switches the code off. Both ship, clearly separated,
 * because a tester wanting a clean slate and someone leaving for good are not
 * the same person. */
export default function SettingsPage() {
  const { t } = useTranslation("settings");
  // The wipe copy is reused VERBATIM from common.json rather than restated
  // here: it is the sentence that promises the code keeps working, and two
  // translations of one promise is how they drift apart.
  const { t: tCommon } = useTranslation();
  const toast = useToast();
  const [me, setMe] = useState<Me | null>(null);
  const { hash, key } = useLocation();

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
   * card, not a button, is the target: `getMe` can add an identity line above
   * it a moment later, and a whole card absorbs that shift where a 32px
   * control would be pushed out from under the scroll.
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

  // Best-effort: the identity line is a nicety, so a failure hides it and
  // leaves every other section — including Sign out — fully usable. Nothing on
  // this page waits on it.
  useEffect(() => {
    let live = true;
    getMe()
      .then((m) => live && setMe(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // `signOut` is IMPORTED, not re-implemented. It was four byte-identical
  // lines in both files, and "forget this user" is precisely the pair that
  // drifts: the day a fifth module-level store is added, only one of the two
  // copies gets it and the other repaints the marketing page with the previous
  // user's CV one tab away.

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
      // The code is dead on the server now, so drop it here too — leaving it
      // would pop the AccessGate and invite the user to retype the one string
      // guaranteed never to work again.
      localStorage.removeItem(ACCESS_CODE_KEY);
      toast("success", t("danger.closed"));
      setTimeout(() => window.location.assign("/"), 800);
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
          {me?.name && (
            <p className="text-ink">
              <span className="text-ink-muted">{t("account.name")}: </span>
              {me.name}
            </p>
          )}
          {me?.email && (
            // Wrapped in a bidi isolate: an address is Latin text inside a
            // Hebrew line, and without this the RTL paragraph reorders the
            // punctuation around it.
            <p className="break-all text-ink">
              <span className="text-ink-muted">{t("account.email")}: </span>
              <bdi>{me.email}</bdi>
            </p>
          )}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-muted">{t("account.device")}</p>
        {/* Not a <Row>: the hint IS the label here, and a Row would print
            "Sign out" twice — once as the row name, once on the button. */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line pt-4">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-muted">
            {t("account.signOutHint")}
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={signOut}
            // The door glyph points out to the right; in RTL "out" is the other
            // way, so it mirrors with the reading direction.
            icon={<LogOut size={14} className="rtl:-scale-x-100" />}
          >
            {t("account.signOut")}
          </Button>
        </div>
      </Card>

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
              disabledReason={me?.is_admin ? t("danger.closeAdminBlocked") : undefined}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}
