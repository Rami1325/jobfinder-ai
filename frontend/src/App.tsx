import { Suspense, lazy, useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
// Eager: the marketing landing is the most latency-sensitive first visit and
// must render with zero extra roundtrips — keep it in the entry chunk.
import MarketingLayout from "./layouts/MarketingLayout";
import Landing from "./pages/Landing";
import AccessGate from "./components/AccessGate";
import ScrollToTop from "./components/ScrollToTop";
import { prefetchAppRoutes } from "./lib/prefetchRoutes";

// Lazy: everything behind a navigation gets its own chunk so the landing
// visitor doesn't download the whole app. Module paths must stay in sync with
// src/lib/prefetchRoutes.ts so Vite reuses the same chunks.
const ScanPage = lazy(() => import("./pages/ScanPage"));
const AppLayout = lazy(() => import("./layouts/AppLayout"));
const HomePage = lazy(() => import("./pages/HomePage"));
const TailorPage = lazy(() => import("./pages/TailorPage"));
const TrackerPage = lazy(() => import("./pages/TrackerPage"));
const InterviewPage = lazy(() => import("./pages/InterviewPage"));
const JobsPage = lazy(() => import("./pages/JobsPage"));
const KitReviewPage = lazy(() => import("./pages/KitReviewPage"));
const ToolsPage = lazy(() => import("./pages/ToolsPage"));
const AtsToolPage = lazy(() => import("./pages/tools/AtsToolPage"));
const LinkedInToolPage = lazy(() => import("./pages/tools/LinkedInToolPage"));
const FollowUpToolPage = lazy(() => import("./pages/tools/FollowUpToolPage"));
const OutreachToolPage = lazy(() => import("./pages/tools/OutreachToolPage"));
const ScreeningToolPage = lazy(() => import("./pages/tools/ScreeningToolPage"));
const CompanyBriefToolPage = lazy(() => import("./pages/tools/CompanyBriefToolPage"));
const ResumeHealthToolPage = lazy(() => import("./pages/tools/ResumeHealthToolPage"));

function RouteFallback() {
  return (
    <div className="min-h-dvh grid place-items-center">
      <Loader2 className="h-6 w-6 animate-spin text-ink-muted" aria-label="Loading" />
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
          <Route element={<MarketingLayout />}>
            <Route path="/" element={<Landing />} />
            <Route path="/scan" element={<ScanPage />} />
          </Route>
          <Route element={<AppLayout />}>
            <Route path="/home" element={<HomePage />} />
            <Route path="/app" element={<TailorPage />} />
            <Route path="/interview" element={<InterviewPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/kits/:id" element={<KitReviewPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/tools/ats" element={<AtsToolPage />} />
            <Route path="/tools/linkedin" element={<LinkedInToolPage />} />
            <Route path="/tools/follow-up" element={<FollowUpToolPage />} />
            <Route path="/tools/outreach" element={<OutreachToolPage />} />
            <Route path="/tools/screening" element={<ScreeningToolPage />} />
            <Route path="/tools/company-brief" element={<CompanyBriefToolPage />} />
            <Route path="/tools/resume-health" element={<ResumeHealthToolPage />} />
            <Route path="/tracker" element={<TrackerPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
