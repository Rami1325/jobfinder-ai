import { NavLink, Outlet } from "react-router-dom";
import { Sparkles, FileText, MessageSquareText, Briefcase, Wrench, KanbanSquare } from "lucide-react";
import { cn } from "../lib/cn";

const nav = [
  { to: "/app", label: "Tailor", icon: FileText },
  { to: "/interview", label: "Interview", icon: MessageSquareText },
  { to: "/jobs", label: "Job Match", icon: Briefcase },
  { to: "/tools", label: "Tools", icon: Wrench },
  { to: "/tracker", label: "Tracker", icon: KanbanSquare },
];

export default function AppLayout() {
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
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
