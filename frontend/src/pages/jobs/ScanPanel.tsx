// The per-board scan ticker + radar sweep shown while a search runs
// (design plan D1/D3; split out of JobsPage.tsx — PLAN 12.5d).
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Card } from "../../components/ui";
import type { SearchProgressEvent } from "../../api/client";
import type { JobSearchResult } from "../../types";
import { EASE, formatElapsed, formatEta, SEARCH_STAGES, sourceLabel } from "./shared";


// Split-flap timings for the scan ticker (design plan D1): each board row
// half-flips shut, swaps content at the hard midpoint, and flips open showing
// its real count — staggered 120 ms per row, Terminus-style. (The house EASE
// curve lives in ./shared — JobsPage's tab/card motion uses it too.)
const FLIP_STAGGER = 0.12; // s between board rows resolving
const FLIP_HALF = 0.09; // s per half-flip
const RESOLVE_HOLD_MS = 1400; // read-the-counts pause before the panel yields to results

/** D3 — quiet radar sweep behind the ticker while boards are being scanned.
 * framer-motion drives the rotation so the root MotionConfig kills the loop
 * under reduced motion; rtl:-scale-x-100 flips the sweep direction. */
function RadarSweep() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute -end-8 -top-8 h-36 w-36 rtl:-scale-x-100"
    >
      <div className="absolute inset-0 rounded-full border border-accent/10" />
      <div className="absolute inset-6 rounded-full border border-accent/10" />
      <div className="absolute inset-12 rounded-full border border-accent/10" />
      <motion.div
        className="absolute inset-0 rounded-full"
        style={{
          background:
            "conic-gradient(from 0deg, transparent 0deg, transparent 220deg, rgb(var(--accent) / 0.08) 320deg, rgb(var(--accent) / 0.2) 360deg)",
        }}
        animate={{ rotate: 360 }}
        transition={{ duration: 3, ease: "linear", repeat: Infinity }}
      />
    </div>
  );
}

/** One board row of the scan ticker: "SCANNING…" under a shimmer while the
 * search runs (a live dot marks the board the SSE stream is querying right
 * now), then a split-flap half-flip to the real count — or a quiet "—" for
 * boards that matched nothing / were unavailable. No fake progress: every
 * state shown here comes from the stream or the response. */
function ScanTickerRow({
  source,
  live,
  resolved,
  delay,
  count,
  errored,
}: {
  source: string;
  live: boolean;
  resolved: boolean;
  delay: number; // s — this row's slot in the resolve stagger
  count: number;
  errored: boolean;
}) {
  const { t } = useTranslation("jobs");
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-line/70 bg-bg-soft/60 px-3 py-1.5">
      <span className="inline-flex items-center gap-2 text-xs font-semibold text-ink">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? "animate-pulse-glow bg-accent" : "bg-line"}`}
        />
        {sourceLabel(source)}
      </span>
      <span className="inline-block min-w-[5.5rem] text-end" style={{ perspective: 400 }}>
        <AnimatePresence mode="wait" initial={false}>
          {resolved ? (
            <motion.span
              key="count"
              initial={{ opacity: 0, rotateX: -90 }}
              animate={{ opacity: 1, rotateX: 0 }}
              transition={{ duration: FLIP_HALF, ease: "easeOut" }}
              className={`inline-block text-xs tabular-nums ${
                errored ? "text-warn" : count > 0 ? "font-semibold text-ink" : "text-ink-faint"
              }`}
            >
              {errored
                ? t("search.ticker.unavailable")
                : count > 0
                  ? t("search.ticker.found", { count })
                  : "—"}
            </motion.span>
          ) : (
            <motion.span
              key="scan"
              exit={{ opacity: 0, rotateX: 90 }}
              transition={{ duration: FLIP_HALF, ease: "easeIn", delay }}
              className="relative inline-block overflow-hidden rounded px-1 text-[10px] uppercase tracking-[0.18em] text-ink-faint"
            >
              {t("search.ticker.scanning")}
              <span aria-hidden className="absolute inset-0 rtl:-scale-x-100">
                <span className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-ink/10 to-transparent" />
              </span>
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </li>
  );
}

/** D1 — the per-board scan ticker. While the fan-out runs it shows one
 * shimmering row per requested board (the per-board failure isolation made
 * visible); when the response lands the rows resolve to real counts with a
 * 120 ms stagger, hold long enough to read, then the panel collapses and
 * hands off to the result cards entering below. */
export function SearchScanPanel({
  searching,
  startedAt,
  progress,
  result,
  requestedSources,
}: {
  searching: boolean;
  startedAt: number | null;
  progress: SearchProgressEvent | null;
  result: JobSearchResult | null;
  requestedSources: string[];
}) {
  const { t } = useTranslation("jobs");
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<"idle" | "scanning" | "resolving">("idle");

  // Boards the SSE stream has actually reported querying (fallback path sends
  // none) — merged into the row list in case it differs from the request.
  const [seen, setSeen] = useState<string[]>([]);
  useEffect(() => setSeen([]), [startedAt]);
  useEffect(() => {
    if (progress?.stage === "boards" && progress.source) {
      const s = progress.source.toLowerCase();
      setSeen((p) => (p.includes(s) ? p : [...p, s]));
    }
  }, [progress]);

  useEffect(() => {
    if (searching) {
      setPhase("scanning");
      return;
    }
    // Search just ended: resolve the rows if it produced a result; on error
    // the panel simply yields (the error renders next to the search button).
    setPhase((p) => (p === "scanning" ? (result ? "resolving" : "idle") : p));
  }, [searching, result]);

  const rows = useMemo(() => {
    const list = requestedSources.map((s) => s.toLowerCase());
    for (const s of seen) if (!list.includes(s)) list.push(s);
    if (result) {
      const extras = [
        ...result.matches.map((m) => (m.source ?? "").toLowerCase()),
        ...Object.keys(result.source_errors ?? {}).map((s) => s.toLowerCase()),
        ...Object.keys(result.source_empty ?? {}).map((s) => s.toLowerCase()),
      ];
      for (const s of extras) if (s && !list.includes(s)) list.push(s);
    }
    return list;
  }, [requestedSources, seen, result]);

  // Real counts only, tallied from the response's hits by board.
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of result?.matches ?? []) {
      const s = (m.source ?? "").toLowerCase();
      if (s) c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [result]);
  const errorSources = useMemo(
    () => new Set(Object.keys(result?.source_errors ?? {}).map((s) => s.toLowerCase())),
    [result],
  );

  // Once every row has flipped, hold briefly so the counts register, then
  // collapse the panel out of the way of the results.
  useEffect(() => {
    if (phase !== "resolving") return;
    const flipMs = reduce ? 0 : (rows.length * FLIP_STAGGER + FLIP_HALF * 2) * 1000;
    const id = setTimeout(() => setPhase("idle"), flipMs + RESOLVE_HOLD_MS);
    return () => clearTimeout(id);
  }, [phase, reduce, rows.length]);

  // Elapsed ticks only while the search is actually running.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!searching) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [searching, startedAt]);
  const elapsed = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000));

  let stageLine: string;
  if (phase === "resolving") {
    stageLine = t("search.ticker.complete");
  } else if (progress?.stage === "boards") {
    stageLine = t("search.stages.board", {
      source: sourceLabel(progress.source ?? "") || progress.source,
      index: progress.index,
      total: progress.total,
    });
  } else if (progress?.stage === "scoring") {
    const job = [progress.title, progress.company].filter(Boolean).join(" · ");
    stageLine = job
      ? t("search.stages.scoringJob", { index: progress.index, total: progress.total, job })
      : t("search.stages.scoringJobBare", { index: progress.index, total: progress.total });
  } else {
    stageLine = t(`search.stages.${SEARCH_STAGES[elapsed < 8 ? 0 : elapsed < 20 ? 1 : 2]}`);
  }

  // Remaining-time estimate once at least 2 jobs have finished scoring:
  // average seconds per completed job × jobs left. Elapsed includes the
  // boards fan-out, so the estimate starts pessimistic and converges.
  let eta = "";
  if (
    phase === "scanning" &&
    progress?.stage === "scoring" &&
    progress.index >= 2 &&
    progress.total > progress.index &&
    elapsed > 0
  ) {
    eta = formatEta((elapsed / progress.index) * (progress.total - progress.index), t);
  }

  const activeSource =
    phase === "scanning" && progress?.stage === "boards"
      ? (progress.source ?? "").toLowerCase()
      : "";

  return (
    <AnimatePresence initial={false}>
      {phase !== "idle" && (
        <motion.div
          key={startedAt ?? "scan"}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25, ease: EASE }}
          className="overflow-hidden"
        >
          <Card className="relative overflow-hidden">
            {phase === "scanning" && <RadarSweep />}
            <div className="relative">
              <div className="flex items-center gap-3">
                {phase === "scanning" && (
                  <Loader2 size={20} className="shrink-0 animate-spin text-accent-soft" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">
                    {t("search.searchingManual")}
                  </p>
                  <p aria-live="polite" className="mt-0.5 truncate text-xs text-ink-muted">
                    {stageLine} · {t("search.elapsed", { time: formatElapsed(elapsed) })}
                    {eta && ` · ${eta}`}
                  </p>
                </div>
              </div>
              <ul className="mt-4 space-y-1.5">
                {rows.map((s, i) => (
                  <ScanTickerRow
                    key={s}
                    source={s}
                    live={s === activeSource}
                    resolved={phase === "resolving"}
                    delay={reduce ? 0 : i * FLIP_STAGGER}
                    count={counts[s] ?? 0}
                    errored={errorSources.has(s)}
                  />
                ))}
              </ul>
              {phase === "scanning" && progress?.stage === "scoring" && progress.total > 0 && (
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-line">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-500"
                    style={{ width: `${Math.round((progress.index / progress.total) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          </Card>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
