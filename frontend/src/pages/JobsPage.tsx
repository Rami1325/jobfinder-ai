import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ArrowRight,
  BadgeCheck,
  Bell,
  Briefcase,
  ExternalLink,
  Link2,
  Loader2,
  MessageCircle,
  Plus,
  Search,
  Trash2,
  Trophy,
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
} from "../api/client";
import ResumeUpload from "../components/ResumeUpload";
import {
  getJobSearchState,
  startJobSearch,
  subscribeJobSearch,
} from "../state/jobSearchStore";
import { useMasterResume } from "../hooks/useMasterResume";
import { apiErrorMessage } from "../lib/apiError";
import { resumeLanguage } from "../lib/lang";
import { onboardingRole } from "../lib/onboarding";
import { masterResumeLabel, useSaveMasterResume } from "../hooks/useSaveMasterResume";
import { Badge, Button, Card, CardTitle, ProgressRing, Skeleton, useToast } from "../components/ui";
import type {
  AlertSettings,
  ApplicationOut,
  FactsLedger,
  JobMatch,
  JobSearchHit,
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
const SOURCE_IDS = ["linkedin", "drushim", "comeet", "jobmaster"] as const;

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
  /(^|\.)(linkedin\.com|licdn\.com|drushim\.co\.il|comeet\.(co|com)|jobmaster\.co\.il|jooble\.org)$/;

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

// The whole search is one long backend call, so per-job progress isn't knowable
// client-side (PLAN: true progress needs a streaming backend). Show an honest
// stage indicator: the pipeline really does run boards → fetch → score, and
// per-job scoring dominates, so advance the copy on elapsed time and stay on
// "scoring" — plus a live elapsed clock.
const SEARCH_STAGES = ["boards", "fetching", "scoring"] as const;

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function SearchProgress({ auto, startedAt }: { auto: boolean; startedAt: number | null }) {
  const { t } = useTranslation("jobs");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000));
  const stage = SEARCH_STAGES[elapsed < 8 ? 0 : elapsed < 20 ? 1 : 2];
  return (
    <div className="space-y-3">
      <Card className="flex items-center gap-3">
        <Loader2 size={20} className="shrink-0 animate-spin text-accent-soft" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">
            {auto ? t("search.searchingAuto") : t("search.searchingManual")}
          </p>
          <p aria-live="polite" className="mt-0.5 text-xs text-ink-muted">
            {t(`search.stages.${stage}`)} · {t("search.elapsed", { time: formatElapsed(elapsed) })}
          </p>
        </div>
      </Card>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
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

function MatchCard({ m, best, appStatus }: { m: JobMatch; best: boolean; appStatus?: string }) {
  const nav = useNavigate();
  const { t } = useTranslation("jobs");
  return (
    <Card className="flex flex-col gap-4 sm:flex-row sm:items-center">
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
            <span>{t("card.ats", { pct: Math.round(m.keyword_coverage) })}</span>
            <span>{t("card.recruiterFit", { pct: Math.round(m.fit_score) })}</span>
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
          {m.top_gaps.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {m.top_gaps.map((g) => (
                <Badge key={g} tone="missing">
                  {g}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
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
    </Card>
  );
}

function HistoryRow({ hit, onDelete }: { hit: JobSearchHit; onDelete: (id: number) => void }) {
  const nav = useNavigate();
  const { t } = useTranslation("jobs");
  return (
    <Card className="flex flex-col gap-4 sm:flex-row sm:items-center">
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
          onClick={() => onDelete(hit.id)}
          title={t("card.removeFromHistory")}
          className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-line p-2 text-ink-muted transition-colors hover:border-danger/50 hover:text-danger md:min-h-0 md:min-w-0"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </Card>
  );
}

/** Email-alert settings: daily saved-search re-run that emails unseen jobs.
 * The schedule itself is a server cron; this card is the toggle + "Run now". */
function AlertsCard({ getContext }: { getContext: () => SearchContext | null }) {
  const { t } = useTranslation("jobs");
  const toast = useToast();
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [email, setEmail] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    getJobAlert()
      .then((s) => {
        setSettings(s);
        setEmail(s.email);
        setEnabled(s.enabled);
      })
      .catch(() => {}); // older backend without alerts — card hides itself
  }, []);

  if (!settings) return null;

  async function save(nextEnabled: boolean) {
    if (nextEnabled && !email.trim()) {
      toast("error", t("alerts.needEmail"));
      return;
    }
    setSaving(true);
    try {
      const s = await updateJobAlert({ enabled: nextEnabled, email, context: getContext() });
      setSettings(s);
      setEnabled(s.enabled);
      toast("success", t("alerts.saved"));
    } catch (e: any) {
      toast("error", apiErrorMessage(e, t("alerts.saveError")));
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
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
          onBlur={() => enabled && email.trim() && email !== settings.email && save(enabled)}
          placeholder={t("alerts.emailPlaceholder")}
          dir="ltr"
          className={inputCls}
        />
        <Button size="sm" variant="secondary" loading={running} onClick={runNow}>
          {t("alerts.runNow")}
        </Button>
      </div>

      <div className="mt-3 space-y-1 text-xs text-ink-muted">
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
  const [mode, setMode] = useState<"search" | "manual" | "history">("search");
  const toast = useToast();

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
  const { searching, result: searchResult, error: searchError, startedAt } = useSyncExternalStore(
    subscribeJobSearch,
    getJobSearchState,
  );
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

  function runSearch() {
    if (!master?.resume || searching) return;
    startJobSearch(master.resume, customOpen ? ctx : onboardingCtx());
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
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
                      {t("search.jobTitle")}
                      <input
                        value={ctx?.job_title ?? ""}
                        disabled={prefilling}
                        onChange={(e) =>
                          setCtx((p) => ({ ...(p as SearchContext), job_title: e.target.value }))
                        }
                        placeholder={prefilling ? t("search.detecting") : t("search.jobTitlePlaceholder")}
                        className={inputCls}
                      />
                    </label>
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
                        min={1}
                        max={25}
                        value={ctx?.limit ?? 10}
                        disabled={prefilling}
                        onChange={(e) =>
                          setCtx((p) => ({
                            ...(p as SearchContext),
                            limit: Math.max(1, Math.min(25, Number(e.target.value) || 10)),
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
                </motion.div>
              )}
            </AnimatePresence>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                loading={searching}
                icon={<Search size={18} />}
                disabled={prefilling}
                onClick={runSearch}
              >
                {t("search.cta")}
              </Button>
              {searchError && <span className="text-sm text-danger">{searchError}</span>}
            </div>
          </Card>

          {searching && <SearchProgress auto={autoSearched} startedAt={startedAt} />}

          <AnimatePresence>
            {searchResult && !searching && (
              <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                {searchResult.source_errors &&
                  Object.keys(searchResult.source_errors).length > 0 &&
                  !sourceErrorsDismissed && (
                    <div className="flex items-start justify-between gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
                      <span className="min-w-0">
                        {t("search.sourceErrors", {
                          sources: Object.keys(searchResult.source_errors).map(sourceLabel).join(", "),
                        })}
                      </span>
                      <button
                        onClick={() => setSourceErrorsDismissed(true)}
                        title={t("search.dismiss")}
                        className="shrink-0 rounded p-0.5 transition-opacity hover:opacity-70"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {searched && (
                    <p className="text-sm text-ink-muted">
                      <Trans
                        t={t}
                        i18nKey={searched.location ? "search.summaryLoc" : "search.summary"}
                        values={{ title: searched.job_title, location: searched.location }}
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
                {sortedMatches.map((m, i) => (
                  <MatchCard key={m.url || i} m={m} best={m === bestMatch} appStatus={statusFor(m.url)} />
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          <AlertsCard getContext={() => (customOpen ? ctx : onboardingCtx())} />
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
              <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                {matches.map((m, i) => (
                  <MatchCard key={i} m={m} best={i === 0} appStatus={statusFor(m.url)} />
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
    </div>
  );
}
