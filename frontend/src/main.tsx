import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import App from "./App";
import { ToastProvider } from "./components/ui";
import { initI18n } from "./i18n";
import "@fontsource-variable/inter"; // Primary UI font (Latin)
import "@fontsource-variable/heebo"; // Hebrew-first font, applied via html[lang="he"]
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
