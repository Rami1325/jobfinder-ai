import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ScanLine, ScanEye, Contact, Mail, Send, MessageSquareText, ArrowUpRight, Wrench, Building2, HeartPulse } from "lucide-react";
import { cn } from "../lib/cn";
import { TiltedCard } from "../components/ui";

// Bento layout: the ATS scanner leads the grid as a wide featured cell
// (sm:col-span-2 keeps every row hole-free at 2 and 3 columns alike).
const tools = [
  { to: "/tools/ats", icon: ScanLine, key: "ats" },
  { to: "/tools/xray", icon: ScanEye, key: "xray" },
  { to: "/tools/company-brief", icon: Building2, key: "brief" },
  { to: "/tools/resume-health", icon: HeartPulse, key: "health" },
  { to: "/tools/outreach", icon: Send, key: "outreach" },
  { to: "/tools/screening", icon: MessageSquareText, key: "screening" },
  { to: "/tools/linkedin", icon: Contact, key: "linkedin" },
  { to: "/tools/follow-up", icon: Mail, key: "followup" },
] as const;

export default function ToolsPage() {
  const { t } = useTranslation("tools");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
          <Wrench className="text-accent-soft" /> {t("title")}
        </h1>
        <p className="mt-1 hidden text-sm text-ink-muted sm:block">{t("sub")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
        {tools.map((tool) => {
          const featured = tool.key === "ats";
          return (
            <Link
              key={tool.to}
              to={tool.to}
              className={cn(
                "block rounded-xl2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                featured && "sm:col-span-2",
              )}
            >
              {/* Phones get a compact tappable row (icon · title · arrow);
                  the body copy and card layout appear from sm up. The flex
                  wrapper is ours — SpotlightCard's className lands on its
                  outer div, not around children. */}
              <TiltedCard
                caption={t(`cards.${tool.key}.title`)}
                className={cn("h-full p-4", featured ? "sm:p-6 lg:p-8" : "sm:p-6")}
              >
                <div className="flex flex-row items-center gap-3 sm:flex-col sm:items-stretch sm:gap-0">
                <div className="contents sm:mb-4 sm:flex sm:items-center sm:justify-between">
                  <span
                    className={cn(
                      "grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-panel-2 text-accent-soft transition-all duration-300 ease-out will-change-transform group-hover:border-accent/40 group-hover:[transform:translate3d(0,-7px,90px)] group-hover:shadow-[0_30px_46px_-14px_rgba(0,0,0,0.9)]",
                      featured && "sm:h-12 sm:w-12",
                    )}
                  >
                    <tool.icon size={featured ? 20 : 18} />
                  </span>
                  <ArrowUpRight
                    size={18}
                    className="order-last shrink-0 text-ink-faint transition-colors group-hover:text-accent-soft rtl:-scale-x-100 sm:order-none"
                  />
                </div>
                <div className="min-w-0 flex-1 sm:flex-none">
                  <h3
                    className={cn(
                      "truncate text-[15px] font-semibold text-ink sm:whitespace-normal",
                      featured ? "sm:text-xl" : "sm:text-lg",
                    )}
                  >
                    {t(`cards.${tool.key}.title`)}
                  </h3>
                  <p
                    className={cn(
                      "mt-2 hidden leading-relaxed text-ink-muted sm:block",
                      featured ? "max-w-[58ch] text-sm lg:text-[15px]" : "text-sm",
                    )}
                  >
                    {t(`cards.${tool.key}.body`)}
                  </p>
                </div>
                </div>
              </TiltedCard>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
