import { Check, X } from "lucide-react";
import Reveal from "./Reveal";

const slop = [
  "Invents metrics and titles you never had",
  "Reads as templated — recruiters flag it",
  "Same buzzwords on every application",
  "You find out it lied in the interview",
];

const jobfinder = [
  "Every claim traced to your real resume",
  "Code-enforced guard blocks fabrication",
  "Tailored per job, keyword-accurate",
  "You can defend every line you send",
];

export default function WhyHonesty() {
  return (
    <section className="relative mx-auto max-w-6xl px-4 py-20">
      <div className="pointer-events-none absolute inset-x-8 top-1/2 -z-10 h-64 -translate-y-1/2 rounded-full bg-mint/10 blur-[100px]" />
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-accent-soft">Why honesty wins</p>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          Most AI resume tools get you caught
        </h2>
        <p className="mt-3 text-ink-muted">
          A resume that impresses the bot but collapses in the interview isn't an advantage. JobFinder optimizes the truth.
        </p>
      </Reveal>

      <div className="mx-auto mt-14 grid max-w-4xl gap-6 md:grid-cols-2">
        <Reveal>
          <div className="h-full rounded-xl2 border border-danger/25 bg-danger/[0.06] p-6">
            <h3 className="mb-4 text-lg font-semibold text-ink">Typical "AI apply" tools</h3>
            <ul className="space-y-3">
              {slop.map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-sm text-ink-muted">
                  <X size={16} className="mt-0.5 shrink-0 text-danger" /> {t}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="h-full rounded-xl2 border border-mint/30 bg-mint/[0.06] p-6 shadow-glow-mint">
            <h3 className="mb-4 text-lg font-semibold text-ink">JobFinder</h3>
            <ul className="space-y-3">
              {jobfinder.map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-sm text-ink">
                  <Check size={16} className="mt-0.5 shrink-0 text-mint" /> {t}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
