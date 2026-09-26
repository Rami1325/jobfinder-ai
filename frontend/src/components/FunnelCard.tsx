import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Footprints } from "lucide-react";
import { getFunnel } from "../api/client";
import { apiErrorMessage } from "../lib/apiError";
import { cn } from "../lib/cn";
import { Card, CardTitle, Skeleton } from "./ui";
import type { FunnelOut } from "../types";

/**
 * Each person's first steps, for the admin (PLAN 31.8): whether the first run
 * helps. The server records the first time each step is reached and nothing
 * else (`db/funnel.py`), so this is a list of names, dates and ticks. The step
 * order is the server's (`order`), and a step not reached is drawn faint, never
 * as a zero: nobody is "0" at a step they have not reached yet.
 */
export default function FunnelCard() {
  const { t, i18n } = useTranslation("settings");
  const [data, setData] = useState<FunnelOut | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    getFunnel()
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(apiErrorMessage(e, t("funnel.loadError"))));
    return () => {
      alive = false;
    };
  }, [t]);

  // One literal key per step (never a template-literal key): a step the server
  // adds before this file knows it is shown by its own name.
  const label = (step: string) => {
    switch (step) {
      case "signed_up":
        return t("funnel.steps.signed_up");
      case "uploaded":
        return t("funnel.steps.uploaded");
      case "searched":
        return t("funnel.steps.searched");
      case "tailored":
        return t("funnel.steps.tailored");
      case "downloaded":
        return t("funnel.steps.downloaded");
      case "application":
        return t("funnel.steps.application");
      case "returned":
        return t("funnel.steps.returned");
      default:
        return step;
    }
  };
  const day = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString(i18n.language === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "short" });
  };

  return (
    <Card>
      <CardTitle className="flex items-center gap-2">
        <Footprints size={16} className="text-accent-soft" /> {t("funnel.title")}
      </CardTitle>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{t("funnel.body")}</p>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      {!data && !error && <Skeleton className="mt-3 h-24 w-full" />}
      {data && data.people.length === 0 && <p className="mt-3 text-sm text-ink-muted">{t("funnel.none")}</p>}
      {data && data.people.length > 0 && (
        <ul className="mt-3 space-y-3">
          {data.people.map((p) => {
            const at = (step: string) => (step === "signed_up" ? p.signed_up : p.steps[step] ?? "");
            return (
              <li key={p.id} className="rounded-lg border border-line bg-bg-soft/60 px-3 py-2.5">
                <p className="text-sm font-semibold text-ink" dir="auto">
                  {p.name || `#${p.id}`}
                  {p.is_admin && <span className="ms-2 text-xs font-normal text-ink-faint">{t("funnel.admin")}</span>}
                </p>
                <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                  {data.order.map((step) => {
                    const when = at(step);
                    return (
                      <li
                        key={step}
                        className={cn("inline-flex items-center gap-1 text-xs", when ? "text-ink" : "text-ink-faint")}
                      >
                        {when && <Check size={12} className="text-mint" aria-hidden />}
                        {label(step)}
                        {when && <span className="text-ink-faint">{day(when)}</span>}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
