import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ArrowRight,
  BadgeCheck,
  Bell,
  Briefcase,
  Building2,
  ExternalLink,
  Link2,
  Loader2,
  MessageCircle,
  Plus,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Trophy,
  Wand2,
  X,
} from "lucide-react";
import {
  clearJobHistory,
  deleteJobHistoryItem,
  fetchJob,
  getJobAlert,
  getJobHistory,
  listApplications,
  matchJobs,
  runJobAlert,
  searchContext,
  updateJobAlert,
  type SearchProgressEvent,
} from "../api/client";
import ResumeUpload from "../components/ResumeUpload";
import {
  getJobSearchState,
  startJobSearch,
  subscribeJobSearch,
} from "../state/jobSearchStore";
import {
  getKitsState,
  loadKits,
  removeKit,
  resumeKitQueue,
  sendKitApplication,
  startKitBatch,
  subscribeKits,
} from "../state/kitsStore";
import { useMasterResume } from "../hooks/useMasterResume";
import { apiErrorMessage } from "../lib/apiError";
import { fitReason } from "../lib/fitReason";
import { resumeLanguage } from "../lib/lang";
import { onboardingRole } from "../lib/onboarding";
import { masterResumeLabel, useSaveMasterResume } from "../hooks/useSaveMasterResume";
import { Badge, BorderGlow, Button, Card, CardTitle, CountUp, Modal, ProgressRing, Skeleton, useToast } from "../components/ui";
import type {
  AlertSettings,
  ApplicationOut,
  FactsLedger,
  JobMatch,
  JobSearchHit,
  JobSearchResult,
  KitJobIn,
  KitOut,
  ResumeModel,
  SearchContext,
} from "../types";

const inputCls =
  "rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none disabled:opacity-50";

const WORK_MODES = ["any", "remote", "onsite", "hybrid"] as const;

// "Posted within" choices in days; 0 = any age. Backend default is 30, so a
// ctx without max_age_days (older saved contexts) behaves like "Month".
const MAX_AGE_OPTIONS = [1, 3, 7, 14, 30, 0] as const;

// Selectable job boards (PROVIDERS registry ids). Empty/absent = all boards.
// Keep in sync with the backend registry: a board missing here disappears
// from any customized search the moment the user unchecks one box.
// (Jooble retired 2026-07-05 — they discontinued their Israeli index.)
const SOURCE_IDS = ["linkedin", "drushim", "comeet", "jobmaster", "greenhouse"] as const;

// One-click Israeli locations (PLAN 2.3). English values work across all
// boards: LinkedIn expects English; Drushim matches CityEnglish; Comeet
// aliases Hebrew cities to English anyway.
const LOCATION_PRESETS = [
  { key: "telAviv", value: "Tel Aviv, Israel" },
  { key: "jerusalem", value: "Jerusalem, Israel" },
  { key: "haifa", value: "Haifa, Israel" },
  { key: "israel", value: "Israel" },
] as const;

// Provider id → display name for source badges ("linkedin" → "LinkedIn").
// "jooble" stays for history rows saved before the board was retired.
const SOURCE_LABELS: Record<string, string> = {
  linkedin: "LinkedIn",
  drushim: "Drushim",
  comeet: "Comeet",
  jobmaster: "JobMaster",
  greenhouse: "Greenhouse",
  jooble: "Jooble",
};

function sourceLabel(source?: string): string {
  if (!source) return "";
  return SOURCE_LABELS[source.toLowerCase()] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

function postedAgo(iso: string, t: TFunction<"jobs">): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return t("posted.today");
  if (days === 1) return t("posted.yesterday");
  if (days < 7) return t("posted.days", { count: days });
  if (days < 30) return t("posted.weeks", { count: Math.floor(days / 7) });
  return t("posted.months", { count: Math.floor(days / 30) });
}

// Job-board hosts whose favicon is the board's logo, not the company's — those
// cards fall back to the lettered avatar unless the backend supplied a real
// company logo_url (LinkedIn/Drushim/Comeet boards carry one when available).
const BOARD_HOST_RE =
  /(^|\.)(linkedin\.com|licdn\.com|drushim\.co\.il|comeet\.(co|com)|jobmaster\.co\.il|greenhouse\.io|jooble\.org)$/;

function companyDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return BOARD_HOST_RE.test(host) ? null : host;
  } catch {
    return null;
  }
}

// Deterministic theme-token backgrounds for the lettered fallback avatar.
const AVATAR_TONES = [
  "bg-accent/15 text-accent-soft",
  "bg-mint/15 text-mint",
  "bg-warn/15 text-warn",
  "bg-accent/10 text-ink-muted",
] as const;

function avatarTone(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

/** Company logo when the job board provided one, else the company favicon when
 * the job URL points at a company domain, else a lettered avatar on a
 * background derived deterministically from the name. */
function CompanyAvatar({ company, url, logoUrl }: { company: string; url?: string; logoUrl?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const domain = url ? companyDomain(url) : null;
  const candidates = [
    logoUrl || null,
    domain
      ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`
      : null,
  ].filter((s): s is string => !!s && !failed.includes(s));
  const src = candidates[0];
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={40}
        height={40}
        loading="lazy"
        onError={() => setFailed((f) => [...f, src])}
        className={`h-10 w-10 shrink-0 rounded-lg border border-line bg-panel-2 object-contain ${
          src === logoUrl ? "p-1" : "p-1.5"
        }`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-base font-bold ${avatarTone(company || "?")}`}
    >
      {(company.trim().charAt(0) || "•").toUpperCase()}
    </span>
  );
}

/** WhatsApp share for a job card — Israel's default way to pass a job along. */
function WhatsAppShare({ title, company, url }: { title: string; company: string; url: string }) {
  const { t } = useTranslation("jobs");
  if (!url) return null;
  const text = `${title || t("card.untitled")}${company ? ` — ${company}` : ""}\n${url}`;
  return (
    <a
      href={`https://wa.me/?text=${encodeURIComponent(text)}`}
      target="_blank"
      rel="noreferrer"
      title={t("card.shareWhatsApp")}
      className="inline-flex items-center gap-1 text-mint hover:underline"
    >
      <MessageCircle size={12} /> {t("card.share")}
    </a>
  );
}

/** Posted within the last 48 hours. */
function isNewPosting(iso: string): boolean {
  const ts = new Date(iso).getTime();
  return !Number.isNaN(ts) && Date.now() - ts < 48 * 3_600_000;
}

function NewBadge({ postedAt }: { postedAt?: string }) {
  const { t } = useTranslation("jobs");
  if (!postedAt || !isNewPosting(postedAt)) return null;
  return (
    <Badge tone="mint" className="shrink-0">
      {t("card.new")}
    </Badge>
  );
}

/** Tracker rows and job hits both store the raw job URL — normalize just enough
 * (trailing slashes) to match them client-side. */
function normalizeJobUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

// Elapsed-time stage guesses, used only when the SSE stream isn't feeding real
// progress (old backend fallback): the pipeline really does run boards → fetch
// → score, and per-job scoring dominates.
const SEARCH_STAGES = ["boards", "fetching", "scoring"] as const;

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Rough remaining-time estimate for the scoring stage, rounded to friendly
// units: under ~1.5 min it reads "~40s left" (5 s steps), above it "~2 min
// left" — precision would be fake anyway.
function formatEta(secondsLeft: number, t: TFunction): string {
  if (secondsLeft < 90) {
    return t("search.eta.secondsLeft", { n: Math.max(5, Math.round(secondsLeft / 5) * 5) });
  }
  return t("search.eta.minutesLeft", { n: Math.round(secondsLeft / 60) });
}

// House ease + split-flap timings for the scan ticker (design plan D1): each
// board row half-flips shut, swaps content at the hard midpoint, and flips
// open showing its real count — staggered 120 ms per row, Terminus-style.
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
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
function SearchScanPanel({
  auto,
  searching,
  startedAt,
  progress,
  result,
  requestedSources,
}: {
  auto: boolean;
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
                    {auto ? t("search.searchingAuto") : t("search.searchingManual")}
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

// Tracker status shown on history rows (colors mirror the Tracker board).
const APP_STATUS: Record<
  string,
  { tone: "neutral" | "mint" | "partial" | "danger"; cls?: string }
> = {
  saved: { tone: "neutral" },
  applied: { tone: "mint" },
  interview: { tone: "partial" },
  offer: { tone: "mint", cls: "border-mint bg-mint font-bold text-bg shadow-glow-mint" },
  rejected: { tone: "danger" },
};

function AppStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation("jobs");
  const s = APP_STATUS[status];
  if (!s) return null;
  return (
    <Badge tone={s.tone} className={`shrink-0 ${s.cls ?? ""}`}>
      {t(`status.${status}`)}
    </Badge>
  );
}

// Matched (green) then missing (red) JD keywords on a job card. Matched chips
// are capped at 3 (PLAN 5.1/9.1) — the gaps are the actionable part.
function KeywordChips({ matched, gaps }: { matched?: string[]; gaps: string[] }) {
  const top = (matched ?? []).slice(0, 3);
  if (top.length === 0 && gaps.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {top.map((k) => (
        <Badge key={`ok-${k}`} tone="covered">
          {k}
        </Badge>
      ))}
      {gaps.map((g) => (
        <Badge key={g} tone="missing">
          {g}
        </Badge>
      ))}
    </div>
  );
}

/** Job-result card surface. Ordinary rows are plain Cards; only the single
 * top match earns the cursor-reactive BorderGlow (design plan D2) so the glow
 * reads as "this is the one", not as wallpaper. */
function JobResultCard({ children, glow = false }: { children: ReactNode; glow?: boolean }) {
  if (glow) {
    return (
      <BorderGlow innerClassName="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
        {children}
      </BorderGlow>
    );
  }
  return <Card className="flex flex-col gap-4 sm:flex-row sm:items-center">{children}</Card>;
}

function MatchCard({ m, best, appStatus }: { m: JobMatch; best: boolean; appStatus?: string }) {
  const nav = useNavigate();
  const { t } = useTranslation("jobs");
  return (
    <JobResultCard glow={best}>
      <ProgressRing value={m.overall} size={92} stroke={8} label={t("card.fit")} />
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <CompanyAvatar company={m.company} url={m.url || undefined} logoUrl={m.logo_url} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {best && <Badge tone="mint" className="shrink-0">{t("card.best")}</Badge>}
            <p className="min-w-0 max-w-full truncate font-semibold text-ink">
              {m.title || t("card.untitled")}
            </p>
            <NewBadge postedAt={m.posted_at} />
            {m.source && <Badge className="shrink-0">{sourceLabel(m.source)}</Badge>}
            {appStatus && <AppStatusBadge status={appStatus} />}
          </div>
          <p className="text-sm text-ink-muted">
            {m.company || "—"}
            {m.location ? ` · ${m.location}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
            <span>
              {t("card.atsLabel")}{" "}
              <CountUp
                to={Math.round(m.keyword_coverage)}
                duration={0.9}
                suffix="%"
                className="font-medium tabular-nums text-ink"
              />
            </span>
            <span>
              {t("card.recruiterFitLabel")}{" "}
              <CountUp
                to={Math.round(m.fit_score)}
                duration={0.9}
                suffix="%"
                className="font-medium tabular-nums text-ink"
              />
            </span>
            {m.posted_at && (
              <span title={m.posted_at}>{t("card.posted", { when: postedAgo(m.posted_at, t) })}</span>
            )}
            {m.url && (
              <a
                href={m.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent-soft hover:underline"
              >
                <ExternalLink size={12} /> {t("card.viewOn", { source: sourceLabel(m.source) || "LinkedIn" })}
              </a>
            )}
            <WhatsAppShare title={m.title} company={m.company} url={m.url} />
          </div>
          {(() => {
            const reason = fitReason(m.top_matched, m.top_gaps, t);
            return reason ? (
              <p dir="auto" className="mt-2 text-xs text-ink-faint">{reason}</p>
            ) : null;
          })()}
          <KeywordChips matched={m.top_matched} gaps={m.top_gaps} />
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-2">
        <Button
          variant="secondary"
          icon={<ArrowRight size={15} className="rtl:-scale-x-100" />}
          onClick={() =>
            nav("/app", {
              state: {
                jdText: m.jd_text,
                jobUrl: m.url || undefined,
                jobTitle: m.title,
                company: m.company,
              },
            })
          }
        >
          {t("card.tailorToThis")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Send size={14} className="rtl:-scale-x-100" />}
          onClick={() =>
            nav("/tools/outreach", {
              state: { jdText: m.jd_text, company: m.company, jobTitle: m.title },
            })
          }
        >
          {t("card.outreach")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Building2 size={14} />}
          onClick={() =>
            nav("/tools/company-brief", {
              state: { jdText: m.jd_text, company: m.company, jobTitle: m.title },
            })
          }
        >
          {t("card.brief")}
        </Button>
      </div>
    </JobResultCard>
  );
}

function HistoryRow({ hit, onDelete }: { hit: JobSearchHit; onDelete: (id: number) => void }) {
  const nav = useNavigate();
  const { t } = useTranslation("jobs");
  return (
    <JobResultCard>
      <ProgressRing value={hit.overall} size={64} stroke={6} label={t("card.fit")} />
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <CompanyAvatar company={hit.company} url={hit.url || undefined} logoUrl={hit.logo_url} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="min-w-0 max-w-full truncate font-semibold text-ink">
              {hit.title || t("card.untitled")}
            </p>
            <NewBadge postedAt={hit.posted_at} />
            {hit.source && <Badge className="shrink-0">{sourceLabel(hit.source)}</Badge>}
            <AppStatusBadge status={hit.app_status} />
          </div>
          <p className="text-sm text-ink-muted">
            {hit.company || "—"}
            {hit.location ? ` · ${hit.location}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
            <span>{t("history.searchedOn", { date: hit.searched_at.slice(0, 10) })}</span>
            {hit.posted_at && (
              <span title={hit.posted_at}>{t("card.posted", { when: postedAgo(hit.posted_at, t) })}</span>
            )}
            {hit.url && (
              <a
                href={hit.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent-soft hover:underline"
              >
                <ExternalLink size={12} /> {t("card.openOn", { source: sourceLabel(hit.source) || "LinkedIn" })}
              </a>
            )}
            <WhatsAppShare title={hit.title} company={hit.company} url={hit.url} />
          </div>
          {(() => {
            const reason = fitReason(hit.top_matched, hit.top_gaps, t);
            return reason ? (
              <p dir="auto" className="mt-2 text-xs text-ink-faint">{reason}</p>
            ) : null;
          })()}
          <KeywordChips matched={hit.top_matched} gaps={hit.top_gaps} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<ArrowRight size={14} className="rtl:-scale-x-100" />}
          onClick={() =>
            nav("/app", {
              state: {
                jdText: hit.jd_text,
                jobUrl: hit.url || undefined,
                jobTitle: hit.title,
                company: hit.company,
              },
            })
          }
        >
          {t("card.tailor")}
        </Button>
        <button
          onClick={() =>
            nav("/tools/outreach", {
              state: { jdText: hit.jd_text, company: hit.company, jobTitle: hit.title },
            })
          }
          title={t("card.outreach")}
          className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-line p-2 text-ink-muted transition-all hover:-translate-y-0.5 hover:border-accent/50 hover:text-accent-soft md:min-h-0 md:min-w-0"
        >
          <Send size={14} className="rtl:-scale-x-100" />
        </button>
        <button
          onClick={() =>
            nav("/tools/company-brief", {
              state: { jdText: hit.jd_text, company: hit.company, jobTitle: hit.title },
            })
          }
          title={t("card.brief")}
          className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-line p-2 text-ink-muted transition-all hover:-translate-y-0.5 hover:border-accent/50 hover:text-accent-soft md:min-h-0 md:min-w-0"
        >
          <Building2 size={14} />
        </button>
        <button
          onClick={() => onDelete(hit.id)}
          title={t("card.removeFromHistory")}
          className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-line p-2 text-ink-muted transition-all hover:-translate-y-0.5 hover:border-danger/50 hover:text-danger md:min-h-0 md:min-w-0"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </JobResultCard>
  );
}

// Batch auto-tailor (PLAN 8.1): jobs at/above the fit threshold become queued
// "application kits" — the backend tailors them one process-next call at a
// time while the user keeps browsing.
const KIT_MAX_BATCH = 10; // mirrors the backend's MAX_BATCH
const KIT_DEFAULT_THRESHOLD = 75;
const KIT_THRESHOLDS = [60, 65, 70, 75, 80, 85, 90] as const;

function kitJobFromMatch(m: JobMatch): KitJobIn {
  return {
    title: m.title,
    company: m.company,
    location: m.location,
    url: m.url,
    source: m.source ?? "linkedin",
    logo_url: m.logo_url ?? "",
    posted_at: m.posted_at,
    jd_text: m.jd_text,
    overall: m.overall,
  };
}

function BatchTailorCard({
  matches,
  onViewKits,
}: {
  matches: JobMatch[];
  onViewKits: () => void;
}) {
  const { t } = useTranslation("jobs");
  const toast = useToast();
  const { batching, total, done, lastKit, lastBatch, error } = useSyncExternalStore(
    subscribeKits,
    getKitsState,
  );
  const [threshold, setThreshold] = useState<number>(KIT_DEFAULT_THRESHOLD);
  const eligible = matches
    .filter((m) => m.url && m.jd_text && m.overall >= threshold)
    .sort((a, b) => b.overall - a.overall)
    .slice(0, KIT_MAX_BATCH);

  async function run() {
    const summary = await startKitBatch(eligible.map(kitJobFromMatch));
    if (!summary) return; // superseded, or the store error renders below
    if (summary.done === 0 && summary.skipped > 0) {
      toast("info", t("batch.allSkipped"));
      return;
    }
    const parts = [t("batch.doneToast", { count: summary.done - summary.failed })];
    if (summary.flagged > 0) parts.push(t("batch.doneFlagged", { count: summary.flagged }));
    if (summary.failed > 0) parts.push(t("batch.doneFailed", { count: summary.failed }));
    toast(summary.failed > 0 ? "info" : "success", parts.join(" · "));
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <Wand2 size={16} className="text-accent-soft" /> {t("batch.title")}
          </CardTitle>
          <p className="mt-1 text-xs text-ink-muted">{t("batch.body")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-semibold text-ink-muted">
            {t("batch.threshold")}
            <select
              value={threshold}
              disabled={batching}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className={inputCls}
            >
              {KIT_THRESHOLDS.map((v) => (
                <option key={v} value={v}>
                  {v}%
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="secondary"
            loading={batching}
            disabled={eligible.length === 0}
            icon={<Wand2 size={15} />}
            onClick={run}
          >
            {t("batch.cta", { count: eligible.length })}
          </Button>
        </div>
      </div>
      {!batching && eligible.length === 0 && (
        <p className="mt-2 text-xs text-ink-muted">{t("batch.none", { threshold })}</p>
      )}
      {!batching && eligible.length >= KIT_MAX_BATCH && (
        <p className="mt-2 text-xs text-ink-faint">{t("batch.capNote", { max: KIT_MAX_BATCH })}</p>
      )}
      {batching && (
        <div className="mt-3">
          <p aria-live="polite" className="truncate text-xs text-ink-muted">
            {t("batch.progress", { done, total })}
            {lastKit &&
              ` · ${t("batch.lastDone", {
                job: [lastKit.job_title, lastKit.company].filter(Boolean).join(" · "),
              })}`}
          </p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-accent transition-all duration-500"
              style={{ width: total > 0 ? `${Math.round((done / total) * 100)}%` : "10%" }}
            />
          </div>
        </div>
      )}
      {!batching && error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {!batching && !error && lastBatch && lastBatch.done > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
          <span>
            {[
              t("batch.doneToast", { count: lastBatch.done - lastBatch.failed }),
              ...(lastBatch.flagged > 0 ? [t("batch.doneFlagged", { count: lastBatch.flagged })] : []),
              ...(lastBatch.failed > 0 ? [t("batch.doneFailed", { count: lastBatch.failed })] : []),
            ].join(" · ")}
          </span>
          <button onClick={onViewKits} className="font-semibold text-accent-soft hover:underline">
            {t("batch.viewKits")}
          </button>
        </div>
      )}
    </Card>
  );
}

const KIT_STATUS_TONE: Record<KitOut["status"], "neutral" | "mint" | "partial" | "danger"> = {
  queued: "neutral",
  running: "partial",
  done: "mint",
  failed: "danger",
  approved: "mint",
  rejected: "neutral",
  submitted: "mint",
};

function KitRow({
  kit,
  onDelete,
  onSend,
}: {
  kit: KitOut;
  onDelete: (id: number) => void;
  onSend: (kit: KitOut) => void;
}) {
  const { t, i18n } = useTranslation("jobs");
  const nav = useNavigate();
  // Kits keep their tailor outcome through review: approved/rejected/submitted
  // rows still show scores and guard status, not just fresh "done" ones.
  const processed =
    kit.status === "done" ||
    kit.status === "approved" ||
    kit.status === "rejected" ||
    kit.status === "submitted";
  // True auto-submit (PLAN 8.4): only approved, guard-clean Comeet kits — the
  // backend re-enforces all of this; the button just doesn't offer dead ends.
  const canSend = kit.status === "approved" && kit.source === "comeet" && kit.flag_count === 0;
  return (
    <JobResultCard>
      <ProgressRing
        value={processed ? kit.score_after : kit.search_overall}
        size={64}
        stroke={6}
        label={processed ? t("kits.after") : t("card.fit")}
      />
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <CompanyAvatar company={kit.company} url={kit.url || undefined} logoUrl={kit.logo_url} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="min-w-0 max-w-full truncate font-semibold text-ink">
              {kit.job_title || t("card.untitled")}
            </p>
            <Badge tone={KIT_STATUS_TONE[kit.status]} className="shrink-0">
              {t(`kits.status.${kit.status}`)}
            </Badge>
            {kit.source && <Badge className="shrink-0">{sourceLabel(kit.source)}</Badge>}
            {processed &&
              (kit.flag_count > 0 ? (
                <Badge tone="danger" className="inline-flex shrink-0 items-center gap-1">
                  <ShieldAlert size={11} /> {t("kits.guardFlags", { count: kit.flag_count })}
                </Badge>
              ) : (
                <Badge tone="mint" className="inline-flex shrink-0 items-center gap-1">
                  <ShieldCheck size={11} /> {t("kits.guardClean")}
                </Badge>
              ))}
          </div>
          <p className="text-sm text-ink-muted">
            {kit.company || "—"}
            {kit.location ? ` · ${kit.location}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
            {processed && (
              <span className="font-semibold text-ink">
                {t("kits.score", {
                  before: Math.round(kit.score_before),
                  after: Math.round(kit.score_after),
                })}
              </span>
            )}
            <span>{t("kits.searchFit", { pct: Math.round(kit.search_overall) })}</span>
            {kit.url && (
              <a
                href={kit.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent-soft hover:underline"
              >
                <ExternalLink size={12} /> {t("card.openOn", { source: sourceLabel(kit.source) || "LinkedIn" })}
              </a>
            )}
          </div>
          {kit.status === "failed" && kit.error && (
            <p dir="auto" className="mt-1 text-xs text-danger">
              {kit.error}
            </p>
          )}
          {kit.status === "rejected" && kit.reject_reason && (
            <p dir="auto" className="mt-1 text-xs text-ink-faint">
              {t("kits.rejectedBecause", { reason: kit.reject_reason })}
            </p>
          )}
          {kit.status === "submitted" && (
            <p className="mt-1 text-xs text-ink-faint">
              {kit.submitted_at &&
                t("kits.submittedOn", {
                  date: new Date(kit.submitted_at).toLocaleDateString(i18n.language),
                })}
              {kit.submit_note && (
                <>
                  {" · "}
                  {t("kits.questionnaireNote")}{" "}
                  <a
                    href={kit.submit_note}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent-soft hover:underline"
                  >
                    {t("kits.questionnaireLink")}
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canSend && (
          <Button
            size="sm"
            icon={<Send size={14} className="rtl:-scale-x-100" />}
            onClick={() => onSend(kit)}
          >
            {t("kits.submit")}
          </Button>
        )}
        {processed && (
          <Button
            variant="secondary"
            size="sm"
            icon={<ArrowRight size={14} className="rtl:-scale-x-100" />}
            onClick={() => nav(`/kits/${kit.id}`)}
          >
            {t("kits.review")}
          </Button>
        )}
        <button
          onClick={() => onDelete(kit.id)}
          title={t("kits.delete")}
          className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-line p-2 text-ink-muted transition-all hover:-translate-y-0.5 hover:border-danger/50 hover:text-danger md:min-h-0 md:min-w-0"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </JobResultCard>
  );
}

/** Semantic fingerprint of a SearchContext for dirty-checking, ignoring field
 * order and the absent-vs-default noise a backend round-trip introduces
 * (missing sources = all boards, missing max_age_days = 30). */
function contextKey(c: SearchContext | null): string {
  if (!c) return "";
  const titles = c.job_titles?.length ? c.job_titles : [c.job_title];
  return JSON.stringify([
    titles,
    c.location,
    c.work_mode,
    c.limit,
    c.sources?.length ? [...c.sources].sort() : [...SOURCE_IDS].sort(),
    c.max_age_days ?? 30,
  ]);
}

/** The customized-search fields — keywords, location, work mode, posted-within,
 * result limit, location presets, and board checkboxes. Shared by the search
 * card and the email-alerts card so customizing the alert is literally the
 * same panel; edits go straight into the parent-owned SearchContext draft. */
function CustomizeFields({
  ctx,
  setCtx,
  prefilling,
}: {
  ctx: SearchContext | null;
  setCtx: Dispatch<SetStateAction<SearchContext | null>>;
  prefilling: boolean;
}) {
  const { t } = useTranslation("jobs");

  // Multi-keyword search: the UI edits ctx.job_titles (one input per keyword);
  // job_title mirrors the first entry so older backends and the results
  // summary stay coherent. Backend dedupes/strips and caps at 5.
  const MAX_KEYWORDS = 5;
  const keywords: string[] = ctx?.job_titles?.length ? ctx.job_titles : [ctx?.job_title ?? ""];
  function setKeywords(next: string[]) {
    setCtx((p) => ({ ...(p as SearchContext), job_titles: next, job_title: next[0] ?? "" }));
  }

  // Sources selection lives on ctx.sources; empty/absent means "all boards".
  const selectedSources: string[] = ctx?.sources?.length ? ctx.sources : [...SOURCE_IDS];
  function toggleSource(id: string) {
    setCtx((p) => {
      const cur = p?.sources?.length ? p.sources : [...SOURCE_IDS];
      const next = cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id];
      return { ...(p as SearchContext), sources: next };
    });
  }

  return (
    <>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {t("search.jobTitle")}
          {keywords.map((kw, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={kw}
                disabled={prefilling}
                onChange={(e) =>
                  setKeywords(keywords.map((k, j) => (j === i ? e.target.value : k)))
                }
                placeholder={
                  prefilling
                    ? t("search.detecting")
                    : i === 0
                      ? t("search.jobTitlePlaceholder")
                      : t("search.keywordPlaceholder")
                }
                className={`${inputCls} min-w-0 flex-1`}
              />
              {keywords.length > 1 && (
                <button
                  type="button"
                  disabled={prefilling}
                  onClick={() => setKeywords(keywords.filter((_, j) => j !== i))}
                  title={t("search.removeKeyword")}
                  className="shrink-0 rounded p-1 text-ink-muted transition-colors hover:text-danger"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
          {keywords.length < MAX_KEYWORDS && (
            <button
              type="button"
              disabled={prefilling}
              onClick={() => setKeywords([...keywords, ""])}
              className="w-fit text-xs font-semibold text-accent-soft hover:underline disabled:opacity-50"
            >
              + {t("search.addKeyword")}
            </button>
          )}
        </div>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {t("search.location")}
          <input
            value={ctx?.location ?? ""}
            disabled={prefilling}
            onChange={(e) =>
              setCtx((p) => ({ ...(p as SearchContext), location: e.target.value }))
            }
            placeholder={prefilling ? t("search.detecting") : t("search.locationPlaceholder")}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {t("search.workMode")}
          <select
            value={ctx?.work_mode ?? "any"}
            disabled={prefilling}
            onChange={(e) =>
              setCtx((p) => ({ ...(p as SearchContext), work_mode: e.target.value }))
            }
            className={inputCls}
          >
            {WORK_MODES.map((w) => (
              <option key={w} value={w}>
                {t(`workModes.${w}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {t("search.postedWithin")}
          <select
            value={ctx?.max_age_days ?? 30}
            disabled={prefilling}
            onChange={(e) =>
              setCtx((p) => ({
                ...(p as SearchContext),
                max_age_days: Number(e.target.value),
              }))
            }
            className={inputCls}
          >
            {MAX_AGE_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {t(`postedWithin.${d === 0 ? "any" : `d${d}`}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {t("search.limit")}
          <input
            type="number"
            min={0}
            max={25}
            value={ctx?.limit === 0 ? "" : (ctx?.limit ?? 10)}
            disabled={prefilling}
            onChange={(e) =>
              // 0 stands for "empty box" — allowed while typing, but Search is disabled until it's 1–25.
              setCtx((p) => ({
                ...(p as SearchContext),
                limit:
                  e.target.value === ""
                    ? 0
                    : Math.max(0, Math.min(25, Math.floor(Number(e.target.value)) || 0)),
              }))
            }
            className={inputCls}
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span className="font-semibold">{t("search.presetsLabel")}</span>
        {LOCATION_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            disabled={prefilling}
            onClick={() =>
              setCtx((prev) => ({ ...(prev as SearchContext), location: p.value }))
            }
            className={`rounded-full border px-2.5 py-1 transition-colors ${
              ctx?.location === p.value
                ? "border-accent/60 bg-accent/10 text-ink"
                : "border-line hover:text-ink"
            }`}
          >
            {t(`search.presets.${p.key}`)}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-ink">
        <span className="text-xs font-semibold text-ink-muted">{t("search.sourcesLabel")}</span>
        {SOURCE_IDS.map((id) => {
          const checked = selectedSources.includes(id);
          return (
            <label key={id} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={checked}
                disabled={prefilling || (checked && selectedSources.length === 1)}
                onChange={() => toggleSource(id)}
                className="h-4 w-4 accent-accent"
              />
              {sourceLabel(id)}
            </label>
          );
        })}
      </div>
    </>
  );
}

/** Email-alert settings: daily saved-search re-run that emails unseen jobs.
 * The schedule itself is a server cron; this card is the toggle + "Run now"
 * plus its own Customize panel (the same fields as the search card) so the
 * daily run can be pinned to exact keywords/location/boards instead of
 * silently reusing whatever the search box held when the alert was saved. */
function AlertsCard({
  resume,
  seedContext,
}: {
  resume: ResumeModel;
  seedContext: () => SearchContext | null;
}) {
  const { t } = useTranslation("jobs");
  const toast = useToast();
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [email, setEmail] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  // Alert-specific customized search (independent of the search card's panel).
  const [customOpen, setCustomOpen] = useState(false);
  const [ctx, setCtx] = useState<SearchContext | null>(null);
  const [prefilling, setPrefilling] = useState(false);

  useEffect(() => {
    getJobAlert()
      .then((s) => {
        setSettings(s);
        setEmail(s.email);
        setEnabled(s.enabled);
        if (s.context) {
          // A saved context means the alert was customized — show it as such.
          setCtx(s.context);
          setCustomOpen(true);
        }
      })
      .catch(() => {}); // older backend without alerts — card hides itself
  }, []);

  if (!settings) return null;

  const limitInvalid = customOpen && (ctx?.limit ?? 10) < 1;
  // The daily cron runs against the SAVED settings, so show a Save button the
  // moment the card's draft (email or customized context) drifts from them.
  const unsaved =
    email.trim() !== settings.email ||
    contextKey(customOpen ? ctx : null) !== contextKey(settings.context);

  function toggleCustomize(checked: boolean) {
    setCustomOpen(checked);
    if (checked && !ctx && !prefilling) {
      // Seed from the search card's customized context when there is one,
      // else derive from the résumé exactly like the search panel does.
      const seed = seedContext();
      if (seed) {
        setCtx(seed);
        return;
      }
      setPrefilling(true);
      const role = onboardingRole();
      searchContext(resume)
        .then((c) => setCtx(role ? { ...c, job_title: role } : c))
        .catch(() => setCtx({ job_title: role, location: "", work_mode: "any", limit: 10 }))
        .finally(() => setPrefilling(false));
    }
  }

  async function save(nextEnabled: boolean): Promise<AlertSettings | null> {
    if (nextEnabled && !email.trim()) {
      toast("error", t("alerts.needEmail"));
      return null;
    }
    setSaving(true);
    try {
      const s = await updateJobAlert({
        enabled: nextEnabled,
        email,
        context: customOpen ? ctx : null,
      });
      setSettings(s);
      setEnabled(s.enabled);
      if (s.context) setCtx(s.context); // server echo — canonical field set
      toast("success", t("alerts.saved"));
      return s;
    } catch (e: any) {
      toast("error", apiErrorMessage(e, t("alerts.saveError")));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    // The run executes server-side against the saved settings — persist the
    // draft first so "Run now" always does what the card shows.
    if (unsaved && (await save(enabled)) === null) return;
    setRunning(true);
    try {
      const r = await runJobAlert();
      if (r.error) {
        toast("error", t("alerts.runError", { error: r.error }));
      } else {
        toast(
          "success",
          t("alerts.runResult", { total: r.total, count: r.new_count }) +
            (r.emailed ? t("alerts.runEmailed", { email }) : ""),
        );
      }
      setSettings(await getJobAlert());
    } catch (e: any) {
      toast("error", apiErrorMessage(e, t("alerts.runError", { error: "" })));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <CardTitle>
        <span className="inline-flex items-center gap-2">
          <Bell size={16} className="text-accent-soft" /> {t("alerts.title")}
        </span>
      </CardTitle>
      <p className="mt-1 text-sm text-ink-muted">{t("alerts.body")}</p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(e) => save(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          {t("alerts.enable")}
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("alerts.emailPlaceholder")}
          dir="ltr"
          className={inputCls}
        />
        <Button
          size="sm"
          variant="secondary"
          loading={running}
          disabled={saving || limitInvalid}
          onClick={runNow}
        >
          {t("alerts.runNow")}
        </Button>
        {unsaved && (
          <Button size="sm" loading={saving} disabled={limitInvalid} onClick={() => save(enabled)}>
            {t("common:actions.save")}
          </Button>
        )}
      </div>

      <label className="mt-4 flex w-fit cursor-pointer items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={customOpen}
          disabled={saving || prefilling}
          onChange={(e) => toggleCustomize(e.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        {t("alerts.customize")}
      </label>

      <AnimatePresence initial={false}>
        {customOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <CustomizeFields ctx={ctx} setCtx={setCtx} prefilling={prefilling} />
            <p className="mt-3 text-xs text-ink-muted">{t("alerts.customizeHint")}</p>
          </motion.div>
        )}
      </AnimatePresence>
      {!customOpen && <p className="mt-1 text-xs text-ink-faint">{t("alerts.autoNote")}</p>}

      <div className="mt-3 space-y-1 text-xs text-ink-muted">
        {unsaved && <p className="text-warn">{t("alerts.unsaved")}</p>}
        {settings.last_run_at && (
          <p>
            {t("alerts.lastRun", {
              date: settings.last_run_at.slice(0, 10),
              count: settings.last_new_count,
            })}
          </p>
        )}
        {settings.last_error && <p className="text-danger">{settings.last_error}</p>}
        {enabled && !settings.smtp_configured && (
          <p className="text-warn">{t("alerts.noSmtp")}</p>
        )}
      </div>
    </Card>
  );
}

export default function JobsPage() {
  const { t } = useTranslation("jobs");
  const { master, masters, loading, setMaster } = useMasterResume();
  const persistMaster = useSaveMasterResume();
  // "Back to kits" from the review page lands on the Kits tab directly.
  const loc = useLocation() as { state?: { tab?: string } };
  const [mode, setMode] = useState<"search" | "manual" | "history" | "kits">(
    loc.state?.tab === "kits" ? "kits" : "search",
  );
  const toast = useToast();

  // -- Batch auto-tailor kits (PLAN 8.1) --
  const {
    batching,
    kits,
    kitsLoading,
    kitsError,
  } = useSyncExternalStore(subscribeKits, getKitsState);
  useEffect(() => {
    if (mode === "kits") loadKits();
  }, [mode]);
  const queuedKits = kits?.filter((k) => k.status === "queued").length ?? 0;

  async function deleteKitRow(id: number) {
    if (!(await removeKit(id))) toast("error", t("kits.deleteError"));
  }

  // -- True auto-submit (PLAN 8.4): per-kit confirm, then a real application --
  const [sendTarget, setSendTarget] = useState<KitOut | null>(null);
  const [sendingKit, setSendingKit] = useState(false);
  async function confirmSendKit() {
    if (!sendTarget || sendingKit) return;
    setSendingKit(true);
    try {
      const updated = await sendKitApplication(sendTarget.id);
      toast("success", t("kits.submittedToast", { company: updated.company || updated.job_title }));
      setSendTarget(null);
    } catch (e: unknown) {
      toast("error", apiErrorMessage(e, t("kits.submitError")));
    } finally {
      setSendingKit(false);
    }
  }

  // -- Résumé upload state (Jobs is the front door: upload lives here too) --
  const [showReplace, setShowReplace] = useState(false);
  const [autoSearched, setAutoSearched] = useState(false); // first upload kicks off a search automatically
  const [sourceErrorsDismissed, setSourceErrorsDismissed] = useState(false);

  // -- History state --
  const [history, setHistory] = useState<JobSearchHit[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  // -- Find on LinkedIn state --
  const [customOpen, setCustomOpen] = useState(false);
  const [ctx, setCtx] = useState<SearchContext | null>(null);
  const [prefilling, setPrefilling] = useState(false);
  // The search itself lives in a module-level store so it keeps running (and
  // its result is still here) if the user navigates away mid-search.
  const {
    searching,
    result: searchResult,
    error: searchError,
    startedAt,
    progress: searchProgress,
    liveMatches,
  } = useSyncExternalStore(subscribeJobSearch, getJobSearchState);
  const [resultSort, setResultSort] = useState<"fit" | "date">("fit");
  const [historySort, setHistorySort] = useState<"searched" | "fit" | "date">("searched");

  // -- Paste / URL state --
  const [listings, setListings] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [matches, setMatches] = useState<JobMatch[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  // Tracker applications, so fresh result cards can show saved/applied state
  // (history rows get it from the backend; search results match by URL here).
  const [apps, setApps] = useState<ApplicationOut[]>([]);
  useEffect(() => {
    let alive = true;
    // Best-effort: cards just omit the status badge if the tracker is unreachable.
    listApplications()
      .then((a) => {
        if (alive) setApps(a);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [searchResult]); // refresh per search so newly tracked jobs show up

  const appStatusByUrl = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of apps) if (a.job_url) map.set(normalizeJobUrl(a.job_url), a.status || "saved");
    return map;
  }, [apps]);
  const statusFor = (url: string) => (url ? appStatusByUrl.get(normalizeJobUrl(url)) : undefined);

  async function loadHistory() {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const h = await getJobHistory();
      setHistory(h.hits);
    } catch (e: any) {
      setHistoryError(apiErrorMessage(e, t("history.loadError")));
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    if (mode === "history" && history === null && !historyLoading) loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function deleteHit(id: number) {
    try {
      await deleteJobHistoryItem(id);
      setHistory((p) => (p ? p.filter((h) => h.id !== id) : p));
    } catch {
      toast("error", t("history.deleteError"));
    }
  }

  async function clearAll() {
    setClearing(true);
    try {
      await clearJobHistory();
      setHistory([]);
      setConfirmClear(false);
      toast("success", t("history.cleared"));
    } catch {
      toast("error", t("history.clearError"));
    } finally {
      setClearing(false);
    }
  }

  // The onboarding "target role" answer steers non-customized searches (blank
  // SearchContext fields still mean "derive from the résumé" on the backend).
  function onboardingCtx(): SearchContext | null {
    const role = onboardingRole();
    return role ? { job_title: role, location: "", work_mode: "any", limit: 10 } : null;
  }

  function toggleCustomize(checked: boolean) {
    setCustomOpen(checked);
    if (checked && !ctx && master?.resume && !prefilling) {
      setPrefilling(true);
      const role = onboardingRole();
      searchContext(master.resume)
        .then((c) => setCtx(role ? { ...c, job_title: role } : c))
        .catch(() => setCtx({ job_title: role, location: "", work_mode: "any", limit: 10 }))
        .finally(() => setPrefilling(false));
    }
  }

  // limit 0 means the customize box was emptied — block searching until it's 1–25.
  const limitInvalid = customOpen && (ctx?.limit ?? 10) < 1;

  // Boards the in-flight search was asked to scan, snapshotted at launch so
  // the scan ticker doesn't drift if the customize box is edited mid-search.
  const [requestedSources, setRequestedSources] = useState<string[]>([...SOURCE_IDS]);

  function runSearch() {
    if (!master?.resume || searching || limitInvalid) return;
    const c = customOpen ? ctx : onboardingCtx();
    setRequestedSources(c?.sources?.length ? [...c.sources] : [...SOURCE_IDS]);
    startJobSearch(master.resume, c);
  }

  useEffect(() => {
    if (!searchResult) return;
    setCtx((p) => p ?? searchResult.context); // so opening Customize later starts from what was searched
    setSourceErrorsDismissed(false); // a fresh result gets a fresh warning
    if (history !== null) loadHistory(); // backend saved the results — keep the History tab fresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchResult]);

  /** Save an uploaded résumé as the master (shared logic with TailorPage) and
   * update this page in place — no reload needed. The first-ever upload also
   * auto-starts a job search so jobs appear without another click. */
  async function onResumeUploaded(r: ResumeModel, l: FactsLedger) {
    const firstUpload = !master?.resume;
    const m = await persistMaster(r, l); // best-effort — null when the backend is unreachable
    setMaster(
      m ?? {
        resume: r,
        ledger: l,
        label: masterResumeLabel(r),
        language: resumeLanguage(r),
        updated_at: new Date().toISOString(),
      },
    );
    setShowReplace(false);
    setCtx(null); // search context derives from the résumé — drop stale prefill
    if (firstUpload && !searching) {
      setAutoSearched(true);
      setMode("search");
      setRequestedSources([...SOURCE_IDS]); // non-customized search scans every board
      startJobSearch(r, onboardingCtx()); // magic moment: upload → jobs appear
    }
  }

  function addDraft() {
    if (draft.trim().length < 20) return;
    setListings((p) => [...p, draft.trim()]);
    setDraft("");
  }

  async function addUrl() {
    if (!url.trim()) return;
    setFetching(true);
    setError("");
    try {
      const text = await fetchJob(url);
      if (text.trim().length < 20) throw new Error(t("manual.noText"));
      setListings((p) => [...p, text]);
      setUrl("");
      toast("success", t("manual.fetched"));
    } catch (e: any) {
      setError(apiErrorMessage(e, e?.message || t("manual.fetchError")));
    } finally {
      setFetching(false);
    }
  }

  async function rank() {
    if (!master?.resume || listings.length === 0) return;
    setRunning(true);
    setError("");
    setMatches([]);
    try {
      const r = await matchJobs(master.resume, listings);
      setMatches(r.matches);
    } catch (e: any) {
      setError(apiErrorMessage(e, t("manual.genericError")));
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <Skeleton className="h-48 w-full" />;

  if (!master?.resume) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mx-auto max-w-2xl"
      >
        <Card className="px-5 py-10 text-center sm:px-10">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl bg-accent/10 text-accent-soft">
            <Briefcase />
          </div>
          <h1 className="text-2xl font-bold text-ink">
            {t("gate.title")}
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">
            {t("gate.body")}
          </p>
          <div className="mt-6 text-start">
            <ResumeUpload onParsed={onResumeUploaded} />
          </div>
        </Card>
      </motion.div>
    );
  }

  const searched = searchResult?.context;
  const searchedTitle = searched
    ? (searched.job_titles?.length ? searched.job_titles : [searched.job_title]).join(", ")
    : "";
  // The backend returns matches ranked by fit; re-sort client-side on demand.
  // "Best match" stays pinned to the top-fit job whatever the sort order.
  const bestMatch =
    searchResult && searchResult.matches.length > 0
      ? searchResult.matches.reduce((a, b) => (b.overall > a.overall ? b : a))
      : null;
  const sortedMatches = searchResult
    ? [...searchResult.matches].sort(
        resultSort === "date"
          ? (a, b) => (b.posted_at || "").localeCompare(a.posted_at || "")
          : (a, b) => b.overall - a.overall,
      )
    : [];
  const sortedHistory =
    history && historySort !== "searched"
      ? [...history].sort(
          historySort === "fit"
            ? (a, b) => b.overall - a.overall
            : (a, b) => (b.posted_at || "").localeCompare(a.posted_at || ""),
        )
      : history;
  // Streaming (PLAN 12.2): the store keeps per-job `match` frames sorted by
  // fit; the scoring-progress frames carry how many jobs will be scored in
  // total. Old backends send no match frames, so this stays empty and the
  // cards appear when the terminal result lands, exactly as before.
  const scoringTotal = searchProgress?.stage === "scoring" ? searchProgress.total : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
          <Briefcase className="text-accent-soft" /> {t("title")}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          {t("sub")}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {masters.map((m) => (
            <span
              key={m.language ?? "en"}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-mint/40 bg-mint/10 px-3 py-1 text-xs font-medium text-mint"
            >
              <BadgeCheck size={13} className="shrink-0" />
              <span className="truncate">{m.label || t("common:masterResume.chipFallback")}</span>
              {masters.length > 1 && (
                <span className="shrink-0 text-mint/80">· {t(`langTag.${m.language === "he" ? "he" : "en"}`)}</span>
              )}
            </span>
          ))}
          <button
            onClick={() => setShowReplace((v) => !v)}
            className="text-xs font-semibold text-accent-soft hover:underline"
          >
            {showReplace ? t("common:actions.cancel") : t("common:actions.replace")}
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {showReplace && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <Card>
              <CardTitle>{t("replaceTitle")}</CardTitle>
              <p className="mt-1 text-xs text-ink-muted">
                {t("replaceBody")}
              </p>
              <div className="mt-3">
                <ResumeUpload onParsed={onResumeUploaded} />
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-wrap gap-2">
        {(
          [
            { key: "search", label: t("tabs.search") },
            { key: "manual", label: t("tabs.manual") },
            {
              key: "history",
              label: history ? t("tabs.historyCount", { count: history.length }) : t("tabs.history"),
            },
            {
              key: "kits",
              label: kits?.length ? t("tabs.kitsCount", { count: kits.length }) : t("tabs.kits"),
            },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setMode(tab.key)}
            className={`whitespace-nowrap rounded-lg border px-3 py-2 text-sm font-semibold transition-colors sm:px-4 ${
              mode === tab.key
                ? "border-accent/60 bg-bg-soft text-ink"
                : "border-line text-ink-muted hover:text-ink"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {mode === "search" && (
        <>
          <Card>
            <CardTitle>{t("search.cardTitle")}</CardTitle>
            <p className="mt-1 text-sm text-ink-muted">
              {t("search.cardBody")}
            </p>

            <label className="mt-4 flex w-fit cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={customOpen}
                onChange={(e) => toggleCustomize(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              {t("search.customize")}
            </label>

            <AnimatePresence initial={false}>
              {customOpen && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <CustomizeFields ctx={ctx} setCtx={setCtx} prefilling={prefilling} />
                </motion.div>
              )}
            </AnimatePresence>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                loading={searching}
                icon={<Search size={18} />}
                disabled={prefilling || limitInvalid}
                onClick={runSearch}
              >
                {t("search.cta")}
              </Button>
              {searchError && <span className="text-sm text-danger">{searchError}</span>}
            </div>
          </Card>

          <SearchScanPanel
            auto={autoSearched}
            searching={searching}
            startedAt={startedAt}
            progress={searchProgress}
            result={searchResult}
            requestedSources={requestedSources}
          />

          {/* Streamed match cards: each scored job lands here the moment its
              `match` frame arrives, sorted in by fit — the same MatchCard the
              final results use, so nothing visually changes when the
              authoritative result replaces them. Also the partial-results
              surface when an interrupted search still scored some jobs. */}
          {liveMatches.length > 0 && (searching || (!searchResult && !!searchError)) && (
            <div className="space-y-4">
              {searching ? (
                <p aria-live="polite" className="text-xs text-ink-muted">
                  {scoringTotal > 0
                    ? t("search.streaming.showing", {
                        count: liveMatches.length,
                        total: scoringTotal,
                      })
                    : t("search.streaming.showingBare", { count: liveMatches.length })}
                </p>
              ) : (
                <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
                  {t("search.streaming.interrupted", { count: liveMatches.length })}
                </div>
              )}
              {liveMatches.map((m, i) => (
                <motion.div
                  key={m.url || `${m.title}·${m.company}`}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.25,
                    ease: EASE,
                    layout: { type: "spring", duration: 0.25, bounce: 0.15 },
                  }}
                >
                  <MatchCard m={m} best={i === 0} appStatus={statusFor(m.url)} />
                </motion.div>
              ))}
            </div>
          )}

          <AnimatePresence>
            {searchResult && !searching && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
                {searchResult.source_errors &&
                  Object.keys(searchResult.source_errors).length > 0 &&
                  !sourceErrorsDismissed && (
                    <div className="flex items-start justify-between gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
                      <div className="min-w-0">
                        <p>
                          {t("search.sourceErrors", {
                            sources: Object.keys(searchResult.source_errors).map(sourceLabel).join(", "),
                          })}
                        </p>
                        <ul className="mt-1 space-y-0.5 text-xs opacity-90">
                          {Object.entries(searchResult.source_errors).map(([s, msg]) => (
                            <li key={s} dir="auto">
                              {sourceLabel(s)}: {msg}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <button
                        onClick={() => setSourceErrorsDismissed(true)}
                        title={t("search.dismiss")}
                        className="shrink-0 rounded p-0.5 transition-opacity hover:opacity-70"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                {searchResult.source_empty && Object.keys(searchResult.source_empty).length > 0 && (
                  <p className="text-xs text-ink-muted">
                    {t("search.sourceEmpty", {
                      sources: Object.keys(searchResult.source_empty).map(sourceLabel).join(", "),
                    })}
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {searched && (
                    <p className="text-sm text-ink-muted">
                      <Trans
                        t={t}
                        i18nKey={searched.location ? "search.summaryLoc" : "search.summary"}
                        values={{ title: searchedTitle, location: searched.location }}
                        components={[
                          <span key="0" />,
                          <span key="1" className="font-semibold text-ink" />,
                          <span key="2" />,
                          <span key="3" className="font-semibold text-ink" />,
                        ]}
                      />
                      {searched.work_mode !== "any" && ` · ${t(`workModes.${searched.work_mode}`)}`}
                      {" — "}
                      {t("search.ranked", { count: searchResult.matches.length })}
                      {searchResult.skipped > 0 && t("search.skipped", { count: searchResult.skipped })}
                    </p>
                  )}
                  <label className="flex items-center gap-2 text-xs font-semibold text-ink-muted">
                    {t("sort.label")}
                    <select
                      value={resultSort}
                      onChange={(e) => setResultSort(e.target.value as "fit" | "date")}
                      className={inputCls}
                    >
                      <option value="fit">{t("sort.fit")}</option>
                      <option value="date">{t("sort.date")}</option>
                    </select>
                  </label>
                </div>
                {sortedMatches.length > 0 && (
                  <BatchTailorCard matches={searchResult.matches} onViewKits={() => setMode("kits")} />
                )}
                {sortedMatches.map((m, i) => (
                  <motion.div
                    key={m.url || i}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: EASE, delay: Math.min(i, 12) * 0.04 }}
                  >
                    <MatchCard m={m} best={m === bestMatch} appStatus={statusFor(m.url)} />
                  </motion.div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          <AlertsCard
            resume={master.resume}
            seedContext={() => (customOpen ? ctx : onboardingCtx())}
          />
        </>
      )}

      {mode === "manual" && (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardTitle>{t("manual.pasteTitle")}</CardTitle>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t("manual.pastePlaceholder")}
                className="mt-3 min-h-[140px] w-full resize-y rounded-xl border border-line bg-bg-soft p-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
              />
              <Button size="sm" className="mt-2" variant="secondary" icon={<Plus size={14} />} disabled={draft.trim().length < 20} onClick={addDraft}>
                {t("manual.addListing")}
              </Button>
            </Card>

            <Card>
              <CardTitle>{t("manual.urlTitle")}</CardTitle>
              <p className="mt-1 text-xs text-ink-muted">{t("manual.urlHint")}</p>
              <div className="mt-3 flex gap-2">
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://…/job-posting"
                  dir="ltr"
                  className={`flex-1 ${inputCls}`}
                />
                <Button size="sm" variant="secondary" loading={fetching} icon={<Link2 size={14} />} onClick={addUrl}>
                  {t("manual.fetch")}
                </Button>
              </div>

              {listings.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                    {t("manual.queued", { count: listings.length })}
                  </p>
                  <div className="space-y-1.5">
                    {listings.map((l, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-bg-soft px-3 py-1.5 text-xs text-ink-muted">
                        <span className="truncate">{l.slice(0, 70)}…</span>
                        <button onClick={() => setListings((p) => p.filter((_, j) => j !== i))} className="shrink-0 hover:text-danger">
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </div>

          <Card className="flex flex-wrap items-center gap-3">
            <Button size="lg" loading={running} icon={<Trophy size={18} />} disabled={listings.length === 0} onClick={rank}>
              {t("manual.rank", { count: listings.length })}
            </Button>
            {error && <span className="text-sm text-danger">{error}</span>}
          </Card>

          {running && (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          <AnimatePresence>
            {matches.length > 0 && !running && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
                {matches.map((m, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: EASE, delay: Math.min(i, 12) * 0.04 }}
                  >
                    <MatchCard m={m} best={i === 0} appStatus={statusFor(m.url)} />
                  </motion.div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      {mode === "history" && (
        <>
          {historyLoading && (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          {!historyLoading && historyError && (
            <Card className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-danger">{historyError}</span>
              <Button size="sm" variant="secondary" onClick={loadHistory}>
                {t("history.retry")}
              </Button>
            </Card>
          )}

          {!historyLoading && !historyError && history && history.length === 0 && (
            <Card>
              <CardTitle>{t("history.emptyTitle")}</CardTitle>
              <p className="mt-1 text-sm text-ink-muted">
                {t("history.emptyBody")}
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-4"
                icon={<Search size={14} />}
                onClick={() => setMode("search")}
              >
                {t("history.emptyCta")}
              </Button>
            </Card>
          )}

          {!historyLoading && !historyError && history && history.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-ink-muted">
                  <Trans
                    t={t}
                    i18nKey="history.savedOf"
                    values={{ count: history.length }}
                    components={[<span key="0" className="font-semibold text-ink" />]}
                  />
                </p>
                <label className="flex items-center gap-2 text-xs font-semibold text-ink-muted">
                  {t("sort.label")}
                  <select
                    value={historySort}
                    onChange={(e) => setHistorySort(e.target.value as "searched" | "fit" | "date")}
                    className={inputCls}
                  >
                    <option value="searched">{t("sort.searched")}</option>
                    <option value="fit">{t("sort.fit")}</option>
                    <option value="date">{t("sort.date")}</option>
                  </select>
                </label>
                {confirmClear ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-ink-muted">{t("history.deleteAll", { count: history.length })}</span>
                    <Button size="sm" variant="danger" loading={clearing} onClick={clearAll}>
                      {t("history.confirmClear")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
                      {t("common:actions.cancel")}
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={14} />}
                    onClick={() => setConfirmClear(true)}
                  >
                    {t("history.clearAll")}
                  </Button>
                )}
              </div>
              {(sortedHistory ?? []).map((hit) => (
                <HistoryRow key={hit.id} hit={hit} onDelete={deleteHit} />
              ))}
            </motion.div>
          )}
        </>
      )}

      {mode === "kits" && (
        <>
          <Card>
            <CardTitle className="flex items-center gap-2">
              <Wand2 size={16} className="text-accent-soft" /> {t("kits.title")}
            </CardTitle>
            <p className="mt-1 text-sm text-ink-muted">{t("kits.body")}</p>
            {queuedKits > 0 && !batching && (
              <Button
                size="sm"
                variant="secondary"
                className="mt-3"
                icon={<Wand2 size={14} />}
                onClick={() => resumeKitQueue()}
              >
                {t("kits.processQueue", { count: queuedKits })}
              </Button>
            )}
            {batching && (
              <p className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
                <Loader2 size={15} className="animate-spin text-accent-soft" />
                {t("kits.processing")}
              </p>
            )}
          </Card>

          {kitsLoading && kits === null && (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          {!kitsLoading && kitsError && (
            <Card className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-danger">{kitsError}</span>
              <Button size="sm" variant="secondary" onClick={() => loadKits(true)}>
                {t("kits.retry")}
              </Button>
            </Card>
          )}

          {!kitsLoading && !kitsError && kits && kits.length === 0 && (
            <Card>
              <CardTitle>{t("kits.emptyTitle")}</CardTitle>
              <p className="mt-1 text-sm text-ink-muted">{t("kits.emptyBody")}</p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-4"
                icon={<Search size={14} />}
                onClick={() => setMode("search")}
              >
                {t("kits.emptyCta")}
              </Button>
            </Card>
          )}

          {kits && kits.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
              <p className="text-xs text-ink-faint">{t("kits.reviewSoon")}</p>
              {kits.map((kit) => (
                <KitRow key={kit.id} kit={kit} onDelete={deleteKitRow} onSend={setSendTarget} />
              ))}
            </motion.div>
          )}
        </>
      )}

      {/* True auto-submit confirm (PLAN 8.4) — this sends a REAL application. */}
      <Modal
        open={sendTarget !== null}
        onClose={() => !sendingKit && setSendTarget(null)}
        title={t("kits.submitTitle")}
        maxWidth="max-w-lg"
      >
        {sendTarget && (
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">
              {t("kits.submitBody", { company: sendTarget.company || sendTarget.job_title })}
            </p>
            <p className="text-xs text-ink-faint">{t("kits.submitNote")}</p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setSendTarget(null)} disabled={sendingKit}>
                {t("search.dismiss")}
              </Button>
              <Button
                size="sm"
                icon={sendingKit ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} className="rtl:-scale-x-100" />}
                onClick={confirmSendKit}
                disabled={sendingKit}
              >
                {t("kits.confirmSubmit")}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
