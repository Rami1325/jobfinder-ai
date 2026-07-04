import { useSyncExternalStore } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { Sparkles, FileText, MessageSquareText, Briefcase, Wrench, KanbanSquare, Loader2 } from "lucide-react";
import { cn } from "../lib/cn";
import ThemeToggle from "../components/ThemeToggle";
import { getJobSearchState, subscribeJobSearch } from "../state/jobSearchStore";

const nav = [
  { to: "/jobs", label: "Jobs", icon: Briefcase },
  { to: "/app", label: "Tailor", icon: FileText },
  { to: "/interview", label: "Interview", icon: MessageSquareText },
  { to: "/tools", label: "Tools", icon: Wrench },
  { to: "/tracker", label: "Tracker", icon: KanbanSquare },
];

export default function AppLayout() {
  const { searching } = useSyncExternalStore(subscribeJobSearch, getJobSearchState);
  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="sticky top-0 z-30 border-b border-line/70 bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <NavLink to="/" className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent-gradient text-white shadow-glow">
              <Sparkles size={15} />
            </span>
            <span className="text-[15px]">JobFinder</span>
          </NavLink>
          <nav className="flex items-center gap-1">
            {nav.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-panel-2 text-ink"
                      : "text-ink-muted hover:bg-panel-2/60 hover:text-ink",
                  )
                }
              >
                <Icon size={15} />
                <span className="hidden sm:inline">{label}</span>
                {to === "/jobs" && searching && (
                  <Loader2 size={13} className="animate-spin text-accent-soft" />
                )}
              </NavLink>
            ))}
            <ThemeToggle className="ml-1" />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
