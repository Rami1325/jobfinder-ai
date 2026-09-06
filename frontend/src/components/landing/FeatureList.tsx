import { useId } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Contact,
  FileText,
  Mail,
  MessagesSquare,
  ScanLine,
  Target,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Eyebrow, Rise, Section } from "./ui";

/**
 * The six tools, as a list of destinations rather than six floating cards.
 *
 * Every `to` here is a route `App.tsx` already declares; this section is a
 * navigation contract, not a place to invent product surfaces. The whole row
 * is one link, so the target is the row and not the 14px arrow at the end of
 * it — and the arrow moves on hover and on FOCUS, so a keyboard user gets the
 * same signal a mouse user does.
 */

interface Feature {
  key: string;
  to: string;
  icon: LucideIcon;
}

const FEATURES: Feature[] = [
  { key: "tailoring", to: "/app", icon: FileText },
  { key: "interview", to: "/interview", icon: MessagesSquare },
  { key: "jobs", to: "/jobs", icon: Target },
  { key: "xray", to: "/tools/xray", icon: ScanLine },
  { key: "linkedin", to: "/tools/linkedin", icon: Contact },
  { key: "followUp", to: "/tools/follow-up", icon: Mail },
];

export default function FeatureList() {
  const { t } = useTranslation("marketing");
  const headingId = useId();

  return (
    <Section id="features" labelledBy={headingId}>
      <Rise className="max-w-[680px]">
        <Eyebrow>{t("landing.features.eyebrow")}</Eyebrow>
        <h2 id={headingId} className="lp-h2 mt-4 text-[2rem] text-ink sm:text-[2.75rem] lg:text-[3.25rem]">
          {t("landing.features.title")}
        </h2>
        <p className="mt-5 max-w-[56ch] text-[17px] leading-relaxed text-ink-muted">
          {t("landing.features.sub")}
        </p>
      </Rise>

      <Rise className="mt-12 md:mt-16">
        <ul className="grid border-t border-line md:grid-cols-2 md:gap-x-14">
          {FEATURES.map((f) => (
            <li key={f.key} className="border-b border-line">
              <Link
                to={f.to}
                className="group flex min-h-[88px] items-start gap-4 py-6 pe-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line text-ink-muted transition-colors group-hover:border-ink/30 group-hover:text-ink">
                  <f.icon size={16} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[19px] font-medium leading-snug text-ink sm:text-[21px]">
                    {t(`features.${f.key}.title`)}
                  </span>
                  <span className="mt-1.5 block max-w-[42ch] text-[15px] leading-relaxed text-ink-muted">
                    {t(`landing.features.${f.key}`)}
                  </span>
                </span>
                <ArrowRight
                  size={17}
                  aria-hidden
                  className="mt-2 shrink-0 text-ink-faint transition-transform duration-150 ease-out-quint group-hover:translate-x-[3px] group-focus-visible:translate-x-[3px] rtl:-scale-x-100 rtl:group-hover:-translate-x-[3px] rtl:group-focus-visible:-translate-x-[3px]"
                />
              </Link>
            </li>
          ))}
        </ul>
      </Rise>
    </Section>
  );
}
