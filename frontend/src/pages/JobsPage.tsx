import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import {
  BadgeCheck,
  Briefcase,
  Globe,
  Link2,
  Loader2,
  Plus,
  Search,
  Send,
  Trash2,
  Trophy,
  Wand2,
  X,
} from "lucide-react";
import {
  clearJobHistory,
  deleteJobHistoryItem,
  fetchJob,
  getJobHistory,
  getSearchPrefs,
  listApplications,
  matchJobs,
  searchContext,
  updateSearchPrefs,
} from "../api/client";
import ResumeUpload from "../components/ResumeUpload";
import {
  cancelJobSearch,
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
  subscribeKits,
} from "../state/kitsStore";
import { useMasterResume } from "../hooks/useMasterResume";
import { apiErrorMessage } from "../lib/apiError";
import { resumeLanguage } from "../lib/lang";
import { onboardingRole } from "../lib/onboarding";
import { masterResumeLabel, useSaveMasterResume } from "../hooks/useSaveMasterResume";
import { Button, Card, CardTitle, Modal, Skeleton, useToast } from "../components/ui";
import type {
  ApplicationOut,
  FactsLedger,
  JobMatch,
  JobSearchHit,
  KitOut,
  ResumeModel,
  SearchContext,
} from "../types";
import { AlertsCard, CustomizeFields } from "./jobs/AlertsCard";
import { HistoryRow, MatchCard, RestrictedRow } from "./jobs/cards";
import { BatchTailorCard, KitRow } from "./jobs/kits";
import { SkillsEditorModal } from "./jobs/SkillsEditor";
import { VersionHistoryModal } from "./jobs/VersionHistory";
import { SearchScanPanel } from "./jobs/ScanPanel";
import { EASE, inputCls, normalizeJobUrl, SOURCE_IDS, sourceLabel } from "./jobs/shared";


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
  const [showSkills, setShowSkills] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
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

  // Saved customize picks (server-side, per user): prefill and open the panel
  // so a returning user doesn't re-enter everything. Anything the user typed
  // before the response lands wins; a missing/old backend just means no prefill.
  useEffect(() => {
    getSearchPrefs()
      .then((saved) => {
        if (!saved) return;
        setCtx((prev) => prev ?? saved);
        setCustomOpen(true);
      })
      .catch(() => {});
  }, []);
  // The search itself lives in a module-level store so it keeps running (and
  // its result is still here) if the user navigates away mid-search.
  const {
    searching,
    result: searchResult,
    error: searchError,
    startedAt,
    progress: searchProgress,
    liveMatches,
    cancelled,
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
  /** The backend stamps `application_status` on every match, matching by
   * LinkedIn job id and across the `also_on` boards. The local map only
   * compares trimmed URLs, so it misses a tracked job whose card URL carries
   * tracking params or a different slug — prefer the server's answer and keep
   * this as the fallback for a backend that predates the field. */
  const statusFor = (m: JobMatch) =>
    m.application_status || (m.url ? appStatusByUrl.get(normalizeJobUrl(m.url)) : undefined);

  // "Hide applied": statuses that mean the user has already acted on the job.
  // `saved` is deliberately NOT one of them — saving is how you say "come back
  // to this", so hiding it would bury the shortlist.
  const [hideApplied, setHideApplied] = useState(false);
  // A one-way "show me anyway", not a saved preference: tapping it reveals the
  // postings we dropped for a stated hiring restriction and does NOT re-run the
  // search. Reset per result below, or the previous search's reveal leaks into
  // the next one's list.
  const [showRestricted, setShowRestricted] = useState(false);
  const isDone = (m: JobMatch) => {
    const s = statusFor(m);
    return !!s && s !== "saved";
  };
  const visible = (list: JobMatch[]) => (hideApplied ? list.filter((m) => !isDone(m)) : list);

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
    // Remember the picks a customized search ran with (or clear them when the
    // panel is off) so the next visit prefills — best-effort, never blocks.
    updateSearchPrefs(customOpen ? ctx : null).catch(() => {});
  }

  useEffect(() => {
    if (!searchResult) return;
    setCtx((p) => p ?? searchResult.context); // so opening Customize later starts from what was searched
    setSourceErrorsDismissed(false); // a fresh result gets a fresh warning
    setShowRestricted(false); // a fresh result starts with the filtered set collapsed
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
  // Only offer the "hide applied" toggle when it would actually do something.
  const appliedCount = searchResult ? searchResult.matches.filter(isDone).length : 0;
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
        <p className="mt-1 hidden text-sm text-ink-muted sm:block">
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
          {masters.length > 0 && (
            <button
              onClick={() => setShowSkills(true)}
              className="text-xs font-semibold text-accent-soft hover:underline"
            >
              {t("skillsEditor.open")}
            </button>
          )}
          {masters.length > 0 && (
            <button
              onClick={() => setShowVersions(true)}
              className="text-xs font-semibold text-accent-soft hover:underline"
            >
              {t("versions.open")}
            </button>
          )}
        </div>
      </div>

      <SkillsEditorModal
        open={showSkills}
        onClose={() => setShowSkills(false)}
        masters={masters}
        onSaved={setMaster}
      />

      <VersionHistoryModal
        open={showVersions}
        onClose={() => setShowVersions(false)}
        onRestored={setMaster}
      />

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
            <p className="mt-1 hidden text-sm text-ink-muted sm:block">
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
              {searching && (
                <Button size="sm" variant="secondary" onClick={cancelJobSearch}>
                  {t("search.cancel")}
                </Button>
              )}
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
          {liveMatches.length > 0 &&
            (searching || (!searchResult && (!!searchError || cancelled))) && (
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
              ) : cancelled ? (
                <p className="text-sm text-ink-muted">
                  {t("search.streaming.cancelled", { count: liveMatches.length })}
                </p>
              ) : (
                <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
                  {t("search.streaming.interrupted", { count: liveMatches.length })}
                </div>
              )}
              {visible(liveMatches).map((m, i) => (
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
                  <MatchCard m={m} best={i === 0} appStatus={statusFor(m)} />
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
                      {(searched.work_mode === "remote" || searched.work_mode === "any") &&
                        searched.include_worldwide &&
                        ` · ${t("search.worldwideTag")}`}
                      {" — "}
                      {t("search.ranked", { count: searchResult.matches.length })}
                      {searchResult.skipped > 0 && t("search.skipped", { count: searchResult.skipped })}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-4">
                    {appliedCount > 0 && (
                      <label
                        className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-ink-muted"
                        title={t("search.hideAppliedHint")}
                      >
                        <input
                          type="checkbox"
                          checked={hideApplied}
                          onChange={(e) => setHideApplied(e.target.checked)}
                          className="h-3.5 w-3.5 accent-mint"
                        />
                        {t("search.hideApplied", { count: appliedCount })}
                      </label>
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
                </div>
                {(searchResult.filtered?.length ?? 0) > 0 && (
                  <p className="flex flex-wrap items-center gap-2 text-xs text-warn">
                    <Globe size={13} className="shrink-0" />
                    {/* "Every job" is only true when nothing was dropped for
                        another reason — `skipped` counts postings that failed
                        to fetch or score, and claiming they stated a
                        restriction contradicts the "N skipped" line directly
                        above. */}
                    {searchResult.matches.length === 0 && searchResult.skipped === 0
                      ? t("search.geoAllFiltered")
                      : t("search.geoFiltered", { count: searchResult.filtered!.length })}
                    <button
                      type="button"
                      onClick={() => setShowRestricted((v) => !v)}
                      className="font-semibold underline underline-offset-2"
                    >
                      {t(showRestricted ? "search.geoHide" : "search.geoShow")}
                    </button>
                  </p>
                )}
                {sortedMatches.length > 0 && (
                  <BatchTailorCard
                    matches={searchResult.matches}
                    onViewKits={() => setMode("kits")}
                    attractKey={startedAt}
                  />
                )}
                {visible(sortedMatches).map((m, i) => (
                  <motion.div
                    key={m.url || i}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: EASE, delay: Math.min(i, 12) * 0.04 }}
                  >
                    <MatchCard m={m} best={m === bestMatch} appStatus={statusFor(m)} />
                  </motion.div>
                ))}
                {showRestricted &&
                  (searchResult.filtered ?? []).map((job, i) => (
                    <RestrictedRow key={job.url || `filtered-${i}`} job={job} />
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
                {visible(matches).map((m, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: EASE, delay: Math.min(i, 12) * 0.04 }}
                  >
                    <MatchCard m={m} best={i === 0} appStatus={statusFor(m)} />
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
