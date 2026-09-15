import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ScanEye, ScanSearch, Contact, Mail, Send, MessageSquareText, ArrowUpRight, Wrench, Building2 } from "lucide-react";
import { TiltedCard } from "../components/ui";

// Seven cards, and nothing here is featured. The CV scan joined in Phase 30,
// when it moved from the public /scan into the app, and it leads beside the ATS
// X-ray, the other tool that reads a resume the way a machine does; seven
// leaves one card alone on the last row at both 2 and 3 columns. The ATS
// scanner used to LEAD this grid as a wide `sm:col-span-2` cell and the resume
// health check sat beside it as an ordinary card; the review replaced both, and
// it lives on the document at /app rather than on a page of its own (PLAN 28.8).
// AppLayout's `toolsSubNav` lists the same tools: check-mirrors 32(f) holds the
// two tables to one list and resolves every card's copy in both locales.
const tools = [
  { to: "/tools/scan", icon: ScanSearch, key: "scan" },
  { to: "/tools/xray", icon: ScanEye, key: "xray" },
  { to: "/tools/company-brief", icon: Building2, key: "brief" },
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
        {tools.map((tool) => (
          <Link
            key={tool.to}
            to={tool.to}
            className="block rounded-xl2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            {/* Phones get a compact tappable row (icon · title · arrow);
                the body copy and card layout appear from sm up. The flex
                wrapper is ours — SpotlightCard's className lands on its
                outer div, not around children. */}
            <TiltedCard caption={t(`cards.${tool.key}.title`)} className="h-full p-4 sm:p-6">
              <div className="flex flex-row items-center gap-3 sm:flex-col sm:items-stretch sm:gap-0">
                <div className="contents sm:mb-4 sm:flex sm:items-center sm:justify-between">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-panel-2 text-accent-soft transition-all duration-300 ease-out will-change-transform group-hover:border-accent/40 group-hover:[transform:translate3d(0,-7px,90px)] group-hover:shadow-[0_30px_46px_-14px_rgba(0,0,0,0.9)]">
                    <tool.icon size={18} />
                  </span>
                  <ArrowUpRight
                    size={18}
                    className="order-last shrink-0 text-ink-faint transition-colors group-hover:text-accent-soft rtl:-scale-x-100 sm:order-none"
                  />
                </div>
                <div className="min-w-0 flex-1 sm:flex-none">
                  <h3 className="truncate text-[15px] font-semibold text-ink sm:whitespace-normal sm:text-lg">
                    {t(`cards.${tool.key}.title`)}
                  </h3>
                  <p className="mt-2 hidden text-sm leading-relaxed text-ink-muted sm:block">
                    {t(`cards.${tool.key}.body`)}
                  </p>
                </div>
              </div>
            </TiltedCard>
          </Link>
        ))}
      </div>
    </div>
  );
}
