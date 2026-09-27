import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import {
  BarChart3,
  ChevronDown,
  ClipboardList,
  Clock,
  KanbanSquare,
  Loader2,
  MessageSquare,
  ShieldAlert,
  Star,
  StickyNote,
  Wand2,
} from "lucide-react";
import {
  deleteApplication,
  listApplications,
  updateApplication,
  getStaleApplications,
} from "../api/client";
import TrackerAnalytics from "../components/TrackerAnalytics";
import InboxBar from "../components/inbox/InboxBar";
import { CardDate, CardEmailBadge } from "../components/inbox/shared";
import { Badge, Button, Card, CardTitle, CountUp, Skeleton, useToast } from "../components/ui";
import { cn } from "../lib/cn";
import { kitsToReview } from "../lib/kitsReview";
import { scheduleUndoable, UNDO_MS } from "../lib/undoableDelete";
import { useTrackerMetrics, SUBMITTED } from "../hooks/useTrackerMetrics";
import { sortApps, type ListSort } from "../lib/trackerSort";
import { followUpStage } from "../hooks/useJobContext";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useNextStep } from "../hooks/useNextStep";
import { getKitsState, resumeKitQueue, subscribeKits } from "../state/kitsStore";
import type { ApplicationOut, KitOut, StaleApplication } from "../types";

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

/** One application, the same on the board and in the phone list. The status is
 * ONE tappable chip (PLAN 31.2/7): the split-flap face shows it, and a native
 * select lies over it, transparent, so a phone opens its own picker and a
 * screen reader hears "Status, Applied". The full-width select that sat under
 * every card, repeating the chip, is gone.
 *
 * The card IS the way to its job's page (PLAN 31.4): the title is a link whose
 * hit area stretches over the whole card (`after:inset-0`, inside the wrapper's
 * `relative`), and the controls that act in place (the stars, the status, the
 * Interviewed toggle) sit above it. The row of three buttons under every card,
 * the posting, the detail modal and Delete, is gone: all three live on the job's
 * page now. */
function AppCard({
  a,
  onStatus,
  onRate,
  onToggleInterviewed,
}: {
  a: ApplicationOut;
  onStatus: (id: number, status: string) => void;
  onRate: (a: ApplicationOut, n: number) => void;
  onToggleInterviewed: (a: ApplicationOut) => void;
}) {
  const { t } = useTranslation("tracker");
  const submitted = SUBMITTED.has(a.status || "saved");
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            to={`/applications/${a.id}`}
            dir="auto"
            className="block truncate text-sm font-semibold text-ink after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-accent/70"
          >
            {a.job_title || "—"}
          </Link>
          <p dir="auto" className="truncate text-xs text-ink-muted">
            {a.company || "—"}
          </p>
        </div>
        {/* A row that was never scored stores 0.0, so an unconditional badge
            printed "0%" — a fabricated measurement on every manually-created
            row, and indistinguishable from a genuinely terrible match. Unknown
            is a dash. */}
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
          {a.overall_score ? <CountUp to={Math.round(a.overall_score)} suffix="%" duration={0.6} /> : "—"}
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="relative z-10">
          <Stars value={a.excitement || 0} onRate={(n) => onRate(a, n)} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {/* The newest email's kind, only when it adds to the column (see
              CardEmailBadge). Static: a tap on it is a tap on the card, which
              opens the job's page and its emails. */}
          <CardEmailBadge app={a} />
          {a.notes && (
            <span
              title={t("notes.indicator")}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] font-medium text-ink-muted"
            >
              <StickyNote size={11} />
              {t("notes.chip")}
            </span>
          )}
        </div>
      </div>

      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2">
        {/* "Applied <date>" when the date it was sent is known, else the day it
            was added (I3). */}
        <CardDate app={a} />
        {/* The two controls WRAP, and each is a 44 px box around its small
            face. On the board's five columns a card is 179 px wide, and the
            status and "Interviewed" side by side need about 175 px of its 149,
            so a group that could not wrap pushed "Interviewed" 9 px past the
            card's edge (Applied and Interview columns, 1440 px). Wrapping moves
            it under the status only when the card is that narrow; on a phone
            and in the two-column board both stay on one line. */}
        <div className="relative z-10 flex min-w-0 flex-wrap items-center justify-end gap-x-1.5">
          <span className="relative inline-flex min-h-11 items-center gap-0.5">
            <FlipStatusChip id={a.id} status={a.status || "saved"} />
            <ChevronDown size={12} aria-hidden className="text-ink-faint" />
            <select
              value={a.status}
              aria-label={t("statusLabel")}
              onChange={(e) => onStatus(a.id, e.target.value)}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </select>
          </span>
          {submitted && (
            <button
              type="button"
              onClick={() => onToggleInterviewed(a)}
              title={t("interviewedToggle")}
              aria-pressed={a.interviewed}
              className="group/iv inline-flex min-h-11 items-center"
            >
              <span
                className={cn(
                  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
                  a.interviewed
                    ? "border-mint/50 bg-mint/15 text-mint"
                    : "border-line bg-panel-2 text-ink-faint group-hover/iv:border-mint/40 group-hover/iv:text-ink-muted",
                )}
              >
                <MessageSquare size={11} aria-hidden />
                {t("interviewed")}
              </span>
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** A draft's state → its chip face. Ready to review is the one that asks for a
 * tap, so it alone takes the accent. */
const KIT_FACES: Record<string, string> = {
  done: "border-accent/50 bg-accent/15 text-accent-soft",
  running: "border-line bg-panel-2 text-ink-muted",
  queued: "border-line bg-panel-2 text-ink-muted",
  failed: "border-danger/50 bg-danger/15 text-danger",
};

/** One batch-tailored draft waiting on its job (PLAN 31.4/5), the size of an
 * application card. Like `AppCard`, the card IS the way to its page: the title
 * is a link stretched over the card, to the draft's review, where it is
 * approved onto its job, turned down or deleted. Nothing acts in place. The
 * match is shown only for a draft that was tailored: a queued one has only the
 * search's reading, a different measurement, and the slot would mix the two. */
function KitCard({ kit }: { kit: KitOut }) {
  const { t } = useTranslation("tracker");
  const tailored = kit.status === "done";
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            to={`/kits/${kit.id}`}
            dir="auto"
            className="block truncate text-sm font-semibold text-ink after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-accent/70"
          >
            {kit.job_title || "—"}
          </Link>
          <p dir="auto" className="truncate text-xs text-ink-muted">
            {kit.company || "—"}
          </p>
        </div>
        {tailored && (
          <span className="shrink-0 rounded-md bg-panel-2 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-ink-muted">
            {Math.round(kit.score_after)}%
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold leading-none",
            KIT_FACES[kit.status] ?? KIT_FACES.queued,
          )}
        >
          {t(`review.status.${kit.status}`)}
        </span>
        {/* A warning only: no chip is not a claim that the draft is clean. */}
        {tailored && kit.flag_count > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warn">
            <ShieldAlert size={12} aria-hidden />
            {t("review.claims", { count: kit.flag_count })}
          </span>
        )}
      </div>
      {kit.status === "failed" && kit.error && (
        <p dir="auto" className="mt-1.5 line-clamp-2 text-xs text-danger">
          {kit.error}
        </p>
      )}
    </>
  );
}

/** The drafts waiting on their jobs, and the one control their queue needs: a
 * batch left queued (a reload, a dropped connection) continues from here, where
 * the Jobs page's Kits tab offered it. One copy is mounted, the phone list's
 * tab or the strip over the board. */
function ReviewList({ kits, grid }: { kits: KitOut[]; grid?: boolean }) {
  const { t } = useTranslation("tracker");
  const { batching, error } = useSyncExternalStore(subscribeKits, getKitsState);
  const queued = kits.filter((k) => k.status === "queued").length;
  return (
    <div className="space-y-3">
      {batching ? (
        <p role="status" className="flex items-center gap-2 text-xs text-ink-muted">
          <Loader2 size={14} className="animate-spin text-accent-soft" aria-hidden />
          {t("review.working")}
        </p>
      ) : (
        <>
          {queued > 0 && (
            <Button size="sm" variant="secondary" icon={<Wand2 size={14} />} onClick={() => void resumeKitQueue()}>
              {t("review.continue", { count: queued })}
            </Button>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
        </>
      )}
      <div className={cn("gap-3", grid ? "grid md:grid-cols-2 xl:grid-cols-3" : "flex flex-col")}>
        {kits.map((k) => (
          <div
            key={k.id}
            className="relative rounded-xl border border-line bg-gradient-to-b from-panel to-panel/70 p-3.5 shadow-card transition-colors hover:border-accent/40"
          >
            <KitCard kit={k} />
          </div>
        ))}
      </div>
    </div>
  );
}

// Module-level cache: the board's applications survive tab switches so revisits
// render instantly instead of flashing the metrics skeleton. null = never loaded.
let appsCache: ApplicationOut[] | null = null;

export default function TrackerPage() {
  const { t } = useTranslation("tracker");
  const { t: tCommon } = useTranslation();
  const nav = useNavigate();
  // The step after a status change (PLAN 31.5/6).
  const nextStep = useNextStep();
  const loc = useLocation();
  const [apps, setApps] = useState<ApplicationOut[]>(appsCache ?? []);
  // Only the first load shows the skeleton; later visits render the cache and
  // refresh in the background (no flicker when switching tabs).
  const [loading, setLoading] = useState(appsCache === null);
  const [error, setError] = useState("");
  // PLAN 22.9 — rehomed from the deleted Home dashboard. Nudges are post-send,
  // which is this page, and the /tools/follow-up handoff already lives here.
  const [nudges, setNudges] = useState<StaleApplication[]>([]);
  const [tab, setTab] = useState<"board" | "analytics">("board");
  // Whether the five-column board fits: `md` and up. Below it the tracker is a
  // list (PLAN 31.2/7). Read live, because only ONE of the two may be mounted:
  // both render each card, and the board's `layoutId` glide and the split-flap's
  // pending flip each assume one copy of a card on the page.
  const boardFits = useMediaQuery("(min-width: 768px)");
  // The drafts a batch tailored, waiting on their jobs (PLAN 31.4/5): the
  // phone list's first tab, and a strip over the board. The layout loads them
  // once per session and every change a page makes lands in the same store.
  const { kits } = useSyncExternalStore(subscribeKits, getKitsState);
  const toReview = useMemo(() => kitsToReview(kits), [kits]);
  // The phone list's status tab and order (PLAN 31.2/7). `null` = the first
  // status that has anything in it, so the list never opens on an empty tab
  // while another holds the user's applications. "review" is To review, which
  // a draft's page and the batch card open straight onto.
  const [listStatus, setListStatus] = useState<string | null>(() =>
    (loc.state as { show?: unknown } | null)?.show === "review" ? "review" : null,
  );
  const [listSort, setListSort] = useState<ListSort>("newest");
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
    if ((updated.status || status) !== from) nextStep(updated.status || status, id);
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

  // PLAN 31.1/6: one tap deleted an application for good, no confirm, no way
  // back. The card leaves at once and the server delete waits out the undo
  // window; Undo (or a failed delete) puts the card back where it was.
  function remove(id: number) {
    const index = apps.findIndex((a) => a.id === id);
    if (index === -1) return;
    const card = apps[index];
    setApps((prev) => prev.filter((a) => a.id !== id));
    const restore = () =>
      setApps((prev) => {
        if (prev.some((a) => a.id === id)) return prev;
        const at = Math.min(index, prev.length);
        return [...prev.slice(0, at), card, ...prev.slice(at)];
      });
    const cancel = scheduleUndoable(
      () => deleteApplication(id).then(() => pendingFlips.delete(id)),
      () => {
        restore();
        toast("error", t("toasts.deleteError"));
      },
    );
    toast("info", t("toasts.deleted"), {
      action: {
        label: tCommon("actions.undo"),
        onClick: () => {
          cancel();
          restore();
        },
      },
      durationMs: UNDO_MS,
    });
  }

  // A delete asked for on a job's page (PLAN 31.4) runs HERE, through `remove`:
  // the card leaves this list at once, the server delete waits out the undo
  // window, and Undo puts it back where it was. It waits for the list, since the
  // card has to be in it to be taken out, and runs once per request: the ref
  // survives StrictMode's second effect, and the state is cleared so a reload or
  // Back never deletes again.
  const handedOver = useRef<unknown>(null);
  const toRemove = (loc.state as { remove?: unknown } | null)?.remove;
  useEffect(() => {
    if (loading || typeof toRemove !== "number" || handedOver.current === loc.key) return;
    handedOver.current = loc.key;
    nav(".", { replace: true, state: null });
    remove(toRemove);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, toRemove, loc.key]);

  const tiles: { label: string; value: number }[] = [
    { label: t("tiles.total"), value: metrics.total },
    { label: t("tiles.applied"), value: metrics.applied },
    { label: t("tiles.interviews"), value: metrics.interviews },
    { label: t("tiles.offers"), value: metrics.offers },
    { label: t("tiles.declined"), value: metrics.declined },
  ];

  // The phone list (PLAN 31.2/7): the counts per status, the tab on show, and
  // its applications in the chosen order.
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of STATUSES) c[s] = 0;
    for (const a of apps) c[a.status || "saved"] = (c[a.status || "saved"] ?? 0) + 1;
    return c;
  }, [apps]);
  // To review comes first, as it does on the board, and exists only while a
  // draft does: asked for with none left (the last one just approved), the list
  // opens where it would have.
  const firstStatus = toReview.length > 0 ? "review" : (STATUSES.find((s) => counts[s] > 0) ?? "saved");
  const shownStatus = listStatus === "review" && toReview.length === 0 ? firstStatus : (listStatus ?? firstStatus);
  const listed = useMemo(
    () => sortApps(apps.filter((a) => (a.status || "saved") === shownStatus), listSort),
    [apps, shownStatus, listSort],
  );

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

      {/* Stale-application nudges: time to follow up. Outside the `loading`
          ternary on purpose — it has its own fetch and never reads `apps`. */}
      {nudges.length > 0 && (
        <Card className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-warn/10 text-warn">
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
                    // The job rides `?app=` (PLAN 31.4/6, 31.4/3's rule), so a
                    // reload keeps it and the tool's Back returns to the job.
                    nav(`/tools/follow-up?app=${n.id}`, {
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

      {/* The counters, on ONE line (PLAN 31.2/7). They were five tiles and two
          rings in a card that filled a phone's first screen, with the board's
          first column at y = 609 of 664; the rings are on Analytics now. */}
      {loading ? (
        <Skeleton className="h-6 w-2/3" />
      ) : (
        apps.length > 0 && (
          <p className="text-sm text-ink-muted">
            {tiles.map((tile, i) => (
              <span key={tile.label} className="whitespace-nowrap">
                {i > 0 && " · "}
                <span className="font-semibold tabular-nums text-ink">{tile.value}</span> {tile.label}
              </span>
            ))}
          </p>
        )
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
      ) : apps.length === 0 && toReview.length === 0 ? (
        <Card className="animate-fade-up py-12 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
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
        boardFits ? (
        <>
        {/* To review, over the board (PLAN 31.4/5): the drafts come before
            Saved in a job's life, as the tab does on a phone. A strip, not a
            sixth column: at xl six columns leave 168 px a card. */}
        {toReview.length > 0 && (
          <section aria-labelledby="to-review" className="rounded-2xl border border-accent/30 bg-panel/40 p-3">
            <h2 id="to-review" className="mb-2 flex items-center gap-2 px-1 text-sm font-semibold text-ink">
              {t("review.title")}
              <span className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink-muted">
                {toReview.length}
              </span>
            </h2>
            <ReviewList kits={toReview} grid />
          </section>
        )}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {COLUMNS.map((col) => {
            const items = apps.filter((a) => (a.status || "saved") === col.key);
            return (
              <div key={col.key} className="flex flex-col overflow-hidden rounded-2xl border border-line/60 bg-panel/40">
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
                    {items.map((a) => (
                      <motion.div
                        key={a.id}
                        // C2 — shared layoutId: on a status change the card
                        // GLIDES from its old column to the new one (the old
                        // instance hands its position to this one) instead of
                        // fading out/in. The spring settle is the whole "drop".
                        layoutId={`tracker-card-${a.id}`}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96 }}
                        transition={{
                          duration: 0.25,
                          ease: [0.22, 1, 0.36, 1],
                          layout: { type: "spring", duration: 0.25, bounce: 0.15 },
                        }}
                        className="group relative rounded-xl border border-line bg-gradient-to-b from-panel to-panel/70 p-3.5 shadow-card transition-all duration-200 hover:border-accent/40 hover:shadow-glow"
                      >
                        <AppCard
                          a={a}
                          onStatus={changeStatus}
                          onRate={rate}
                          onToggleInterviewed={toggleInterviewed}
                        />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            );
          })}
        </div>
        </>
        ) : (
          // THE PHONE LIST (PLAN 31.2/7). Five columns swiped sideways put one
          // column on a 390 px screen at a time; this is the same tracker as
          // status tabs with their counts over one vertical list, and a sort
          // that includes the date applied.
          <div className="space-y-3">
            <div role="tablist" aria-label={t("statusLabel")} className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1">
              {/* To review, first while a draft waits (PLAN 31.4/5). */}
              {toReview.length > 0 && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={shownStatus === "review"}
                  onClick={() => setListStatus("review")}
                  className={cn(
                    "relative inline-flex min-h-9 shrink-0 items-center gap-1.5 overflow-hidden rounded-full border px-3 text-xs font-semibold transition-colors",
                    shownStatus === "review"
                      ? "border-accent bg-accent text-white"
                      : "border-accent/50 bg-accent/10 text-accent-soft hover:text-ink",
                  )}
                >
                  {t("review.title")}
                  <span className="tabular-nums opacity-80">{toReview.length}</span>
                </button>
              )}
              {COLUMNS.map((col) => (
                <button
                  key={col.key}
                  type="button"
                  role="tab"
                  aria-selected={shownStatus === col.key}
                  onClick={() => setListStatus(col.key)}
                  className={cn(
                    "relative inline-flex min-h-9 shrink-0 items-center gap-1.5 overflow-hidden rounded-full border px-3 text-xs font-semibold transition-colors",
                    shownStatus === col.key
                      ? "border-accent bg-accent text-white"
                      : "border-line bg-panel text-ink-muted hover:text-ink",
                  )}
                >
                  {/* C2's flash, on the tab that just received a card. */}
                  {pulse?.col === col.key && shownStatus !== col.key && (
                    <motion.span
                      key={pulse.n}
                      aria-hidden
                      className="pointer-events-none absolute inset-0 bg-accent/25"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: [0, 1, 0] }}
                      transition={{ duration: 0.4, ease: "easeOut" }}
                    />
                  )}
                  <span className={cn("h-1.5 w-1.5 rounded-full", shownStatus === col.key ? "bg-white" : col.dot)} aria-hidden />
                  {t(`status.${col.key}`)}
                  <span className="tabular-nums opacity-80">{counts[col.key]}</span>
                </button>
              ))}
            </div>
            {shownStatus === "review" ? (
              <ReviewList kits={toReview} />
            ) : (
            <>
            <label className="flex items-center justify-end gap-2 text-xs font-semibold text-ink-muted">
              {t("listSort.label")}
              <select
                value={listSort}
                onChange={(e) => setListSort(e.target.value as ListSort)}
                className="cursor-pointer rounded-lg border border-line bg-bg-soft px-2 py-1 text-xs text-ink focus:border-accent/60 focus:outline-none"
              >
                <option value="newest">{t("listSort.newest")}</option>
                <option value="applied">{t("listSort.applied")}</option>
                <option value="match">{t("listSort.match")}</option>
              </select>
            </label>
            {listed.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line/70 px-3 py-6 text-center text-xs text-ink-faint">
                {t("columnEmpty")}
              </p>
            ) : (
              <AnimatePresence initial={false}>
                {listed.map((a) => (
                  <motion.div
                    key={a.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    className="relative rounded-xl border border-line bg-gradient-to-b from-panel to-panel/70 p-3.5 shadow-card"
                  >
                    <AppCard
                      a={a}
                      onStatus={changeStatus}
                      onRate={rate}
                      onToggleInterviewed={toggleInterviewed}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            )}
            </>
            )}
          </div>
        )
      )}
    </div>
  );
}
