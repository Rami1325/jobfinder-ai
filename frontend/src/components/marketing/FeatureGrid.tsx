import { Link } from "react-router-dom";
import { ArrowUpRight, Briefcase, Contact, FileText, Mail, MessageSquareText, ScanEye } from "lucide-react";
import { useTranslation } from "react-i18next";
import Reveal from "./Reveal";

const features = [
  { to: "/app", icon: FileText, key: "tailoring" },
  { to: "/interview", icon: MessageSquareText, key: "interview" },
  { to: "/jobs", icon: Briefcase, key: "jobs" },
  { to: "/tools/xray", icon: ScanEye, key: "xray" },
  { to: "/tools/linkedin", icon: Contact, key: "linkedin" },
  { to: "/tools/follow-up", icon: Mail, key: "followUp" },
] as const;

export default function FeatureGrid() {
  const { t } = useTranslation("marketing");
  return (
    <section id="features" className="relative mx-auto max-w-6xl px-4 py-16 sm:py-20">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
          {t("features.kicker")}
        </p>
        <h2 className="mt-3 text-3xl font-bold tracking-[-0.025em] text-ink sm:text-[2.6rem] sm:leading-[1.1]">
          {t("features.title")}
        </h2>
        <p className="mt-4 text-base leading-relaxed text-ink-muted sm:text-lg">
          {t("features.sub")}
        </p>
      </Reveal>

      <div className="mt-12 grid gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
        {features.map((f, i) => (
          <Reveal key={f.to} delay={(i % 3) * 0.08}>
            <Link
              to={f.to}
              className="group flex h-full flex-col rounded-xl3 border border-line bg-panel p-6 shadow-card transition-all duration-300 ease-out-quint hover:-translate-y-1 hover:border-accent/40 hover:shadow-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <div className="mb-5 flex items-center justify-between">
                <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent/10 text-accent transition-colors group-hover:bg-accent group-hover:text-white">
                  <f.icon size={19} />
                </span>
                <ArrowUpRight
                  size={18}
                  className="text-ink-faint transition-colors group-hover:text-accent rtl:-scale-x-100"
                />
              </div>
              <h3 className="text-lg font-semibold text-ink">{t(`features.${f.key}.title`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t(`features.${f.key}.body`)}</p>
            </Link>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
