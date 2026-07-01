import { Link } from "react-router-dom";
import { FileText, MessageSquareText, Briefcase, ScanLine, Contact, Mail, ArrowUpRight } from "lucide-react";
import Reveal from "./Reveal";

const features = [
  { to: "/app", icon: FileText, title: "Resume tailoring", body: "Rewrite for each job, with before/after match scores and a full changelog of every edit." },
  { to: "/interview", icon: MessageSquareText, title: "Interview prep", body: "Role-specific questions and STAR model answers grounded in your real experience." },
  { to: "/jobs", icon: Briefcase, title: "Job match", body: "Paste or link multiple roles and rank them by fit against your master resume." },
  { to: "/tools/ats", icon: ScanLine, title: "ATS scanner", body: "Check formatting and keyword coverage before a bot ever rejects you." },
  { to: "/tools/linkedin", icon: Contact, title: "LinkedIn optimizer", body: "A sharper headline, About, and experience — from facts you already have." },
  { to: "/tools/follow-up", icon: Mail, title: "Follow-up writer", body: "Concise, specific follow-up emails that don't read like a template." },
];

export default function FeatureGrid() {
  return (
    <section id="features" className="relative mx-auto max-w-6xl px-4 py-20">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-accent-soft">The toolkit</p>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          Everything for the search — honestly built
        </h2>
      </Reveal>

      <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((f, i) => (
          <Reveal key={f.to} delay={(i % 3) * 0.08}>
            <Link
              to={f.to}
              className="group relative flex h-full flex-col rounded-xl2 border border-line bg-gradient-to-b from-panel to-panel/70 p-6 shadow-card transition-all hover:-translate-y-1 hover:border-accent/50 hover:shadow-glow"
            >
              <div className="mb-4 flex items-center justify-between">
                <span className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-panel-2 text-accent-soft group-hover:border-accent/40">
                  <f.icon size={18} />
                </span>
                <ArrowUpRight size={18} className="text-ink-faint transition-colors group-hover:text-accent-soft" />
              </div>
              <h3 className="text-lg font-semibold text-ink">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{f.body}</p>
            </Link>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
