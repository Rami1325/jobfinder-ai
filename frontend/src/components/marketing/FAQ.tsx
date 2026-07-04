import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import Reveal from "./Reveal";

const FAQ_KEYS = ["1", "2", "3", "4"] as const;

function Item({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-line bg-panel/60">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-start"
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
  const { t } = useTranslation("marketing");
  return (
    <section id="faq" className="mx-auto max-w-3xl px-4 py-20">
      <Reveal className="mb-10 text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-accent-soft">{t("faq.kicker")}</p>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-ink sm:text-4xl">{t("faq.title")}</h2>
      </Reveal>
      <div className="space-y-3">
        {FAQ_KEYS.map((k) => (
          <Item key={k} q={t(`faq.q${k}`)} a={t(`faq.a${k}`)} />
        ))}
      </div>
    </section>
  );
}
