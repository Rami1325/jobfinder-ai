import { useId, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import Reveal from "./Reveal";

const FAQ_KEYS = ["1", "2", "3", "4", "5", "6"] as const;

function Item({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="overflow-hidden rounded-xl2 border border-line bg-panel shadow-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        id={`${id}-button`}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70 sm:px-6 sm:py-5"
      >
        <span className="text-[15px] font-semibold text-ink sm:text-base">{q}</span>
        <ChevronDown
          size={18}
          aria-hidden
          className={`shrink-0 text-ink-faint transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="panel"
            id={`${id}-panel`}
            role="region"
            aria-labelledby={`${id}-button`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <p className="px-5 pb-5 text-sm leading-relaxed text-ink-muted sm:px-6 sm:pb-6">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function FAQ() {
  const { t } = useTranslation("marketing");
  return (
    <section id="faq" className="mx-auto max-w-3xl px-4 py-16 sm:py-20">
      <Reveal className="mb-10 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{t("faq.kicker")}</p>
        <h2 className="mt-3 text-3xl font-bold tracking-[-0.025em] text-ink sm:text-[2.6rem] sm:leading-[1.1]">
          {t("faq.title")}
        </h2>
      </Reveal>
      <div className="space-y-3">
        {FAQ_KEYS.map((k) => (
          <Item key={k} q={t(`faq.q${k}`)} a={t(`faq.a${k}`)} />
        ))}
      </div>
    </section>
  );
}
