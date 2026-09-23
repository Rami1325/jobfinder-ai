import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import {
  Award,
  BarChart3,
  ClipboardList,
  Clock,
  Download,
  ExternalLink,
  Eye,
  KanbanSquare,
  Layers,
  Mail,
  MessageSquare,
  MessagesSquare,
  Send,
  Star,
  StickyNote,
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
  getStaleApplications,
  type ResumeTemplate,
} from "../api/client";
import ResumeView from "../components/ResumeView";
import TrackerAnalytics from "../components/TrackerAnalytics";
import EmailTimeline from "../components/inbox/EmailTimeline";
import InboxBar from "../components/inbox/InboxBar";
import { AppliedBadge, CardDate, CardEmailBadge } from "../components/inbox/shared";
import { Badge, Button, Card, CardTitle, CountUp, Modal, ProgressRing, Skeleton, useToast } from "../components/ui";
import { cn } from "../lib/cn";
import { TEMPLATE_IDS } from "../lib/templateSpecs";
import { useTrackerMetrics, SUBMITTED } from "../hooks/useTrackerMetrics";
import type { ApplicationDetail, ApplicationOut, StaleApplication } from "../types";

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

// Which follow-up stage to pre-select when jumping to the follow-up writer.
/** The template this application was SENT in, for a re-download from the
 * tracker. The row records it (`sentSignals`), and the downloads ignored it and
 * rendered the default, so a CV sent as Executive came back as Standard
 * (PLAN 31.1/8). "" (a row from before 17.3) or an id this build does not know
 * is `undefined`, which renders the default. */
function sentTemplate(template: string): ResumeTemplate | undefined {
  return (TEMPLATE_IDS as readonly string[]).includes(template) ? (template as ResumeTemplate) : undefined;
}

function followUpStage(status: string): string {
  if (status === "interview") return "after an interview";
  if (status === "offer") return "after an offer";
  return "after applying";
}

/** 1-5 excitement stars (Teal pattern). Clicking the current rating clears it. */
function Stars({ value, onRate }: { value: number; onRate: (n: number) => void }) {
  const { t } = useTranslation("tracker");
  return (
    <div className="flex items-center" title={t("excitement.title")}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={t("excitement.set", { count: n })}
          aria-pressed={n <= value}
          onClick={() => onRate(n === value ? 0 : n)}
          className={cn(
            "rounded p-0.5 transition-colors",
            n <= value ? "text-warn" : "text-ink-faint/60 hover:text-warn/70",
          )}
        >
          <Star size={13} fill={n <= value ? "currentColor" : "none"} />
        </button>
      ))}
    </div>
  );
}

/** Status → chip face classes (mirrors the column tones). */
const CHIP_FACES: Record<string, string> = {
  saved: "border-line bg-panel-2 text-ink-muted",
  applied: "border-accent/50 bg-accent/15 text-accent-soft",
  interview: "border-warn/50 bg-warn/15 text-warn",
  offer: "border-mint/50 bg-mint/15 text-mint",
  rejected: "border-danger/50 bg-danger/15 text-danger",
};

// Pending status flips, id → previous status. Written by changeStatus just
// before the state update re-parents the card into its new column (which
// remounts the chip), consumed by the fresh chip so it knows to flip instead
// of rendering statically. Module-level (like appsCache) because the flip must
// survive that remount. Entries are deleted when the flip finishes, so a
// StrictMode double-effect simply replays the flip once.
const pendingFlips = new Map<number, string>();

/**
 * C1 — split-flap status chip (Terminus departures-board read): on a real
 * status change the chip folds to 90° (ease-in), the face — label AND tone —
 * is swapped hard at the midpoint, and the new face snaps down (ease-out).
 * ~240 ms total. Initial renders are static; reduced motion swaps in place.
 */
function FlipStatusChip({ id, status }: { id: number; status: string }) {
  const { t } = useTranslation("tracker");
  const reduce = useReducedMotion();
  const controls = useAnimationControls();
  // If a flip is pending, first paint shows the OLD face so there is
  // something to fold away.
  const [face, setFace] = useState(() => pendingFlips.get(id) ?? status);

  useEffect(() => {
    const from = pendingFlips.get(id);
    if (from === undefined || from === status || reduce) {
      pendingFlips.delete(id);
      setFace(status);
      controls.set({ rotateX: 0 });
      return;
    }
    let cancelled = false;
    (async () => {
      // Fold the old face away… (small delay so the card's own entrance
      // doesn't hide the read)
      await controls.start({ rotateX: 90, transition: { duration: 0.09, ease: "easeIn", delay: 0.06 } });
      if (cancelled) return;
      // …swap it at the midpoint — a hard mechanical read, no crossfade…
      setFace(status);
      controls.set({ rotateX: -90 });
      // …and snap the new face down.
      await controls.start({ rotateX: 0, transition: { duration: 0.09, ease: "easeOut" } });
      if (!cancelled) pendingFlips.delete(id);
    })();
    return () => {
      cancelled = true;
      controls.stop();
    };
  }, [id, status, reduce, controls]);

  return (
    <span className="inline-block" style={{ perspective: "300px" }}>
      <motion.span
        animate={controls}
        initial={false}
        style={{ backfaceVisibility: "hidden" }}
        className={cn(
          "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold leading-none",
          CHIP_FACES[face] ?? CHIP_FACES.saved,
        )}
      >
        {t(`status.${face}`)}
      </motion.span>
    </span>
  );
}

// Module-level cache: the board's applications survive tab switches so revisits
// render instantly instead of flashing the metrics skeleton. null = never loaded.
let appsCache: ApplicationOut[] | null = null;

export default function TrackerPage() {
  const { t } = useTranslation("tracker");
  const nav = useNavigate();
  const [apps, setApps] = useState<ApplicationOut[]>(appsCache ?? []);
  // Only the first load shows the skeleton; later visits render the cache and
  // refresh in the background (no flicker when switching tabs).
  const [loading, setLoading] = useState(appsCache === null);
  const [error, setError] = useState("");
  // PLAN 22.9 — rehomed from the deleted Home dashboard. Nudges are post-send,
  // which is this page, and the /tools/follow-up handoff already lives here.
  const [nudges, setNudges] = useState<StaleApplication[]>([]);
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [notesSaving, setNotesSaving] = useState(false);
  const [tab, setTab] = useState<"board" | "analytics">("board");
  // C2 — receiving-column pulse: set on every status change, keyed by `n` so a
  // repeat move into the same column re-fires the flash.
  const [pulse, setPulse] = useState<{ col: string; n: number } | null>(null);
  const toast = useToast();

  async function refresh() {
    // No setLoading(true) here: on revisits the cache is already showing, so a
    // background refresh must not re-flash the skeleton.
    try {
      const next = await listApplications();
      appsCache = next;
      setApps(next);
      setError("");
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

  // Deliberately NOT part of refresh(): that runs again after every mutation and
  // sets `error` from t("loadError"), so a failed nudge fetch must not be able
  // to blank the board. Best-effort — the card just hides itself.
  useEffect(() => {
    let alive = true;
    getStaleApplications()
      .then((n) => alive && setNudges(n))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Keep the cache in sync with optimistic mutations (status/notes/stars/delete)
  // so returning to the board shows the latest state.
  useEffect(() => {
    if (!loading) appsCache = apps;
  }, [apps, loading]);

  const metrics = useTrackerMetrics(apps);

  async function changeStatus(id: number, status: string) {
    const from = apps.find((a) => a.id === id)?.status || "saved";
    const updated = await updateApplication(id, { status });
    // Queue the split-flap BEFORE the state update re-parents the card — the
    // remounted chip in the new column consumes it (C1).
    pendingFlips.set(id, from);
    setApps((prev) => prev.map((a) => (a.id === id ? updated : a)));
    setPulse({ col: updated.status || status, n: Date.now() });
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

  async function rate(a: ApplicationOut, n: number) {
    // Optimistic — a star tap should feel instant.
    setApps((prev) => prev.map((x) => (x.id === a.id ? { ...x, excitement: n } : x)));
    try {
      const updated = await updateApplication(a.id, { excitement: n });
      setApps((prev) => prev.map((x) => (x.id === a.id ? updated : x)));
    } catch {
      setApps((prev) => prev.map((x) => (x.id === a.id ? { ...x, excitement: a.excitement } : x)));
      toast("error", t("toasts.excitementError"));
    }
  }

  async function remove(id: number) {
    await deleteApplication(id);
    pendingFlips.delete(id);
    setApps((prev) => prev.filter((a) => a.id !== id));
    toast("info", t("toasts.deleted"));
  }

  async function view(id: number) {
    setOpen(true);
    setDetailLoading(true);
    setDetail(null);
    setNotesDraft("");
    try {
      const d = await getApplication(id);
      setDetail(d);
      setNotesDraft(d.notes);
    } finally {
      setDetailLoading(false);
    }
  }

  /** Re-read the open application after an email on it was undone. Only the
   * detail is replaced, never `notesDraft`: a half-typed note survives an undo.
   * Undoing the email that CREATED the card deletes the application, and a 404
   * then closes the modal, which has nothing left to show. */
  async function reloadDetail(id: number) {
    try {
      const d = await getApplication(id);
      setDetail((cur) => (cur?.id === id ? d : cur));
    } catch (e) {
      if ((e as { response?: { status?: number } })?.response?.status === 404) setOpen(false);
    }
  }

  async function saveNotes() {
    if (!detail) return;
    setNotesSaving(true);
    try {
      const updated = await updateApplication(detail.id, { notes: notesDraft });
      setDetail((d) => (d ? { ...d, notes: updated.notes } : d));
      setApps((prev) => prev.map((x) => (x.id === detail.id ? updated : x)));
      toast("success", t("notes.saved"));
    } catch {
      toast("error", t("notes.error"));
    } finally {
      setNotesSaving(false);
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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">{t("title")}</h1>
          <p className="mt-1 hidden text-sm text-ink-muted sm:block">{t("sub", { count: apps.length })}</p>
        </div>
        {/* Board / Analytics switch (PLAN 6: search analytics dashboard) */}
        <div className="inline-flex rounded-lg border border-line bg-panel-2 p-0.5" role="tablist">
          {(
            [
              { key: "board", icon: <KanbanSquare size={14} /> },
              { key: "analytics", icon: <BarChart3 size={14} /> },
            ] as const
          ).map((v) => (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={tab === v.key}
              onClick={() => setTab(v.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                tab === v.key ? "bg-accent text-white" : "text-ink-muted hover:text-ink",
              )}
            >
              {v.icon}
              {t(`view.${v.key}`)}
            </button>
          ))}
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
                      <div className="text-2xl font-bold leading-none tabular-nums text-ink">
                        <CountUp to={tile.value} duration={0.9} />
                      </div>
                      <div className="mt-1 truncate text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-muted sm:tracking-[0.12em]">
                        {tile.label}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
              <div className="flex items-center justify-center gap-6 border-line lg:border-s lg:ps-6">
                {/* `metrics.*Rate` is null until something has actually been
                    sent, and ProgressRing draws "—" for null. The denominator
                    rides along as the label so the rate stays checkable: "100%"
                    over one application is a very different claim from "100%"
                    over forty, and only the count says which. */}
                <ProgressRing
                  value={metrics.responseRate}
                  size={104}
                  stroke={9}
                  tone="accent"
                  label={metrics.applied > 0 ? t("ofApplied", { n: metrics.applied }) : undefined}
                  sublabel={t("responseRate")}
                />
                <ProgressRing
                  value={metrics.interviewRate}
                  size={104}
                  stroke={9}
                  tone="mint"
                  label={metrics.applied > 0 ? t("ofApplied", { n: metrics.applied }) : undefined}
                  sublabel={t("interviewRate")}
                />
              </div>
            </div>
          </Card>
        </motion.div>
      )}

      {/* Stale-application nudges: time to follow up. Outside the `loading`
          ternary on purpose — it has its own fetch and never reads `apps`. */}
      {nudges.length > 0 && (
        <Card className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-warn/12 text-warn">
            <Clock size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle>{t("nudges.title")}</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">{t("nudges.body", { count: nudges.length })}</p>
            <div className="mt-2 space-y-1.5">
              {nudges.slice(0, 3).map((n) => (
                <button
                  key={n.id}
                  onClick={() =>
                    nav("/tools/follow-up", {
                      state: {
                        company: n.company,
                        role: n.job_title,
                        stage: followUpStage(n.status),
                      },
                    })
                  }
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-start text-xs transition-colors hover:border-accent/50"
                >
                  <span className="min-w-0 flex-1 truncate text-ink" dir="auto">
                    {n.job_title || n.company || "—"}
                  </span>
                  <span className="shrink-0 text-ink-faint">
                    {t("nudges.days", { count: n.days_stale })}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Gmail sync (Phase 29). Outside the `loading` ternary for the nudges
          strip's reason: its own fetch and its own failure, never the board's.
          It calls `refresh` only when a sync actually wrote something. */}
      <InboxBar apps={apps} onChanged={refresh} />

      {/* ── Board / Analytics ──────────────────────────────────────────── */}
      {!loading && tab === "analytics" ? (
        <TrackerAnalytics apps={apps} />
      ) : loading ? (
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
                <div className="relative flex items-center justify-between px-3 pb-1 pt-3">
                  {/* C2 — one accent flash on the column that just received a card */}
                  {pulse?.col === col.key && (
                    <motion.span
                      key={pulse.n}
                      aria-hidden
                      className="pointer-events-none absolute inset-0 bg-accent/15"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: [0, 1, 0] }}
                      transition={{ duration: 0.25, ease: "easeOut" }}
                    />
                  )}
                  <div className="flex items-center gap-2">
                    <span className={cn("h-1.5 w-1.5 rounded-full", col.dot)} aria-hidden />
                    <Badge tone={col.tone}>{t(`status.${col.key}`)}</Badge>
                  </div>
                  <span className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink-muted">
                    <CountUp to={items.length} duration={0.6} />
                  </span>
                </div>
                <div className="flex flex-col gap-3 p-3">
                  {items.length === 0 && (
                    <p className="rounded-xl border border-dashed border-line/70 px-3 py-4 text-center text-xs text-ink-faint">
                      {t("columnEmpty")}
                    </p>
                  )}
                  <AnimatePresence initial={false}>
                    {items.map((a) => {
                      const submitted = SUBMITTED.has(a.status || "saved");
                      return (
                        <motion.div
                          key={a.id}
                          // C2 — shared layoutId: on a status change the card
                          // GLIDES from its old column to the new one (the old
                          // instance hands its position to this one) instead of
                          // fading out/in. Select-driven board, so the spring
                          // settle is the whole "drop" physics.
                          layoutId={`tracker-card-${a.id}`}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.96 }}
                          transition={{
                            duration: 0.25,
                            ease: [0.22, 1, 0.36, 1],
                            layout: { type: "spring", duration: 0.25, bounce: 0.15 },
                          }}
                          className="group rounded-xl border border-line bg-gradient-to-b from-panel to-panel/70 p-3.5 shadow-card transition-all duration-200 hover:border-accent/40 hover:shadow-glow"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-ink">{a.job_title || "—"}</p>
                              <p className="truncate text-xs text-ink-muted">{a.company || "—"}</p>
                            </div>
                            {/* A row that was never scored stores 0.0, so an
                                unconditional badge printed "0%" — a fabricated
                                measurement on every manually-created row, and
                                indistinguishable from a genuinely terrible
                                match. Unknown is a dash. */}
                            <span
                              className={cn(
                                "shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums",
                                !a.overall_score
                                  ? "bg-panel-2 text-ink-faint"
                                  : a.overall_score >= 80
                                    ? "bg-mint/15 text-mint"
                                    : a.overall_score >= 60
                                      ? "bg-warn/15 text-warn"
                                      : "bg-panel-2 text-ink-muted",
                              )}
                            >
                              {a.overall_score ? (
                                <CountUp to={Math.round(a.overall_score)} suffix="%" duration={0.6} />
                              ) : (
                                "—"
                              )}
                            </span>
                          </div>

                          <div className="mt-2 flex items-center justify-between gap-2">
                            <Stars value={a.excitement || 0} onRate={(n) => rate(a, n)} />
                            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                              {/* The newest email's kind, only when it adds to the
                                  column (see CardEmailBadge). Static: nothing
                                  inside a card may open over it, and the eye
                                  button below already opens the timeline. */}
                              <CardEmailBadge app={a} />
                              {a.notes && (
                                <button
                                  onClick={() => view(a.id)}
                                  title={t("notes.indicator")}
                                  className="inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] font-medium text-ink-muted transition-colors hover:border-accent/40 hover:text-ink"
                                >
                                  <StickyNote size={11} />
                                  {t("notes.chip")}
                                </button>
                              )}
                            </div>
                          </div>

                          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
                            {/* "Applied <date>" when the date it was sent is
                                known, else the day it was added (I3). */}
                            <CardDate app={a} />
                            <div className="flex items-center gap-1.5">
                              <FlipStatusChip id={a.id} status={a.status || "saved"} />
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
                          </div>

                          {/* Status select gets its own full-width row so the
                              option text is never clipped in narrow columns;
                              the actions sit below as an even icon bar. */}
                          <div className="mt-3 space-y-2">
                            <select
                              value={a.status}
                              onChange={(e) => changeStatus(a.id, e.target.value)}
                              className="w-full cursor-pointer rounded-lg border border-line bg-bg-soft px-2.5 py-1.5 text-xs text-ink transition-colors hover:border-accent/40 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/30"
                            >
                              {STATUSES.map((s) => (
                                <option key={s} value={s}>
                                  {t(`status.${s}`)}
                                </option>
                              ))}
                            </select>
                            <div className="flex items-center gap-1.5">
                              {a.job_url && (
                                <a
                                  href={a.job_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={t("actions.openJob")}
                                  aria-label={t("actions.openJob")}
                                  className="inline-flex min-h-9 flex-1 items-center justify-center rounded-lg border border-line text-ink-muted transition-colors hover:border-accent/50 hover:text-accent"
                                >
                                  <ExternalLink size={15} />
                                </a>
                              )}
                              <button
                                onClick={() => view(a.id)}
                                title={t("actions.view")}
                                aria-label={t("actions.view")}
                                className="inline-flex min-h-9 flex-1 items-center justify-center rounded-lg border border-line text-ink-muted transition-colors hover:border-accent/50 hover:text-ink"
                              >
                                <Eye size={15} />
                              </button>
                              <button
                                onClick={() => remove(a.id)}
                                title={t("actions.delete")}
                                aria-label={t("actions.delete")}
                                className="inline-flex min-h-9 flex-1 items-center justify-center rounded-lg border border-line text-ink-muted transition-colors hover:border-danger/50 hover:text-danger"
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
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
              {/* Only a scored row has a match to show. The card already renders an
                  unscored row as a dash, and every card the Gmail sync creates is
                  unscored — unconditional, this printed a made-up "Match 0%". */}
              {detail.overall_score ? (
                <Badge tone="accent">{t("modal.match", { pct: Math.round(detail.overall_score) })}</Badge>
              ) : null}
              {detail.interviewed && (
                <Badge tone="mint">
                  <MessageSquare size={11} /> {t("interviewed")}
                </Badge>
              )}
              <AppliedBadge appliedAt={detail.applied_at} />
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
              <Button
                size="sm"
                variant="secondary"
                icon={<Mail size={15} />}
                onClick={() =>
                  nav("/tools/follow-up", {
                    state: {
                      company: detail.company,
                      role: detail.job_title,
                      stage: followUpStage(detail.status),
                    },
                  })
                }
              >
                {t("actions.followUp")}
              </Button>
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
                        sentTemplate(detail.template ?? ""),
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
                        sentTemplate(detail.template ?? ""),
                      )
                    }
                  >
                    .pdf
                  </Button>
                </>
              )}
            </div>
            {/* ABOVE the resume view: see EmailTimeline for why. */}
            {detail.email_events?.length ? (
              <EmailTimeline
                events={detail.email_events}
                onUndone={() => {
                  void refresh();
                  void reloadDetail(detail.id);
                }}
              />
            ) : null}
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
              {t("notes.label")}
            </h3>
            <textarea
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              placeholder={t("notes.placeholder")}
              rows={3}
              className="w-full resize-y rounded-xl border border-line bg-bg-soft p-3 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
            <div className="mb-5 mt-2 flex justify-end">
              <Button size="sm" variant="secondary" loading={notesSaving} disabled={notesDraft === detail.notes} onClick={saveNotes}>
                {t("notes.save")}
              </Button>
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
                {/* The letter's own direction, not the UI's (see CoverLetter). */}
                <div
                  dir="auto"
                  className="whitespace-pre-wrap break-words rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink"
                >
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
