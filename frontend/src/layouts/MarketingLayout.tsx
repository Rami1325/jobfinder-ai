import { Link, Outlet } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { Button } from "../components/ui";

export default function MarketingLayout() {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="sticky top-0 z-30 border-b border-line/40 bg-bg/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent-gradient text-white shadow-glow">
              <Sparkles size={15} />
            </span>
            <span className="text-[15px]">JobFinder</span>
          </Link>
          <div className="flex items-center gap-4">
            <a href="#how" className="hidden text-sm text-ink-muted hover:text-ink sm:inline">How it works</a>
            <a href="#features" className="hidden text-sm text-ink-muted hover:text-ink sm:inline">Features</a>
            <a href="#faq" className="hidden text-sm text-ink-muted hover:text-ink sm:inline">FAQ</a>
            <Link to="/jobs">
              <Button size="sm">Open app</Button>
            </Link>
          </div>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
