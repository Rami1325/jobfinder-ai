import { Link, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import Logo from "../components/Logo";
import LanguageSwitch from "../components/LanguageSwitch";
import ThemeToggle from "../components/ThemeToggle";

/**
 * The shell for /login, /signup, /verify, /forgot and /reset.
 *
 * OUTSIDE AppLayout, and that is the point. AppLayout runs the auth guard,
 * loads the kits and mounts the onboarding modal, the feedback pill and the tab
 * bar. Every one of those assumes an account the app can already serve, and
 * the visitor on these pages is by definition not one yet.
 *
 * The APP's tokens (`bg-bg`, `text-ink` from `:root`), not a marketing scope:
 * the next screen after these is the app, and the theme toggle here drives the
 * same `<html>` class it will find there.
 *
 * `min-h-dvh`, never `100vh`. On a phone `100vh` is the height with the browser
 * toolbars retracted, so a centred form sits partly under the on-screen
 * keyboard. Below `sm` the column is top-aligned for the same reason, so the
 * first field is in the top half of the screen where the keyboard cannot cover
 * it. From `sm` there is room, and it is centred.
 *
 * The header controls are 44px (`h-11`), not the app chrome's 32px floor: this
 * is a form surface a thumb reaches for, and CLAUDE.md's 32px is for dense
 * chrome only.
 */
export default function AuthLayout() {
  const { t } = useTranslation();
  const { t: ta } = useTranslation("auth");

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-ink">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-2 sm:px-6">
        <Link
          to="/"
          aria-label={t("appName")}
          className="-ms-1.5 inline-flex min-h-[44px] items-center rounded-lg px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          <Logo size={28} />
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSwitch className="h-11 min-w-11" />
          <ThemeToggle className="h-11 w-11" />
        </div>
      </header>

      <main className="flex flex-1 justify-center px-4 pb-8 pt-4 sm:items-center sm:pb-16 sm:pt-0">
        <div className="w-full max-w-sm">
          <Outlet />
        </div>
      </main>

      <footer className="flex justify-center px-4 pb-4">
        <Link
          to="/privacy"
          className="inline-flex min-h-[44px] items-center rounded px-2 text-xs text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          {ta("layout.privacy")}
        </Link>
      </footer>
    </div>
  );
}
