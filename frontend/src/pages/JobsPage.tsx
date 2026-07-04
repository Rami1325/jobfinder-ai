import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ArrowRight,
  BadgeCheck,
  Briefcase,
  ExternalLink,
  Link2,
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
  getJobHistory,
  matchJobs,
  searchContext,
} from "../api/client";
import ResumeUpload from "../components/ResumeUpload";
import {
  getJobSearchState,
  startJobSearch,
  subscribeJobSearch,
} from "../state/jobSearchStore";
import { useMasterResume } from "../hooks/useMasterResume";
import { masterResumeLabel, useSaveMasterResume } from "../hooks/useSaveMasterResume";
import { Badge, Button, Card, CardTitle, ProgressRing, Skeleton, useToast } from "../components/ui";
import type { FactsLedger, JobMatch, JobSearchHit, ResumeModel, SearchContext } from "../types";

const inputCls =
  "rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none disabled:opacity-50";

const WORK_MODES = ["any", "remote", "onsite", "hybrid"] as const;

// Selectable job boards (PROVIDERS registry ids). Empty/absent = all boards.
const SOURCE_IDS = ["linkedin", "drushim", "comeet"] as const;

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

function MatchCard({ m, best }: { m: JobMatch; best: boolean }) {
  const nav = useNavigate();
  const { t } = useTranslation("jobs");
  return (
    <Card className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <ProgressRing value={m.overall} size={92} stroke={8} label={t("card.fit")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {best && <Badge tone="mint">{t("card.best")}</Badge>}
          <p className="truncate font-semibold text-ink">{m.title || t("card.untitled")}</p>
          {m.source && <Badge className="shrink-0">{sourceLabel(m.source)}</Badge>}
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
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-semibold text-ink">{hit.title || t("card.untitled")}</p>
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

export default function JobsPage() {
  const { t } = useTranslation("jobs");
  const { master, loading, setMaster } = useMasterResume();
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
  const { searching, result: searchResult, error: searchError } = useSyncExternalStore(
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

  async function loadHistory() {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const h = await getJobHistory();
      setHistory(h.hits);
    } catch (e: any) {
      setHistoryError(e?.response?.data?.detail || t("history.loadError"));
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

  function toggleCustomize(checked: boolean) {
    setCustomOpen(checked);
    if (checked && !ctx && master?.resume && !prefilling) {
      setPrefilling(true);
      searchContext(master.resume)
        .then(setCtx)
        .catch(() => setCtx({ job_title: "", location: "", work_mode: "any", limit: 10 }))
        .finally(() => setPrefilling(false));
    }
  }

  function runSearch() {
    if (!master?.resume || searching) return;
    startJobSearch(master.resume, customOpen ? ctx : null);
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
      m ?? { resume: r, ledger: l, label: masterResumeLabel(r), updated_at: new Date().toISOString() },
    );
    setShowReplace(false);
    setCtx(null); // search context derives from the résumé — drop stale prefill
    if (firstUpload && !searching) {
      setAutoSearched(true);
      setMode("search");
      startJobSearch(r, null); // magic moment: upload → jobs appear
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
      setError(e?.response?.data?.detail || e?.message || t("manual.fetchError"));
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
      setError(e?.response?.data?.detail || t("manual.genericError"));
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
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-mint/40 bg-mint/10 px-3 py-1 text-xs font-medium text-mint">
            <BadgeCheck size={13} className="shrink-0" />
            <span className="truncate">{master.label || t("common:masterResume.chipFallback")}</span>
          </span>
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

          {searching && (
            <div className="space-y-3">
              <p className="text-sm text-ink-muted">
                {autoSearched ? t("search.searchingAuto") : t("search.searchingManual")}
              </p>
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

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
                  <MatchCard key={m.url || i} m={m} best={m === bestMatch} />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
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
                  <MatchCard key={i} m={m} best={i === 0} />
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
