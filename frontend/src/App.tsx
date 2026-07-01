import { Routes, Route, Navigate } from "react-router-dom";
import MarketingLayout from "./layouts/MarketingLayout";
import AppLayout from "./layouts/AppLayout";
import Landing from "./pages/Landing";
import TailorPage from "./pages/TailorPage";
import TrackerPage from "./pages/TrackerPage";
import InterviewPage from "./pages/InterviewPage";
import JobsPage from "./pages/JobsPage";
import ToolsPage from "./pages/ToolsPage";
import AtsToolPage from "./pages/tools/AtsToolPage";
import LinkedInToolPage from "./pages/tools/LinkedInToolPage";
import FollowUpToolPage from "./pages/tools/FollowUpToolPage";

export default function App() {
  return (
    <Routes>
      <Route element={<MarketingLayout />}>
        <Route path="/" element={<Landing />} />
      </Route>
      <Route element={<AppLayout />}>
        <Route path="/app" element={<TailorPage />} />
        <Route path="/interview" element={<InterviewPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/tools/ats" element={<AtsToolPage />} />
        <Route path="/tools/linkedin" element={<LinkedInToolPage />} />
        <Route path="/tools/follow-up" element={<FollowUpToolPage />} />
        <Route path="/tracker" element={<TrackerPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
