import { Suspense, lazy, useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
// Eager: the marketing landing is the most latency-sensitive first visit and
// must render with zero extra roundtrips — keep it in the entry chunk.
import MarketingLayout from "./layouts/MarketingLayout";
import Landing from "./pages/Landing";
import AccessGate from "./components/AccessGate";
import ScrollToTop from "./components/ScrollToTop";
import { prefetchAppRoutes } from "./lib/prefetchRoutes";
import { withNext } from "./lib/safeNext";

// Lazy: everything behind a navigation gets its own chunk so the landing
// visitor doesn't download the whole app. Module paths must stay in sync with
// src/lib/prefetchRoutes.ts so Vite reuses the same chunks.
const ScanPage = lazy(() => import("./pages/ScanPage"));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage"));
const AuthLayout = lazy(() => import("./layouts/AuthLayout"));
const LoginPage = lazy(() => import("./pages/auth/LoginPage"));
const SignupPage = lazy(() => import("./pages/auth/SignupPage"));
const VerifyPage = lazy(() => import("./pages/auth/VerifyPage"));
const ForgotPage = lazy(() => import("./pages/auth/ForgotPage"));
const ResetPage = lazy(() => import("./pages/auth/ResetPage"));
const AppLayout = lazy(() => import("./layouts/AppLayout"));
const TailorPage = lazy(() => import("./pages/TailorPage"));
const TrackerPage = lazy(() => import("./pages/TrackerPage"));
const InterviewPage = lazy(() => import("./pages/InterviewPage"));
const JobsPage = lazy(() => import("./pages/JobsPage"));
const KitReviewPage = lazy(() => import("./pages/KitReviewPage"));
const ToolsPage = lazy(() => import("./pages/ToolsPage"));
const XrayToolPage = lazy(() => import("./pages/tools/XrayToolPage"));
const LinkedInToolPage = lazy(() => import("./pages/tools/LinkedInToolPage"));
const FollowUpToolPage = lazy(() => import("./pages/tools/FollowUpToolPage"));
const OutreachToolPage = lazy(() => import("./pages/tools/OutreachToolPage"));
const ScreeningToolPage = lazy(() => import("./pages/tools/ScreeningToolPage"));
const CompanyBriefToolPage = lazy(() => import("./pages/tools/CompanyBriefToolPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

function RouteFallback() {
  // main.tsx awaits initI18n before the first render, so `t` is ready here.
  const { t } = useTranslation("common");
  return (
    <div className="min-h-dvh grid place-items-center" role="status">
      <Loader2 className="h-6 w-6 animate-spin text-ink-muted" aria-label={t("loading")} />
    </div>
  );
}

export default function App() {
  useEffect(() => {
    prefetchAppRoutes();
  }, []);

  return (
    <>
      <ScrollToTop />
      <AccessGate />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          {/* The landing owns its own shell (header, footer and the
              `.jobfinder-landing` token scope), so it sits OUTSIDE the
              marketing layout, which keeps its warm-paper palette and its
              aurora for /privacy. */}
          <Route path="/" element={<Landing />} />
          <Route element={<MarketingLayout />}>
            {/* Public, and read before signing up as often as after: the
                signup form links here. */}
            <Route path="/privacy" element={<PrivacyPage />} />
          </Route>
          {/* The account pages, OUTSIDE the AppLayout group. That layout runs
              the auth guard, loads the kits and mounts the onboarding modal,
              and every one of those assumes an account the app can already
              serve — a visitor on these pages is by definition not one yet.
              Every <Route> keeps `path` as its FIRST attribute: check-mirrors
              9 reads routes with exactly that shape. */}
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/verify" element={<VerifyPage />} />
            <Route path="/forgot" element={<ForgotPage />} />
            <Route path="/reset" element={<ResetPage />} />
          </Route>
          <Route element={<AppLayout />}>
            <Route path="/app" element={<TailorPage />} />
            <Route path="/interview" element={<InterviewPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/kits/:id" element={<KitReviewPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            {/* The CV scan, an app feature since Phase 30. It was the public
                /scan, which now redirects to sign-up (below). */}
            <Route path="/tools/scan" element={<ScanPage />} />
            <Route path="/tools/xray" element={<XrayToolPage />} />
            <Route path="/tools/linkedin" element={<LinkedInToolPage />} />
            <Route path="/tools/follow-up" element={<FollowUpToolPage />} />
            <Route path="/tools/outreach" element={<OutreachToolPage />} />
            <Route path="/tools/screening" element={<ScreeningToolPage />} />
            <Route path="/tools/company-brief" element={<CompanyBriefToolPage />} />
            <Route path="/tracker" element={<TrackerPage />} />
            {/* A real page INSIDE the layout group, not a redirect. The rule
                only pushes redirects out (a <Navigate> under this route paints
                the full-screen <Suspense> fallback, then an empty shell, then
                the fallback again) — a page belongs here, and the account menu
                links straight at it. */}
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          {/* /home was the dashboard deleted in 22.9. It carries no query, hash
              or state, so a bare redirect loses nothing — and `replace` keeps
              Back from bouncing off it, which matters for the installed PWA
              (manifest display: standalone) where there is no URL bar. */}
          <Route path="/home" element={<Navigate to="/app" replace />} />
          {/* /scan was the public CV scan until Phase 30 made every feature
              login first, and old links to it are still out there. They land
              on sign-up with the scan as `next`, not on "Welcome back": most
              people holding one have no account yet, and SignupPage forwards a
              signed-in visitor straight on. Outside every layout group, and
              `replace`, for /home's reasons. `withNext` comes from the
              dependency-free lib/safeNext.ts, never the landing's `signupFor`,
              because this file is the entry chunk. */}
          <Route path="/scan" element={<Navigate to={withNext("/signup", "/tools/scan")} replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
