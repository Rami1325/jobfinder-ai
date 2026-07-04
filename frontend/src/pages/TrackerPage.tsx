import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import {
  Award,
  ClipboardList,
  Download,
  ExternalLink,
  Eye,
  Layers,
  MessageSquare,
  MessagesSquare,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  deleteApplication,
  downloadResume,
  resumeFilename,
  getApplication,
  listApplications,
  updateApplication,
} from "../api/client";
import ResumeView from "../components/ResumeView";
import { Badge, Button, Card, Modal, ProgressRing, Skeleton, useToast } from "../components/ui";
import { cn } from "../lib/cn";
import type { ApplicationDetail, ApplicationOut } from "../types";

// Column labels come from the "tracker" catalog via `status.<key>`.
const COLUMNS: {
  key: string;
  tone: "neutral" | "accent" | "partial" | "mint" | "danger";
  bar: string;
  dot: string;
}[] = [
  { key: "saved", tone: "neutral", bar: "bg-ink-faint/40", dot: "bg-ink-faint" },
  { key: "applied", tone: "accent", bar: "bg-gradient-to-r from-accent to-accent/30", dot: "bg-accent" },
  { key: "interview", tone: "partial", bar: "bg-gradient-to-r from-warn to-warn/30", dot: "bg-warn" },
  { key: "offer", tone: "mint", bar: "bg-gradient-to-r from-mint to-mint/30", dot: "bg-mint" },
  { key: "rejected", tone: "danger", bar: "bg-gradient-to-r from-danger to-danger/30", dot: "bg-danger" },
];

const STATUSES = COLUMNS.map((c) => c.key);
/** Statuses that mean the application was actually submitted. */
const SUBMITTED = new Set(["applied", "interview", "offer", "rejected"]);

export default function TrackerPage() {
  const { t } = useTranslation("tracker");
  const [apps, setApps] = useState<ApplicationOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const toast = useToast();

  async function refresh() {
    setLoading(true);
    try {
      setApps(await listApplications());
    } catch {
      setError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const metrics = useMemo(() => {
    const total = apps.length;
    const applied = apps.filter((a) => SUBMITTED.has(a.status || "saved")).length;
    const interviews = apps.filter((a) => a.interviewed).length;
    const offers = apps.filter((a) => a.status === "offer").length;
    const declined = apps.filter((a) => a.status === "rejected").length;
    const interviewRate = applied > 0 ? (interviews / applied) * 100 : 0;
    return { total, applied, interviews, offers, declined, interviewRate };
  }, [apps]);

  async function changeStatus(id: number, status: string) {
    const updated = await updateApplication(id, { status });
    setApps((prev) => prev.map((a) => (a.id === id ? updated : a)));
  }

  async function toggleInterviewed(a: ApplicationOut) {
    const next = !a.interviewed;
    // Optimistic — metrics are derived from state, so they update instantly.
    setApps((prev) => prev.map((x) => (x.id === a.id ? { ...x, interviewed: next } : x)));
    try {
      const updated = await updateApplication(a.id, { interviewed: next });
      setApps((prev) => prev.map((x) => (x.id === a.id ? updated : x)));
    } catch {
      setApps((prev) => prev.map((x) => (x.id === a.id ? { ...x, interviewed: !next } : x)));
      toast("error", t("toasts.interviewedError"));
    }
  }

  async function remove(id: number) {
    await deleteApplication(id);
    setApps((prev) => prev.filter((a) => a.id !== id));
    toast("info", t("toasts.deleted"));
  }

  async function view(id: number) {
    setOpen(true);
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await getApplication(id));
    } finally {
      setDetailLoading(false);
    }
  }

  const tiles: { label: string; value: number; icon: typeof Layers; iconCls: string }[] = [
    { label: t("tiles.total"), value: metrics.total, icon: Layers, iconCls: "bg-accent/12 text-accent" },
    { label: t("tiles.applied"), value: metrics.applied, icon: Send, iconCls: "bg-accent/12 text-accent" },
    { label: t("tiles.interviews"), value: metrics.interviews, icon: MessagesSquare, iconCls: "bg-mint/12 text-mint" },
    { label: t("tiles.offers"), value: metrics.offers, icon: Award, iconCls: "bg-mint/12 text-mint" },
    { label: t("tiles.declined"), value: metrics.declined, icon: XCircle, iconCls: "bg-danger/12 text-danger" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">{t("title")}</h1>
          <p className="mt-1 text-sm text-ink-muted">{t("sub", { count: apps.length })}</p>
        </div>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {/* ── Metrics header ─────────────────────────────────────────────── */}
      {loading ? (
        <Skeleton className="h-36" />
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <Card glow className="relative overflow-hidden p-0">
            <div className="absolute inset-x-0 top-0 h-[2px] bg-accent-gradient" aria-hidden />
            <div className="flex flex-col gap-6 p-5 sm:p-6 lg:flex-row lg:items-center">
              <div className="grid flex-1 grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-5">
                {tiles.map((tile, i) => (
                  <motion.div
                    key={tile.label}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.06 * i, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                    className="flex items-center gap-3"
                  >
                    <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", tile.iconCls)}>
                      <tile.icon size={17} />
                    </span>
                    <div className="min-w-0">
                      <div className="text-2xl font-bold leading-none tabular-nums text-ink">{tile.value}</div>
                      <div className="mt-1 truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                        {tile.label}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
              <div className="flex items-center justify-center border-line lg:border-s lg:ps-6">
                <ProgressRing
                  value={metrics.interviewRate}
                  size={104}
                  stroke={9}
                  tone="mint"
                  sublabel={t("interviewRate")}
                />
              </div>
            </div>
          </Card>
        </motion.div>
      )}

      {/* ── Board ──────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : apps.length === 0 ? (
        <Card className="animate-fade-up py-12 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/12 text-accent">
            <ClipboardList size={22} />
          </span>
          <p className="mt-4 text-sm font-semibold text-ink">{t("empty.title")}</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-muted">
            <Trans
              t={t}
              i18nKey="empty.body"
              components={[
                <span key="0" />,
                <Link key="1" to="/jobs" className="font-medium text-accent hover:underline" />,
                <span key="2" />,
                <Link key="3" to="/app" className="font-medium text-accent hover:underline" />,
              ]}
            />
          </p>
        </Card>
      ) : (
        <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-4 md:mx-0 md:grid md:snap-none md:overflow-visible md:px-0 md:pb-0 md:grid-cols-2 xl:grid-cols-5">
          {COLUMNS.map((col) => {
            const items = apps.filter((a) => (a.status || "saved") === col.key);
            return (
              <div key={col.key} className="flex w-[82vw] max-w-[320px] shrink-0 snap-start flex-col overflow-hidden rounded-2xl border border-line/60 bg-panel/40 md:w-auto md:max-w-none">
                <div className={cn("h-[2px] w-full", col.bar)} aria-hidden />
                <div className="flex items-center justify-between px-3 pb-1 pt-3">
                  <div className="flex items-center gap-2">
                    <span className={cn("h-1.5 w-1.5 rounded-full", col.dot)} aria-hidden />
                    <Badge tone={col.tone}>{t(`status.${col.key}`)}</Badge>
                  </div>
                  <span className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink-muted">
                    {items.length}
                  </span>
                </div>
                <div className="flex flex-col gap-3 p-3">
                  {items.length === 0 && (
                    <p className="rounded-xl border border-dashed border-line/70 px-3 py-4 text-center text-xs text-ink-faint">
                      {t("columnEmpty")}
                    </p>
                  )}
                  <AnimatePresence initial={false}>
                    {items.map((a, i) => {
                      const submitted = SUBMITTED.has(a.status || "saved");
                      return (
                        <motion.div
                          key={a.id}
                          layout
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.96 }}
                          transition={{ delay: Math.min(i * 0.04, 0.3), duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                          className="group rounded-xl border border-line bg-gradient-to-b from-panel to-panel/70 p-3.5 shadow-card transition-all duration-200 hover:border-accent/40 hover:shadow-glow"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-ink">{a.job_title || "—"}</p>
                              <p className="truncate text-xs text-ink-muted">{a.company || "—"}</p>
                            </div>
                            <span
                              className={cn(
                                "shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums",
                                a.overall_score >= 80
                                  ? "bg-mint/15 text-mint"
                                  : a.overall_score >= 60
                                    ? "bg-warn/15 text-warn"
                                    : "bg-panel-2 text-ink-muted",
                              )}
                            >
                              {Math.round(a.overall_score)}%
                            </span>
                          </div>

                          <div className="mt-2 flex items-center justify-between gap-2">
                            <span className="text-[11px] text-ink-faint">{a.created_at?.slice(0, 10)}</span>
                            {submitted && (
                              <button
                                onClick={() => toggleInterviewed(a)}
                                title={t("interviewedToggle")}
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
                                  a.interviewed
                                    ? "border-mint/50 bg-mint/15 text-mint"
                                    : "border-line bg-panel-2 text-ink-faint hover:border-mint/40 hover:text-ink-muted",
                                )}
                              >
                                <MessageSquare size={11} />
                                {t("interviewed")}
                              </button>
                            )}
                          </div>

                          <div className="mt-3 flex items-center gap-1.5">
                            <select
                              value={a.status}
                              onChange={(e) => changeStatus(a.id, e.target.value)}
                              className="min-w-0 flex-1 cursor-pointer rounded-lg border border-line bg-bg-soft px-2 py-1.5 text-xs text-ink transition-colors hover:border-accent/40 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/30"
                            >
                              {STATUSES.map((s) => (
                                <option key={s} value={s}>
                                  {t(`status.${s}`)}
                                </option>
                              ))}
                            </select>
                            {a.job_url && (
                              <a
                                href={a.job_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={t("actions.openJob")}
                                className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-line p-1.5 text-ink-muted transition-colors hover:border-accent/50 hover:text-accent md:min-h-0 md:min-w-0"
                              >
                                <ExternalLink size={15} />
                              </a>
                            )}
                            <button
                              onClick={() => view(a.id)}
                              title={t("actions.view")}
                              className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-line p-1.5 text-ink-muted transition-colors hover:border-accent/50 hover:text-ink md:min-h-0 md:min-w-0"
                            >
                              <Eye size={15} />
                            </button>
                            <button
                              onClick={() => remove(a.id)}
                              title={t("actions.delete")}
                              className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-line p-1.5 text-ink-muted transition-colors hover:border-danger/50 hover:text-danger md:min-h-0 md:min-w-0"
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={
          detail
            ? `${detail.job_title || t("modal.resumeFallback")}${detail.company ? " · " + detail.company : ""}`
            : t("modal.loading")
        }
      >
        {detailLoading && <Skeleton className="h-64 w-full" />}
        {detail && (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <Badge tone="accent">{t("modal.match", { pct: Math.round(detail.overall_score) })}</Badge>
              {detail.interviewed && (
                <Badge tone="mint">
                  <MessageSquare size={11} /> {t("interviewed")}
                </Badge>
              )}
              {detail.job_url && (
                <a
                  href={detail.job_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t("actions.openJob")}
                  className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                >
                  <ExternalLink size={13} /> {t("modal.jobPosting")}
                </a>
              )}
              <div className="flex-1" />
              {detail.tailored_resume && (
                <>
                  <Button
                    size="sm"
                    icon={<Download size={15} />}
                    onClick={() =>
                      downloadResume(
                        detail.tailored_resume!,
                        "docx",
                        resumeFilename(detail.tailored_resume!.contact.name, detail.company),
                      )
                    }
                  >
                    .docx
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Download size={15} />}
                    onClick={() =>
                      downloadResume(
                        detail.tailored_resume!,
                        "pdf",
                        resumeFilename(detail.tailored_resume!.contact.name, detail.company),
                      )
                    }
                  >
                    .pdf
                  </Button>
                </>
              )}
            </div>
            {detail.tailored_resume ? (
              <ResumeView resume={detail.tailored_resume} />
            ) : (
              <p className="text-sm text-ink-muted">{t("modal.noResume")}</p>
            )}
            {detail.cover_letter && (
              <>
                <h3 className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                  {t("modal.coverLetter")}
                </h3>
                <div className="whitespace-pre-wrap break-words rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink">
                  {detail.cover_letter}
                </div>
              </>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
