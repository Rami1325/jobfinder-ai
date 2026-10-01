import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";

export default function ToolShell({
  title,
  subtitle,
  icon,
  back,
  children,
}: {
  title: string;
  subtitle: string;
  icon: ReactNode;
  /** A tool opened from a job's page returns there (PLAN 31.4/3,
   * `useJobContext`). Without one, Back is the tools list, as before. */
  back?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation("tools");
  return (
    <div className="space-y-6">
      <div>
        <Link
          to={back ?? "/tools"}
          className="tap-44 mb-3 inline-flex min-h-9 items-center gap-1 text-xs text-ink-muted hover:text-ink"
        >
          <ArrowLeft size={13} className="rtl:-scale-x-100" /> {back ? t("backToJob") : t("back")}
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
          {icon} {title}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}
