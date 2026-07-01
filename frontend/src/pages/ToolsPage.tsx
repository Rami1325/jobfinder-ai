import { Link } from "react-router-dom";
import { ScanLine, Contact, Mail, ArrowUpRight, Wrench } from "lucide-react";

const tools = [
  { to: "/tools/ats", icon: ScanLine, title: "ATS résumé scanner", body: "Score formatting + keyword coverage and get concrete fixes before a bot rejects you." },
  { to: "/tools/linkedin", icon: Contact, title: "LinkedIn optimizer", body: "A sharper headline, About, and bullets — drawn only from your real experience." },
  { to: "/tools/follow-up", icon: Mail, title: "Follow-up email writer", body: "Concise, specific follow-up emails that don't read like a template." },
];

export default function ToolsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
          <Wrench className="text-accent-soft" /> Tools
        </h1>
        <p className="mt-1 text-sm text-ink-muted">Focused, single-purpose helpers for your search.</p>
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {tools.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className="group flex h-full flex-col rounded-xl2 border border-line bg-gradient-to-b from-panel to-panel/70 p-6 shadow-card transition-all hover:-translate-y-1 hover:border-accent/50 hover:shadow-glow"
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-panel-2 text-accent-soft group-hover:border-accent/40">
                <t.icon size={18} />
              </span>
              <ArrowUpRight size={18} className="text-ink-faint transition-colors group-hover:text-accent-soft" />
            </div>
            <h3 className="text-lg font-semibold text-ink">{t.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t.body}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
