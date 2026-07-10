import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";
import { ArrowRight, ShieldCheck, Check, X, Zap, FileCheck2 } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Button, ProgressRing, Stamp } from "../ui";
import SplitText from "./SplitText";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const WORD_STAGGER = 0.08;
const wordCount = (s: string) => s.trim().split(/\s+/).length;

/**
 * E3 — the living mock's demo loop, a tiny phase machine:
 * before-ring sweeps → after-ring sweeps → the guard strikes the fabricated
 * claim and stamps it → hold ~3s → reset and repeat. Runs only while the
 * card is in view; reduced motion gets the final frame, static.
 */
type Phase = "before" | "after" | "guard" | "hold";
const PHASE_MS: Record<Phase, number> = { before: 1450, after: 1450, guard: 1200, hold: 3000 };
const NEXT_PHASE: Record<Phase, Phase> = { before: "after", after: "guard", guard: "hold", hold: "before" };

/** The blocked claim: a danger strike draws through it when the guard catches it. */
function StrikeTarget({ struck = false, children }: { struck?: boolean; children?: ReactNode }) {
  return (
    <span className="relative text-ink">
      {children}
      <motion.span
        aria-hidden
        className="absolute inset-x-0 top-1/2 -mt-px h-[2px] origin-left bg-danger rtl:origin-right"
        initial={false}
        animate={{ scaleX: struck ? 1 : 0 }}
        transition={{ duration: struck ? 0.4 : 0.2, ease: EASE }}
      />
    </span>
  );
}

export default function Hero() {
  const { t } = useTranslation("marketing");
  const reduce = useReducedMotion();

  // E1 — headline choreography: each segment picks up where the previous ended.
  const title1 = t("hero.title1");
  const title2 = t("hero.title2");
  const highlight = t("hero.titleHighlight");
  const d1 = 0.05;
  const d2 = d1 + wordCount(title1) * WORD_STAGGER;
  const d3 = d2 + wordCount(title2) * WORD_STAGGER;

  // E3 — living mock state.
  const mockRef = useRef<HTMLDivElement>(null);
  const mockInView = useInView(mockRef, { amount: 0.35 });
  const [phase, setPhase] = useState<Phase>("before");
  const [cycle, setCycle] = useState(0);
  const looping = mockInView && !reduce;

  useEffect(() => {
    if (!looping) return;
    const tid = window.setTimeout(() => {
      if (phase === "hold") setCycle((c) => c + 1);
      setPhase(NEXT_PHASE[phase]);
    }, PHASE_MS[phase]);
    return () => window.clearTimeout(tid);
  }, [phase, cycle, looping]);

  const struck = reduce ? true : phase === "guard" || phase === "hold";
  const afterRevealed = reduce ? true : phase !== "before";

  return (
    <section className="relative overflow-hidden">
      {/* Ambient background */}
      <div className="pointer-events-none absolute inset-0 bg-hero-glow" />
      <div className="pointer-events-none absolute inset-0 bg-grid-faint bg-[size:44px_44px] opacity-40 [mask-image:radial-gradient(60%_50%_at_50%_0%,#000,transparent)]" />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[42rem] -translate-x-1/2 rounded-full bg-accent/20 blur-[120px]" />

      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 lg:grid-cols-[1.1fr_0.9fr] lg:py-28">
        <div>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="mb-5 inline-flex items-center gap-2 rounded-full border border-line bg-panel/60 px-3 py-1 text-xs text-ink-muted backdrop-blur"
          >
            <ShieldCheck size={14} className="text-mint" />
            {t("hero.badge")}
          </motion.div>

          <h1 className="text-4xl font-bold leading-[1.08] tracking-tight text-ink sm:text-5xl lg:text-6xl">
            <SplitText text={title1} delay={d1} />
            <br />
            <SplitText text={title2} delay={d2} />{" "}
            <SplitText text={highlight} delay={d3} className="text-accent" />
          </h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.35, ease: EASE }}
            className="mt-5 max-w-xl text-lg text-ink-muted"
          >
            {t("hero.sub")}
            <span className="text-ink"> {t("hero.subEmphasis")}</span>
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.45, ease: EASE }}
            className="mt-8 flex flex-wrap items-center gap-3"
          >
            <Link to="/home">
              <Button size="lg" icon={<ArrowRight size={18} className="rtl:-scale-x-100" />}>
                {t("hero.ctaPrimary")}
              </Button>
            </Link>
            <a href="#how">
              <Button size="lg" variant="secondary">
                {t("hero.ctaSecondary")}
              </Button>
            </a>
          </motion.div>

          <motion.ul
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.55 }}
            className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-muted"
          >
            <li className="flex items-center gap-1.5"><Check size={15} className="text-mint" /> {t("hero.bulletNoLogin")}</li>
            <li className="flex items-center gap-1.5"><Zap size={15} className="text-mint" /> {t("hero.bulletOffline")}</li>
            <li className="flex items-center gap-1.5"><FileCheck2 size={15} className="text-mint" /> {t("hero.bulletAts")}</li>
          </motion.ul>
        </div>

        {/* Product mock — performs the pitch on a loop while visible (E3). */}
        <motion.div
          ref={mockRef}
          initial={{ opacity: 0, y: 30, rotate: -1 }}
          animate={{ opacity: 1, y: 0, rotate: 0 }}
          transition={{ duration: 0.8, delay: 0.2, ease: EASE }}
          className="relative"
        >
          <div className="rounded-xl2 border border-line bg-panel/70 p-5 shadow-panel backdrop-blur-xl">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">{t("hero.mock.matchScore")}</p>
              <span className="inline-flex items-center gap-1 rounded-full border border-mint/50 bg-mint/15 px-2 py-0.5 text-xs text-mint">
                <ShieldCheck size={12} /> {t("hero.mock.verified")}
              </span>
            </div>
            <div className="flex items-center justify-around">
              <div className="text-center">
                {/* Changing the key remounts the ring, re-running its sweep. */}
                <ProgressRing
                  key={reduce ? "before" : `before-${cycle}`}
                  value={58}
                  size={92}
                  stroke={9}
                  tone="accent"
                  label={t("hero.mock.before")}
                />
              </div>
              <ArrowRight className="text-ink-faint rtl:-scale-x-100" />
              <div className="text-center">
                <ProgressRing
                  key={reduce ? "after" : `after-${cycle}-${afterRevealed ? "on" : "off"}`}
                  value={afterRevealed ? 91 : 0}
                  size={92}
                  stroke={9}
                  tone="mint"
                  label={t("hero.mock.after")}
                />
              </div>
            </div>

            <div className="mt-5 space-y-2">
              <div className="flex items-center gap-2 rounded-lg border border-mint/30 bg-mint/10 px-3 py-2 text-sm">
                <Check size={15} className="shrink-0 text-mint" />
                <span className="text-ink-muted">
                  <Trans t={t} i18nKey="hero.mock.emphasized" components={[<span key="0" />, <span key="1" className="text-ink" />]} />
                </span>
              </div>
              <div className="relative flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm">
                <X size={15} className="shrink-0 text-danger" />
                <span className="text-ink-muted">
                  <Trans t={t} i18nKey="hero.mock.blocked" components={[<span key="0" />, <StrikeTarget key="1" struck={struck} />]} />
                </span>
                <AnimatePresence>
                  {struck && (
                    <motion.span
                      key="guard-stamp"
                      className="absolute -end-2 -top-3"
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.18 }}
                    >
                      <Stamp tone="danger" angle={-10}>
                        {t("hero.mock.guardStamp")}
                      </Stamp>
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
          <div className="pointer-events-none absolute -inset-4 -z-10 rounded-[2rem] bg-accent/10 blur-2xl" />
        </motion.div>
      </div>
    </section>
  );
}
