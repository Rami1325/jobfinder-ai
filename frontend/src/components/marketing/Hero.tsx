import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowRight, ShieldCheck, Check, X, Zap, FileCheck2 } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Button, ProgressRing } from "../ui";

export default function Hero() {
  const { t } = useTranslation("marketing");
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

          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.05 }}
            className="text-4xl font-bold leading-[1.08] tracking-tight text-ink sm:text-5xl lg:text-6xl"
          >
            {t("hero.title1")}
            <br />
            {t("hero.title2")}{" "}
            <span className="bg-accent-gradient bg-clip-text text-transparent">{t("hero.titleHighlight")}</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.12 }}
            className="mt-5 max-w-xl text-lg text-ink-muted"
          >
            {t("hero.sub")}
            <span className="text-ink"> {t("hero.subEmphasis")}</span>
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.19 }}
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
            transition={{ duration: 0.6, delay: 0.28 }}
            className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-muted"
          >
            <li className="flex items-center gap-1.5"><Check size={15} className="text-mint" /> {t("hero.bulletNoLogin")}</li>
            <li className="flex items-center gap-1.5"><Zap size={15} className="text-mint" /> {t("hero.bulletOffline")}</li>
            <li className="flex items-center gap-1.5"><FileCheck2 size={15} className="text-mint" /> {t("hero.bulletAts")}</li>
          </motion.ul>
        </div>

        {/* Product mock */}
        <motion.div
          initial={{ opacity: 0, y: 30, rotate: -1 }}
          animate={{ opacity: 1, y: 0, rotate: 0 }}
          transition={{ duration: 0.8, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
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
                <ProgressRing value={58} size={92} stroke={9} tone="accent" label={t("hero.mock.before")} />
              </div>
              <ArrowRight className="text-ink-faint rtl:-scale-x-100" />
              <div className="text-center">
                <ProgressRing value={91} size={92} stroke={9} tone="mint" label={t("hero.mock.after")} />
              </div>
            </div>

            <div className="mt-5 space-y-2">
              <div className="flex items-center gap-2 rounded-lg border border-mint/30 bg-mint/10 px-3 py-2 text-sm">
                <Check size={15} className="shrink-0 text-mint" />
                <span className="text-ink-muted">
                  <Trans t={t} i18nKey="hero.mock.emphasized" components={[<span key="0" />, <span key="1" className="text-ink" />]} />
                </span>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm">
                <X size={15} className="shrink-0 text-danger" />
                <span className="text-ink-muted">
                  <Trans t={t} i18nKey="hero.mock.blocked" components={[<span key="0" />, <span key="1" className="text-ink line-through" />]} />
                </span>
              </div>
            </div>
          </div>
          <div className="pointer-events-none absolute -inset-4 -z-10 rounded-[2rem] bg-accent/10 blur-2xl" />
        </motion.div>
      </div>
    </section>
  );
}
