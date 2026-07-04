import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";

export default function Footer() {
  return (
    <footer className="border-t border-line/60">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-ink-muted sm:flex-row">
        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-accent-gradient text-white">
            <Sparkles size={12} />
          </span>
          <span className="font-medium text-ink">JobFinder</span>
          <span className="text-ink-faint">· Honest AI resume tailoring</span>
        </div>
        <div className="flex items-center gap-5">
          <Link to="/jobs" className="hover:text-ink">App</Link>
          <a href="#how" className="hover:text-ink">How it works</a>
          <a href="#faq" className="hover:text-ink">FAQ</a>
        </div>
      </div>
    </footer>
  );
}
