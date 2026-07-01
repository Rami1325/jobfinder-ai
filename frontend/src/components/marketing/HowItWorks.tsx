import { Upload, ScanSearch, ShieldCheck } from "lucide-react";
import Reveal from "./Reveal";

const steps = [
  {
    icon: Upload,
    title: "Upload & structure",
    body: "Drop in your resume (DOCX/PDF). We parse it into structured data and build an immutable Facts Ledger of everything you've actually done.",
  },
  {
    icon: ScanSearch,
    title: "Analyze & tailor",
    body: "Paste the job description. JobFinder scores keyword coverage and recruiter fit, then rewrites your resume to emphasize what matters — never inventing.",
  },
  {
    icon: ShieldCheck,
    title: "Verify & export",
    body: "The Fabrication Guard diffs every tailored claim against your ledger. Anything invented gets flagged. Export ATS-safe DOCX or PDF.",
  },
];

export default function HowItWorks() {
  return (
    <section id="how" className="relative mx-auto max-w-6xl px-4 py-20">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-accent-soft">How it works</p>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          Three steps. Zero fabrication.
        </h2>
        <p className="mt-3 text-ink-muted">
          The same pipeline that runs under the hood — nothing hidden, nothing made up.
        </p>
      </Reveal>

      <div className="mt-14 grid gap-6 md:grid-cols-3">
        {steps.map((s, i) => (
          <Reveal key={s.title} delay={i * 0.1}>
            <div className="relative h-full rounded-xl2 border border-line bg-gradient-to-b from-panel to-panel/70 p-6 shadow-card">
              <div className="mb-4 flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl border border-accent/30 bg-accent/10 text-accent-soft">
                  <s.icon size={18} />
                </span>
                <span className="text-sm font-semibold text-ink-faint">Step {i + 1}</span>
              </div>
              <h3 className="text-lg font-semibold text-ink">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{s.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
