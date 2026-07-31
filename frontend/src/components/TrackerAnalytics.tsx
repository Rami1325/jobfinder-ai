import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Card, CardTitle, CountUp, SectionLabel, Sparkline } from "./ui";
import { cn } from "../lib/cn";
import type { ApplicationOut } from "../types";

/** Statuses that mean the application was actually submitted (matches TrackerPage). */
const SUBMITTED = new Set(["applied", "interview", "offer", "rejected"]);
/** Statuses that mean the company answered (any outcome). */
const RESPONDED = new Set(["interview", "offer", "rejected"]);

const WEEKS = 8;
const BAR_AREA_PX = 128;
const ACTIVITY_ROWS = 6;

/** "What's converting" thresholds. Reply rates over a handful of applications
 * are noise, and a dimension with one group compares nothing — both would read
 * as findings, so both are withheld rather than shown with a caveat. */
const MIN_PANEL = 8;
const MIN_GROUP = 3;
const MIN_GROUPS_PER_DIM = 2;

/** Match-score bands, best first. */
const SCORE_BANDS = [
  { key: "85+", min: 85 },
  { key: "75–84", min: 75 },
  { key: "60–74", min: 60 },
  { key: "< 60", min: 0 },
];

/** Status → dot / text tones for the activity log (mirrors the board columns). */
const STATUS_DOT: Record<string, string> = {
  saved: "bg-ink-faint",
  applied: "bg-accent",
  interview: "bg-warn",
  offer: "bg-mint",
  rejected: "bg-danger",
};
const STATUS_TEXT: Record<string, string> = {
  saved: "text-ink-muted",
  applied: "text-accent",
  interview: "text-warn",
  offer: "text-mint",
  rejected: "text-danger",
};

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

/** "2 days ago" / "לפני יומיים" — coarse relative timestamp for the activity log. */
function relativeTime(iso: string, locale: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const mins = Math.round((ts - Date.now()) / 60_000);
  if (Math.abs(mins) < 60) return rtf.format(mins, "minute");
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return rtf.format(days, "day");
  return rtf.format(Math.round(days / 7), "week");
}

/**
 * Search analytics (PLAN 6), restyled as mission control (DESIGN_PLAN C3):
 * a live signal strip (awaiting-reply chip + per-week sparkline trends),
 * applications/week, the submitted→offer funnel (callback rate made visual),
 * average match score per outcome, and a recent-activity log — all derived
 * client-side from the tracker rows. Charts are plain flex divs, so RTL
 * layout works with no special casing.
 */
export default function TrackerAnalytics({ apps }: { apps: ApplicationOut[] }) {
  const { t, i18n } = useTranslation("tracker");
  const locale = i18n.language === "he" ? "he-IL" : "en-GB";

  const reduce = useReducedMotion();

  const weekly = useMemo(() => {
    const thisWeek = weekStart(new Date());
    const buckets = Array.from({ length: WEEKS }, (_, i) => {
      const start = thisWeek - (WEEKS - 1 - i) * 7 * 86400_000;
      return { start, total: 0, submitted: 0, responded: 0 };
    });
    const byStart = new Map(buckets.map((b) => [b.start, b]));
    for (const a of apps) {
      if (!a.created_at) continue;
      const b = byStart.get(weekStart(new Date(a.created_at)));
      if (!b) continue; // older than the window
      b.total += 1;
      if (SUBMITTED.has(a.status || "saved")) b.submitted += 1;
      if (responded(a)) b.responded += 1;
    }
    return buckets;
  }, [apps]);
  const weeklyMax = Math.max(1, ...weekly.map((w) => w.total));
  const latestWeek = weekly[WEEKS - 1];
  const appsSeries = weekly.map((w) => w.total);
  const respSeries = weekly.map((w) => w.responded);

  /** Applied but no answer yet — the live "awaiting reply" signal. */
  const awaiting = useMemo(
    () => apps.filter((a) => a.status === "applied" && !a.interviewed).length,
    [apps],
  );

  /** Newest additions first — created_at is the only timestamp the API exposes. */
  const recent = useMemo(
    () =>
      [...apps]
        .filter((a) => a.created_at)
        .sort((x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime())
        .slice(0, ACTIVITY_ROWS),
    [apps],
  );

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

  /**
   * What's converting (PLAN 17.3): reply rate broken down by what was actually
   * sent. A row whose value is unknown — anything saved before we started
   * recording it — is excluded from that dimension entirely, never folded in
   * as a zero, so an old tracker cannot invent a finding.
   */
  const converting = useMemo(() => {
    const submitted = apps.filter((a) => SUBMITTED.has(a.status || "saved"));

    const tally = (
      keyOf: (a: ApplicationOut) => string | null,
      labelOf: (key: string) => string,
      order?: string[],
    ) => {
      const groups = new Map<string, { key: string; total: number; replied: number }>();
      for (const a of submitted) {
        const key = keyOf(a);
        if (key === null) continue; // unknown — not a value
        const g = groups.get(key) ?? { key, total: 0, replied: 0 };
        g.total += 1;
        if (responded(a)) g.replied += 1;
        groups.set(key, g);
      }
      const rows = [...groups.values()]
        .filter((g) => g.total >= MIN_GROUP)
        .map((g) => ({ ...g, label: labelOf(g.key), rate: (100 * g.replied) / g.total }));
      rows.sort((x, y) =>
        order ? order.indexOf(x.key) - order.indexOf(y.key) : y.rate - x.rate,
      );
      return rows.length >= MIN_GROUPS_PER_DIM ? rows : [];
    };

    const band = (score: number) => SCORE_BANDS.find((b) => score >= b.min)?.key ?? null;
    return {
      enough: submitted.length >= MIN_PANEL,
      dims: [
        {
          key: "score",
          rows: tally(
            (a) => (a.overall_score > 0 ? band(a.overall_score) : null),
            (k) => k,
            SCORE_BANDS.map((b) => b.key),
          ),
        },
        {
          key: "template",
          rows: tally(
            (a) => a.template || null,
            (k) => t(`download.templates.${k}.name`, { ns: "tailor", defaultValue: k }),
          ),
        },
        {
          key: "guard",
          rows: tally(
            (a) =>
              a.fabrication_flag_count === null || a.fabrication_flag_count === undefined
                ? null
                : a.fabrication_flag_count === 0
                  ? "clean"
                  : "flagged",
            (k) => t(`analytics.converting.guard.${k}`),
            ["clean", "flagged"],
          ),
        },
        {
          key: "voice",
          rows: tally(
            (a) =>
              a.voice_score === null || a.voice_score === undefined
                ? null
                : a.voice_score >= 90
                  ? "high"
                  : a.voice_score >= 70
                    ? "mid"
                    : "low",
            (k) => t(`analytics.converting.voice.${k}`),
            ["high", "mid", "low"],
          ),
        },
      ].filter((d) => d.rows.length > 0),
    };
  }, [apps, t]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="grid gap-4 lg:grid-cols-2"
    >
      {/* ── Mission-control strip: live signal + per-week trends (C3) ─── */}
      <Card className="lg:col-span-2">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <span
            className={cn(
              "inline-flex items-center gap-2 rounded-full border px-3 py-1.5",
              awaiting > 0 ? "border-accent/40 bg-accent/10" : "border-mint/40 bg-mint/10",
            )}
          >
            <span className="relative flex h-2 w-2" aria-hidden>
              {awaiting > 0 && !reduce && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
              )}
              <span
                className={cn("relative inline-flex h-2 w-2 rounded-full", awaiting > 0 ? "bg-accent" : "bg-mint")}
              />
            </span>
            <span
              className={cn(
                "text-[11px] font-semibold uppercase tracking-[0.12em]",
                awaiting > 0 ? "text-accent-soft" : "text-mint",
              )}
            >
              {awaiting > 0 ? (
                <>
                  <CountUp to={awaiting} duration={0.6} className="tabular-nums" />{" "}
                  {t("analytics.live.awaiting", { count: awaiting })}
                </>
              ) : (
                t("analytics.live.allQuiet")
              )}
            </span>
          </span>

          <div className="flex items-center gap-3">
            <div>
              <SectionLabel>{t("analytics.live.appsPerWeek")}</SectionLabel>
              <div className="mt-1 text-2xl font-bold leading-none tabular-nums text-ink">
                <CountUp to={latestWeek.total} duration={0.8} />
              </div>
            </div>
            <span className="flex text-accent">
              <Sparkline values={appsSeries} width={88} height={30} />
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div>
              <SectionLabel>{t("analytics.live.responsesPerWeek")}</SectionLabel>
              <div className="mt-1 text-2xl font-bold leading-none tabular-nums text-ink">
                <CountUp to={latestWeek.responded} duration={0.8} />
              </div>
            </div>
            <span className="flex text-mint">
              <Sparkline values={respSeries} width={88} height={30} />
            </span>
          </div>
        </div>
        <p className="mt-3 text-[11px] text-ink-faint">{t("analytics.live.trendHint")}</p>
      </Card>

      {/* ── What's converting (17.3): reply rate by what was sent ─────── */}
      <Card className="lg:col-span-2">
        <CardTitle>{t("analytics.converting.title")}</CardTitle>
        <p className="mt-1 text-xs text-ink-muted">{t("analytics.converting.hint")}</p>
        {!converting.enough || converting.dims.length === 0 ? (
          <p className="mt-6 text-sm text-ink-faint">{t("analytics.converting.notEnough")}</p>
        ) : (
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            {converting.dims.map((dim) => (
              <div key={dim.key}>
                <SectionLabel>{t(`analytics.converting.dims.${dim.key}`)}</SectionLabel>
                <ul className="mt-2 space-y-2">
                  {dim.rows.map((row) => (
                    <li key={row.key} className="flex items-center gap-3">
                      <span className="w-24 shrink-0 truncate text-xs text-ink-muted" title={row.label}>
                        {row.label}
                      </span>
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-faint/20">
                        <motion.span
                          className="block h-full rounded-full bg-accent"
                          initial={reduce ? false : { width: 0 }}
                          animate={{ width: `${row.rate}%` }}
                          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                        />
                      </span>
                      <span className="w-9 shrink-0 text-end text-xs font-semibold tabular-nums text-ink">
                        {Math.round(row.rate)}%
                      </span>
                      <span className="w-8 shrink-0 text-end text-[11px] tabular-nums text-ink-faint">
                        {t("analytics.converting.sample", { n: row.total })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

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
                      <span className="text-[11px] font-semibold tabular-nums text-ink-muted">
                        <CountUp to={w.total} duration={0.7} />
                      </span>
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
                      <CountUp to={stage.count} duration={0.7} />
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
                    {t("analytics.score.avgPrefix")}{" "}
                    <CountUp to={Math.round(row.avg)} suffix="%" duration={0.7} />
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

      {/* ── Recent activity log (C3) ──────────────────────────────────── */}
      <Card className="lg:col-span-2">
        <CardTitle>{t("analytics.activity.title")}</CardTitle>
        <p className="mt-1 text-xs text-ink-muted">{t("analytics.activity.hint")}</p>
        {recent.length === 0 ? (
          <p className="mt-6 text-sm text-ink-faint">{t("analytics.activity.empty")}</p>
        ) : (
          <ul className="mt-3 divide-y divide-line/60">
            {recent.map((a) => {
              const status = a.status || "saved";
              return (
                <li key={a.id} className="flex items-center gap-3 py-2.5">
                  <span
                    className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[status] ?? STATUS_DOT.saved)}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {a.job_title || "—"}
                    {a.company && <span className="text-ink-muted"> · {a.company}</span>}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em]",
                      STATUS_TEXT[status] ?? STATUS_TEXT.saved,
                    )}
                  >
                    {t(`status.${status}`)}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-ink-faint">
                    {relativeTime(a.created_at, locale)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </motion.div>
  );
}
