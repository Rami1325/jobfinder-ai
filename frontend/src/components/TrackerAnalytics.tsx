import { useMemo } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Card, CardTitle } from "./ui";
import { cn } from "../lib/cn";
import type { ApplicationOut } from "../types";

/** Statuses that mean the application was actually submitted (matches TrackerPage). */
const SUBMITTED = new Set(["applied", "interview", "offer", "rejected"]);
/** Statuses that mean the company answered (any outcome). */
const RESPONDED = new Set(["interview", "offer", "rejected"]);

const WEEKS = 8;
const BAR_AREA_PX = 128;

/** Start of the week containing `d` — Sunday, the Israeli work-week start. */
function weekStart(d: Date): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x.getTime();
}

function responded(a: ApplicationOut): boolean {
  return SUBMITTED.has(a.status || "saved") && (RESPONDED.has(a.status) || a.interviewed);
}

/**
 * Search analytics (PLAN 6): applications/week, the submitted→offer funnel
 * (callback rate made visual), and average match score per outcome — all
 * derived client-side from the tracker rows. Charts are plain flex divs, so
 * RTL layout works with no special casing.
 */
export default function TrackerAnalytics({ apps }: { apps: ApplicationOut[] }) {
  const { t, i18n } = useTranslation("tracker");
  const locale = i18n.language === "he" ? "he-IL" : "en-GB";

  const weekly = useMemo(() => {
    const thisWeek = weekStart(new Date());
    const buckets = Array.from({ length: WEEKS }, (_, i) => {
      const start = thisWeek - (WEEKS - 1 - i) * 7 * 86400_000;
      return { start, total: 0, submitted: 0 };
    });
    const byStart = new Map(buckets.map((b) => [b.start, b]));
    for (const a of apps) {
      if (!a.created_at) continue;
      const b = byStart.get(weekStart(new Date(a.created_at)));
      if (!b) continue; // older than the window
      b.total += 1;
      if (SUBMITTED.has(a.status || "saved")) b.submitted += 1;
    }
    return buckets;
  }, [apps]);
  const weeklyMax = Math.max(1, ...weekly.map((w) => w.total));

  const funnel = useMemo(() => {
    const submitted = apps.filter((a) => SUBMITTED.has(a.status || "saved"));
    return [
      { key: "submitted", count: submitted.length, tone: "bg-accent" },
      { key: "responses", count: apps.filter(responded).length, tone: "bg-accent/60" },
      { key: "interviews", count: apps.filter((a) => a.interviewed || a.status === "interview").length, tone: "bg-warn" },
      { key: "offers", count: apps.filter((a) => a.status === "offer").length, tone: "bg-mint" },
    ];
  }, [apps]);
  const submittedCount = funnel[0].count;

  const scoreRows = useMemo(() => {
    const scored = (list: ApplicationOut[]) => list.filter((a) => a.overall_score > 0);
    const avg = (list: ApplicationOut[]) =>
      list.length ? list.reduce((s, a) => s + a.overall_score, 0) / list.length : 0;
    const buckets: { key: string; label: string; apps: ApplicationOut[]; tone: string }[] = [
      { key: "offer", label: t("status.offer"), apps: apps.filter((a) => a.status === "offer"), tone: "bg-mint" },
      { key: "interview", label: t("status.interview"), apps: apps.filter((a) => a.status === "interview"), tone: "bg-warn" },
      { key: "rejected", label: t("status.rejected"), apps: apps.filter((a) => a.status === "rejected"), tone: "bg-danger" },
      {
        key: "noResponse",
        label: t("analytics.score.noResponse"),
        apps: apps.filter((a) => a.status === "applied" && !a.interviewed),
        tone: "bg-accent/60",
      },
      { key: "saved", label: t("status.saved"), apps: apps.filter((a) => (a.status || "saved") === "saved"), tone: "bg-ink-faint/50" },
    ];
    return buckets
      .map((b) => ({ ...b, apps: scored(b.apps) }))
      .filter((b) => b.apps.length > 0)
      .map((b) => ({ key: b.key, label: b.label, tone: b.tone, count: b.apps.length, avg: avg(b.apps) }));
  }, [apps, t]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="grid gap-4 lg:grid-cols-2"
    >
      {/* ── Applications per week ─────────────────────────────────────── */}
      <Card className="lg:col-span-2">
        <CardTitle>{t("analytics.weekly.title")}</CardTitle>
        <p className="mt-1 text-xs text-ink-muted">{t("analytics.weekly.hint")}</p>
        {apps.length === 0 ? (
          <p className="mt-6 text-sm text-ink-faint">{t("analytics.weekly.empty")}</p>
        ) : (
          <>
            <div className="mt-5 flex items-end gap-2 sm:gap-3" style={{ height: BAR_AREA_PX + 20 }}>
              {weekly.map((w) => {
                const totalPx = Math.round((w.total / weeklyMax) * BAR_AREA_PX);
                const submittedPx = Math.round((w.submitted / weeklyMax) * BAR_AREA_PX);
                return (
                  <div key={w.start} className="flex flex-1 flex-col items-center justify-end gap-1">
                    {w.total > 0 && (
                      <span className="text-[11px] font-semibold tabular-nums text-ink-muted">{w.total}</span>
                    )}
                    <div
                      className="flex w-full max-w-12 flex-col justify-end overflow-hidden rounded-t-md bg-transparent"
                      style={{ height: totalPx }}
                      title={`${w.total} / ${w.submitted}`}
                    >
                      <div className="w-full bg-ink-faint/25" style={{ height: totalPx - submittedPx }} />
                      <div className="w-full bg-accent" style={{ height: submittedPx }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 flex gap-2 sm:gap-3">
              {weekly.map((w) => (
                <span key={w.start} className="flex-1 text-center text-[10px] tabular-nums text-ink-faint">
                  {new Date(w.start).toLocaleDateString(locale, { day: "numeric", month: "numeric" })}
                </span>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-accent" /> {t("analytics.weekly.submitted")}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-ink-faint/25" /> {t("analytics.weekly.savedOnly")}
              </span>
            </div>
          </>
        )}
      </Card>

      {/* ── Funnel (callback rate made visual) ────────────────────────── */}
      <Card>
        <CardTitle>{t("analytics.funnel.title")}</CardTitle>
        <p className="mt-1 text-xs text-ink-muted">{t("analytics.funnel.hint")}</p>
        {submittedCount === 0 ? (
          <p className="mt-6 text-sm text-ink-faint">{t("analytics.funnel.empty")}</p>
        ) : (
          <div className="mt-5 space-y-3">
            {funnel.map((stage) => {
              const pct = Math.round((stage.count / submittedCount) * 100);
              return (
                <div key={stage.key}>
                  <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                    <span className="font-medium text-ink">{t(`analytics.funnel.${stage.key}`)}</span>
                    <span className="tabular-nums text-ink-muted">
                      {stage.count}
                      {stage.key !== "submitted" && (
                        <span className="text-ink-faint"> · {t("analytics.funnel.ofSubmitted", { pct })}</span>
                      )}
                    </span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full" style={{ background: "rgb(var(--ring-track))" }}>
                    <motion.div
                      className={cn("h-full rounded-full", stage.tone)}
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.max(pct, stage.count > 0 ? 3 : 0)}%` }}
                      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ── Match score vs. outcome ───────────────────────────────────── */}
      <Card>
        <CardTitle>{t("analytics.score.title")}</CardTitle>
        <p className="mt-1 text-xs text-ink-muted">{t("analytics.score.hint")}</p>
        {scoreRows.length === 0 ? (
          <p className="mt-6 text-sm text-ink-faint">{t("analytics.score.empty")}</p>
        ) : (
          <div className="mt-5 space-y-3">
            {scoreRows.map((row) => (
              <div key={row.key}>
                <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                  <span className="font-medium text-ink">{row.label}</span>
                  <span className="tabular-nums text-ink-muted">
                    {t("analytics.score.avg", { score: Math.round(row.avg) })}
                    <span className="text-ink-faint"> · {t("analytics.score.count", { count: row.count })}</span>
                  </span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full" style={{ background: "rgb(var(--ring-track))" }}>
                  <motion.div
                    className={cn("h-full rounded-full", row.tone)}
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.round(row.avg)}%` }}
                    transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </motion.div>
  );
}
