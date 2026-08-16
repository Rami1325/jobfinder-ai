import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import App from "./App";
import { ToastProvider } from "./components/ui";
import { initI18n } from "./i18n";
// Fonts: our own @font-face block, NOT the packages' index.css. Importing
// "@fontsource-variable/inter" + "/heebo" pulls all 12 subsets (324 kB emitted),
// and two of them are actively harmful rather than merely unused: heebo-math and
// heebo-symbols cover U+2190 and U+25A0-27BF, so the ← and ✓ in the Hebrew
// locale strings triggered a 14 kB font request during first paint — on the
// phone-first Hebrew UI — for two characters. src/fonts.css keeps latin +
// latin-ext + hebrew only; those glyphs now render in the system fallback,
// which is already what the English side does (Inter ships no symbols subset).
// Regenerate fonts.css if either package is bumped — see its header.
import "./fonts.css";
import "./styles.css";

// Optional error reporting: only initialized when VITE_SENTRY_DSN is set at
// build time. Dynamically imported so the default build ships zero Sentry code
// on the critical path. No tracing, no replay, no PII.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
if (sentryDsn) {
  import("@sentry/react")
    .then((Sentry) =>
      Sentry.init({
        dsn: sentryDsn,
        environment: import.meta.env.MODE, // "production" in builds, "development" in dev
        sendDefaultPii: false,
      }),
    )
    .catch(() => {
      /* error reporting is best-effort — never block the app */
    });
}

// The first render waits for i18next + the ACTIVE language's catalogs only
// (PLAN 12.5b) — the other language loads on demand when switched to.
void initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <BrowserRouter>
        {/* Make every framer-motion animation respect prefers-reduced-motion
            (transform/layout animations become instant; opacity still eases).
            The CSS killswitch in styles.css covers CSS animations; this covers JS. */}
        <MotionConfig reducedMotion="user">
          <ToastProvider>
            <App />
          </ToastProvider>
        </MotionConfig>
      </BrowserRouter>
    </React.StrictMode>,
  );
});
