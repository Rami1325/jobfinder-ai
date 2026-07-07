import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ScanLine, Contact, Mail, Send, MessageSquareText, ArrowUpRight, Wrench } from "lucide-react";
import { SpotlightCard } from "../components/ui";

const tools = [
  { to: "/tools/outreach", icon: Send, key: "outreach" },
  { to: "/tools/screening", icon: MessageSquareText, key: "screening" },
  { to: "/tools/ats", icon: ScanLine, key: "ats" },
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
        <p className="mt-1 text-sm text-ink-muted">{t("sub")}</p>
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {tools.map((tool) => (
          <Link
            key={tool.to}
            to={tool.to}
            className="block rounded-xl2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <SpotlightCard className="flex h-full flex-col p-6">
              <div className="mb-4 flex items-center justify-between">
                <span className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-panel-2 text-accent-soft transition-colors group-hover:border-accent/40">
                  <tool.icon size={18} />
                </span>
                <ArrowUpRight size={18} className="text-ink-faint transition-colors group-hover:text-accent-soft rtl:-scale-x-100" />
              </div>
              <h3 className="text-lg font-semibold text-ink">{t(`cards.${tool.key}.title`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t(`cards.${tool.key}.body`)}</p>
            </SpotlightCard>
          </Link>
        ))}
      </div>
    </div>
  );
}
