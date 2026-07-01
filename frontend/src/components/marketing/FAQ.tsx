import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import Reveal from "./Reveal";

const faqs = [
  {
    q: "Does JobFinder make things up on my resume?",
    a: "No — and that's the whole point. A code-enforced Fabrication Guard diffs every tailored claim against a ledger built from your original resume. Anything it can't trace back to your real experience is flagged, not shipped.",
  },
  {
    q: "Will the output pass ATS screening?",
    a: "Yes. Both the DOCX and PDF exporters enforce ATS-safe rules: single column, standard section names, no tables, text boxes, images, headers, or footers — just clean, parseable text.",
  },
  {
    q: "Do I need an account or a subscription?",
    a: "No accounts, no billing. It's a personal tool. It even runs fully offline with a built-in stub, so you can try the entire pipeline without an API key.",
  },
  {
    q: "How is this different from auto-apply tools?",
    a: "Auto-apply tools optimize for volume and often submit generic, fabricated applications that get flagged. JobFinder optimizes for quality and truth: you stay in control of what's sent, and every claim is defensible.",
  },
];

function Item({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-line bg-panel/60">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <span className="font-medium text-ink">{q}</span>
        <ChevronDown
          size={18}
          className={`shrink-0 text-ink-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <p className="px-5 pb-5 text-sm leading-relaxed text-ink-muted">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function FAQ() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-4 py-20">
      <Reveal className="mb-10 text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-accent-soft">FAQ</p>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-ink sm:text-4xl">Straight answers</h2>
      </Reveal>
      <div className="space-y-3">
        {faqs.map((f) => (
          <Item key={f.q} {...f} />
        ))}
      </div>
    </section>
  );
}
