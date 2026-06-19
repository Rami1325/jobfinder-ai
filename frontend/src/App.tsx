import { useState } from "react";
import TailorPage from "./pages/TailorPage";
import TrackerPage from "./pages/TrackerPage";

type Tab = "tailor" | "tracker";

export default function App() {
  const [tab, setTab] = useState<Tab>("tailor");

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          <span className="logo">●</span> JobFinder
        </h1>
        <nav className="tabs">
          <button className={tab === "tailor" ? "active" : ""} onClick={() => setTab("tailor")}>
            Tailor
          </button>
          <button className={tab === "tracker" ? "active" : ""} onClick={() => setTab("tracker")}>
            Tracker
          </button>
        </nav>
      </header>

      {tab === "tailor" ? <TailorPage /> : <TrackerPage />}
    </div>
  );
}
