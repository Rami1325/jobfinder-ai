import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

export default function ToolShell({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div>
        <Link to="/tools" className="mb-3 inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink">
          <ArrowLeft size={13} /> All tools
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
          {icon} {title}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}
