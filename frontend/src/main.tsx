import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ToastProvider } from "./components/ui";
import "./i18n"; // side-effect: initializes i18next + <html lang dir> sync
import "@fontsource-variable/heebo"; // Hebrew-first font, applied via html[lang="he"]
import "./styles.css";

// Optional error reporting: only initialized when VITE_SENTRY_DSN is set at
// build time. Dynamically imported so the default build ships zero Sentry code
// on the critical path. No tracing, no replay, no PII.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
if (sentryDsn) {
  import("@sentry/react")
    .then((Sentry) => Sentry.init({ dsn: sentryDsn, sendDefaultPii: false }))
    .catch(() => {
      /* error reporting is best-effort — never block the app */
    });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
