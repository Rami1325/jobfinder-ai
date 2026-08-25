import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";
import { ArrowRight, Check, FileCheck2, Globe, ShieldCheck, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Stamp } from "../ui";
import SplitText from "./SplitText";
import ResumeMiniature from "./ResumeMiniature";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const WORD_STAGGER = 0.07;
const wordCount = (s: string) => s.trim().split(/\s+/).length;

/**
 * The hero's demo loop, a tiny phase machine:
 * the match score climbs → the guard strikes the fabricated bullet on the
 * page and stamps it → hold ~3.2s → reset and repeat. Runs only while the
 * document is in view; reduced motion gets the final frame, static.
 */
type Phase = "before" | "after" | "guard" | "hold";
const PHASE_MS: Record<Phase, number> = { before: 1300, after: 1400, guard: 1200, hold: 3200 };
const NEXT_PHASE: Record<Phase, Phase> = { before: "after", after: "guard", guard: "hold", hold: "before" };

const TRUST = [
  { icon: Check, key: "bulletNoLogin" },
  { icon: Zap, key: "bulletOffline" },
  { icon: FileCheck2, key: "bulletAts" },
  { icon: Globe, key: "bulletBilingual" },
] as const;

export default function Hero() {
  const { t } = useTranslation("marketing");
  const reduce = useReducedMotion();

  // Headline choreography: each segment picks up where the previous ended.
  const title1 = t("hero.title1");
  const title2 = t("hero.title2");
  const highlight = t("hero.titleHighlight");
  const d1 = 0.05;
  const d2 = d1 + wordCount(title1) * WORD_STAGGER;
  const d3 = d2 + wordCount(title2) * WORD_STAGGER;

  const docRef = useRef<HTMLDivElement>(null);
  const inView = useInView(docRef, { amount: 0.3 });
  const [phase, setPhase] = useState<Phase>("before");
  const [cycle, setCycle] = useState(0);
  const looping = inView && !reduce;

  useEffect(() => {
    if (!looping) return;
    const tid = window.setTimeout(() => {
      if (phase === "hold") setCycle((c) => c + 1);
      setPhase(NEXT_PHASE[phase]);
    }, PHASE_MS[phase]);
    return () => window.clearTimeout(tid);
  }, [phase, cycle, looping]);

  const struck = reduce ? true : phase === "guard" || phase === "hold";
  const scored = reduce ? true : phase !== "before";

  return (
    <section className="relative">
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-4 pb-16 pt-14 sm:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:pb-24 lg:pt-24">
        <div>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3.5 py-1.5 text-[13px] font-medium text-ink-muted shadow-card"
          >
            <ShieldCheck size={14} className="text-mint" />
            {t("hero.badge")}
          </motion.div>

          <h1 className="text-[2.6rem] font-bold leading-[1.06] tracking-[-0.03em] text-ink sm:text-6xl lg:text-[4.1rem]">
            <SplitText text={title1} delay={d1} stagger={WORD_STAGGER} />{" "}
            <SplitText text={title2} delay={d2} stagger={WORD_STAGGER} />{" "}
            <SplitText text={highlight} delay={d3} stagger={WORD_STAGGER} className="text-accent" />
          </h1>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.35, ease: EASE }}
            className="mt-6 max-w-xl text-[17px] leading-relaxed text-ink-muted sm:text-lg"
          >
            {t("hero.sub")}
            <span className="font-semibold text-ink"> {t("hero.subEmphasis")}</span>
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.45, ease: EASE }}
            className="mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center"
          >
            <Link to="/app" className="sm:w-auto">
              <Button
                size="lg"
                className="w-full sm:w-auto"
                icon={<ArrowRight size={18} className="rtl:-scale-x-100" />}
              >
                {t("hero.ctaPrimary")}
              </Button>
            </Link>
            <Link to="/scan" className="sm:w-auto">
              {/* Outlined-on-paper: white fill, thin ink border. */}
              <Button
                size="lg"
                variant="secondary"
                className="w-full border-ink/20 bg-panel hover:border-ink/45 hover:bg-panel sm:w-auto"
              >
                {t("hero.ctaSecondary")}
              </Button>
            </Link>
          </motion.div>

          {/* Trust row — every item here is true of this codebase. */}
          <motion.ul
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.6 }}
            className="mt-8 flex flex-wrap gap-x-5 gap-y-2.5 text-[13px] font-medium text-ink-muted sm:text-sm"
          >
            {TRUST.map((b) => (
              <li key={b.key} className="flex items-center gap-1.5">
                <b.icon size={15} className="shrink-0 text-mint" /> {t(`hero.${b.key}`)}
              </li>
            ))}
          </motion.ul>
        </div>

        {/* The product, shown as the product: an A4 page. */}
        <motion.div
          ref={docRef}
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2, ease: EASE }}
          className="relative mx-auto w-full max-w-[22rem] sm:max-w-[24rem] lg:max-w-none"
        >
          <div className="relative -rotate-[1.5deg] rounded-[6px] bg-white p-0 shadow-doc ring-1 ring-ink/[0.07] rtl:rotate-[1.5deg]">
            <ResumeMiniature
              template="classic"
              label={t("hero.docAlt")}
              className="block h-auto w-full rounded-[6px] rtl:-scale-x-100"
              flagBullet
              struck={struck}
            />
          </div>

          {/* Score chip — the before/after the scorer actually produces. */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.7, ease: EASE }}
            className="absolute -bottom-5 start-2 rounded-2xl border border-line bg-panel px-4 py-3 shadow-panel sm:-start-6"
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              {t("hero.mock.matchScore")}
            </p>
            <p className="mt-1 flex items-baseline gap-2 text-2xl font-bold tabular-nums text-ink">
              <span className="text-ink-faint">58</span>
              <ArrowRight size={16} className="text-ink-faint rtl:-scale-x-100" />
              <motion.span
                key={scored ? "on" : "off"}
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: EASE }}
                className="text-mint"
              >
                {scored ? 91 : 58}
              </motion.span>
            </p>
          </motion.div>

          {/* Guard chip — the flag the fabrication guard raises. */}
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.8, ease: EASE }}
            className="absolute -top-4 end-2 max-w-[13rem] rounded-2xl border border-line bg-panel px-3.5 py-2.5 shadow-panel sm:-end-5"
          >
            <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-danger/12 text-danger">
                <ShieldCheck size={12} />
              </span>
              {t("hero.mock.guardTitle")}
            </p>
            <p className="mt-1 text-[11px] leading-snug text-ink-muted">{t("hero.mock.guardBody")}</p>
            <AnimatePresence>
              {struck && (
                <motion.span
                  key="guard-stamp"
                  /* Clears the chip's own text and lands on the page below it,
                     which is where a stamp belongs. */
                  className="absolute -bottom-7 end-4"
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  <Stamp tone="danger" angle={-8} className="bg-panel">
                    {t("hero.mock.guardStamp")}
                  </Stamp>
                </motion.span>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
