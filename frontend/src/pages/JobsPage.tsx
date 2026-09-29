import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import {
  BadgeCheck,
  Banknote,
  Briefcase,
  Building2,
  CheckCheck,
  Ghost,
  Globe,
  Laptop,
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
  getHiddenJobs,
  getJobHistory,
  getSearchPrefs,
  listApplications,
  matchJobs,
  putHiddenJobs,
  searchContext,
  updateSearchPrefs,
  whichHidden,
} from "../api/client";
import ResumeUpload from "../components/ResumeUpload";
import {
  cancelJobSearch,
  getJobSearchState,
  startJobSearch,
  subscribeJobSearch,
} from "../state/jobSearchStore";
import { useMasterResume } from "../hooks/useMasterResume";
import { apiErrorMessage } from "../lib/apiError";
import { scheduleUndoable, UNDO_MS } from "../lib/undoableDelete";
import { resumeLanguage } from "../lib/lang";
import { openTarget, postingLink } from "../lib/openJob";
import { useUses } from "../lib/usesStore";
import { masterResumeLabel, useSaveMasterResume } from "../hooks/useSaveMasterResume";
import { Button, Card, CardTitle, Skeleton, useToast } from "../components/ui";
import UsesNote from "../components/UsesNote";
import type {
  ApplicationOut,
  FactsLedger,
  HiddenJobs,
  JobMatch,
  JobSearchHit,
  ResumeModel,
  SearchContext,
  SearchQueryReading,
} from "../types";
import { AlertSwitch, CustomizeFields } from "./jobs/AlertsCard";
import { HistoryRow, MatchCard, RestrictedRow } from "./jobs/cards";
import { HiddenCount, HiddenManager, NotForMeNotice, type HiddenNotice } from "./jobs/NotForMe";
import { NeedsYou } from "./jobs/NeedsYou";
import { BatchTailorCard, KIT_THRESHOLDS } from "./jobs/kits";
import { SkillsEditorModal } from "./jobs/SkillsEditor";
import { SearchScanPanel } from "./jobs/ScanPanel";
import { PlainSearch, usePlainSearch } from "./jobs/PlainSearch";
import { FreelanceNote, NotFreelanceCount, SearchModeSwitch, useSearchMode } from "./jobs/FreelanceMode";
import {
  allowsRemote,
  applySearchReading,
  EASE,
  filteredSummary,
  inputCls,
  normalizeJobUrl,
  parseWorkModes,
  searchedSources,
  searchedSourcesFor,
  sourceLabel,
} from "./jobs/shared";

// The most listings one ranking takes: the backend's job_match.MAX_MATCH_LISTINGS,
// which answers more with a 400 (Phase 30 / B4.3).
const MAX_MATCH_LISTINGS = 10;

/** "N jobs you applied to are not shown" (Phase 32). The SERVER leaves out every
 * job the tracker holds at applied, interview, offer or rejected, from a search
 * and from the saved matches (app/core/applied_jobs.py), and counts them; this
 * only says the count, quietly, and nothing at all for none. Not a control: the
 * jobs live in the tracker, one tab away. */
function AppliedCount({ count }: { count: number }) {
  const { t } = useTranslation("jobs");
  if (count <= 0) return null;
  return (
    <p className="flex items-start gap-2 text-xs text-ink-muted">
      <CheckCheck size={13} aria-hidden className="mt-px shrink-0" />
      <span className="min-w-0">{t("applied.count", { count })}</span>
    </p>
  );
}

export default function JobsPage() {
  const { t, i18n } = useTranslation("jobs");
  const { master, masters, loading, setMaster } = useMasterResume();
  const persistMaster = useSaveMasterResume();
  // No Kits tab since PLAN 31.4/5: a batch's drafts wait on their jobs in the
  // tracker's To review, and each is reviewed, sent or deleted from its pages.
  // No History tab since PLAN 31.5/3: the page OPENS on your matches, the saved
  // ones newest first under the search, so a return visit starts with jobs,
  // not an empty form. Paste / URL is the one other view.
  const [mode, setMode] = useState<"matches" | "manual">("matches");
  const toast = useToast();
  const nav = useNavigate();
  // A search and a ranking each use 1 (Phase 30 / B4); none left disables both.
  // This page's search is served free while the pool's first one is open (PLAN 31.5).
  const searchUses = useUses("search", undefined, true);

  // -- Resume upload state (Jobs is the front door: upload lives here too) --
  const [showReplace, setShowReplace] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [sourceErrorsDismissed, setSourceErrorsDismissed] = useState(false);

  // -- History state --
  const [history, setHistory] = useState<JobSearchHit[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  // -- "Not for me" (PLAN 31.5/4) --
  // The SERVER holds the set and does every match (app/core/hidden_jobs.py):
  // searches and History leave hidden postings out and say how many. This page
  // keeps the set to edit it, the rows of THIS view the server says are now
  // covered (`gone`, by URL), and the notice a hidden row leaves behind.
  const [hidden, setHidden] = useState<HiddenJobs | null>(null);
  const [historyHidden, setHistoryHidden] = useState(0);
  // Saved matches the server left out because the user applied to them since (Phase 32).
  const [historyApplied, setHistoryApplied] = useState(0);
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<HiddenNotice | null>(null);
  const [hideManager, setHideManager] = useState(false);
  useEffect(() => {
    getHiddenJobs()
      .then(setHidden)
      .catch(() => {}); // an older backend: nothing hidden, and no control offers it
  }, []);

  // -- Find on LinkedIn state --
  const [customOpen, setCustomOpen] = useState(false);
  // RESULTS FIRST (PLAN 31.2/6). Once a search has answered, its card folds to
  // one line ("Backend Engineer in Tel Aviv — 10 ranked · Edit") and the jobs
  // start under it; the whole card stood between the user and the results.
  // "Edit" unfolds it, and the next search folds it again.
  const [editSearch, setEditSearch] = useState(false);
  // "Jobs / Freelance & contract" (2026-09-28): the mode the NEXT search runs in,
  // remembered on this device. The results say the mode THEIR search ran in
  // (`resultMode`, from the store), whatever the switch says since.
  const [searchMode, setSearchMode] = useSearchMode();
  const [ctx, setCtx] = useState<SearchContext | null>(null);
  const [prefilling, setPrefilling] = useState(false);
  // Search in plain words (Phase 32). The line and its answer live here, so the
  // card can fold and unfold around the box without losing either.
  const plain = usePlainSearch();
  /** A line that said something fills the form's own fields and OPENS them, so
   * the user sees what was understood and taps Find jobs themselves: a search is
   * a monthly use, and a misread line must be seen before it costs one. */
  function onPlainRead(reading: SearchQueryReading) {
    setCtx((prev) => applySearchReading(prev, reading));
    setCustomOpen(true);
    setEditSearch(true);
  }

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
    dropped,
    mode: resultMode,
  } = useSyncExternalStore(subscribeJobSearch, getJobSearchState);
  const freelanceResult = resultMode === "freelance";
  // A dropped stream may still finish on the server and write its jobs to
  // History (the store has already let go of the cached copy), so the History
  // tab reads again the next time it opens instead of showing what it held.
  useEffect(() => {
    if (dropped) setHistory(null);
  }, [dropped]);
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
  // The row the card's saved icon opens (PLAN 31.4/6): the server's, else the
  // newest tracked row with the same URL.
  const appIdByUrl = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of apps) if (a.job_url && !map.has(normalizeJobUrl(a.job_url))) map.set(normalizeJobUrl(a.job_url), a.id);
    return map;
  }, [apps]);
  const idFor = (m: JobMatch) => m.application_id ?? (m.url ? appIdByUrl.get(normalizeJobUrl(m.url)) : undefined) ?? null;

  // No "Hide applied" toggle since Phase 32: the SERVER leaves every job the
  // tracker holds at applied, interview, offer or rejected out of a search and
  // of the saved matches, and counts them (`AppliedCount`), so a list here never
  // holds one to hide. `saved` stays shown, marked, as it always was.
  // A one-way "show me anyway", not a saved preference: tapping it reveals the
  // postings the search dropped before scoring (a stated hiring restriction, a
  // closed posting, or a worldwide posting in a country where pay is well below
  // Israel's) and does NOT re-run the search. Reset per result below, or the
  // previous search's reveal leaks into the next one's list.
  const [showRestricted, setShowRestricted] = useState(false);
  const visible = (list: JobMatch[]) => list.filter((m) => !m.url || !gone.has(normalizeJobUrl(m.url)));

  async function loadHistory() {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const h = await getJobHistory();
      setHistory(h.hits);
      setHistoryHidden(h.hidden ?? 0);
      setHistoryApplied(h.applied ?? 0);
    } catch (e: any) {
      setHistoryError(apiErrorMessage(e, t("history.loadError")));
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    if (mode === "matches" && history === null && !historyLoading) loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // AN ALERT EMAIL'S LINK (PLAN 31.4/6): `/jobs?open=<posting URL>` opens that job
  // in the app. A tracked job opens its own page; an untracked one opens History
  // with its row in view and ringed, where its fit, its reasons and Tailor are; a
  // posting History no longer holds (it keeps the newest 100) says so. Read once
  // and dropped, so Back or a reload never runs it again, and only ever COMPARED:
  // the one link made from it is a plain http(s) posting link, in that last case.
  const [searchParams, setSearchParams] = useSearchParams();
  const openParam = searchParams.get("open");
  const [openedHit, setOpenedHit] = useState<number | null>(null);
  const [openMissing, setOpenMissing] = useState<string | null>(null);
  useEffect(() => {
    if (!openParam) return;
    let live = true;
    void (async () => {
      const [rows, hits] = await Promise.all([
        listApplications().catch(() => [] as ApplicationOut[]),
        getJobHistory()
          .then((h) => h.hits)
          .catch(() => null),
      ]);
      if (!live) return;
      const target = openTarget(openParam, hits, rows, normalizeJobUrl);
      if (target.kind === "job") {
        nav(`/applications/${target.id}`, { replace: true });
        return;
      }
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("open");
          return next;
        },
        { replace: true },
      );
      if (hits) setHistory(hits);
      setMode("matches");
      setOpenedHit(target.kind === "hit" ? target.id : null);
      // "Not in your history" only when History answered: a History that could
      // not be read loads again on its tab, which says so itself.
      setOpenMissing(target.kind === "missing" && hits !== null ? openParam : null);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openParam]);
  // The opened row, brought into view once History has drawn it.
  useEffect(() => {
    if (openedHit !== null && mode === "matches" && history)
      document.getElementById(`hit-${openedHit}`)?.scrollIntoView({ block: "center" });
  }, [openedHit, mode, history]);

  const NOTHING_HIDDEN: HiddenJobs = { urls: [], companies: [], title_words: [] };

  /** Save the whole set; the server answers with it canonical. Null on failure,
   * which puts the set back and says so. */
  async function saveHidden(next: HiddenJobs): Promise<HiddenJobs | null> {
    const before = hidden;
    setHidden(next);
    try {
      const saved = await putHiddenJobs(next);
      setHidden(saved);
      return saved;
    } catch (e: any) {
      setHidden(before);
      toast("error", apiErrorMessage(e, t("hide.saveError")));
      return null;
    }
  }

  /** Which of this view's results the hides now cover, asked of the SERVER, so a
   * company or a word is never matched here; then History, which the server
   * filters and counts itself. */
  async function syncHidden() {
    const rows = searchResult?.matches.filter((m) => m.url) ?? [];
    if (rows.length) {
      try {
        const flags = await whichHidden(rows.map((m) => ({ url: m.url, company: m.company, title: m.title })));
        setGone(new Set(rows.filter((_, i) => flags[i]).map((m) => normalizeJobUrl(m.url))));
      } catch {
        /* the next search applies them anyway */
      }
    }
    void loadHistory();
  }

  /** "Not for me" on a row: gone at once, saved, and a notice offering more. */
  async function notForMe(row: { url: string; title: string; company: string }) {
    if (!row.url) return;
    const base = hidden ?? NOTHING_HIDDEN;
    const key = normalizeJobUrl(row.url);
    setGone((g) => new Set(g).add(key));
    setHistory((p) => (p ? p.filter((h) => normalizeJobUrl(h.url) !== key) : p));
    const saved = await saveHidden({ ...base, urls: [...base.urls, row.url] });
    if (!saved) {
      setNotice(null);
      void syncHidden();
      return;
    }
    const urlKey = saved.urls.find((u) => !base.urls.includes(u)) ?? "";
    setNotice({ title: row.title, company: row.company, url_key: urlKey, company_key: "", word_keys: [] });
    void syncHidden();
  }

  async function hideNoticeCompany() {
    if (!notice?.company) return;
    const base = hidden ?? NOTHING_HIDDEN;
    const saved = await saveHidden({ ...base, companies: [...base.companies, notice.company] });
    if (!saved) return;
    const companyKey = saved.companies.find((c) => !base.companies.includes(c)) ?? "";
    setNotice((n) => (n ? { ...n, company_key: companyKey || "-" } : n));
    void syncHidden();
  }

  async function hideNoticeWord(word: string) {
    if (!notice) return;
    const base = hidden ?? NOTHING_HIDDEN;
    const saved = await saveHidden({ ...base, title_words: [...base.title_words, word] });
    if (!saved) return;
    const wordKey = saved.title_words.find((w) => !base.title_words.includes(w)) ?? word.toLocaleLowerCase();
    setNotice((n) => (n ? { ...n, word_keys: [...n.word_keys, wordKey] } : n));
    void syncHidden();
  }

  /** Undo takes back exactly what this notice added, by the server's own keys. */
  async function undoNotice() {
    if (!notice) return;
    const base = hidden ?? NOTHING_HIDDEN;
    const saved = await saveHidden({
      urls: base.urls.filter((u) => u !== notice.url_key),
      companies: base.companies.filter((c) => c !== notice.company_key),
      title_words: base.title_words.filter((w) => !notice.word_keys.includes(w)),
    });
    if (!saved) return;
    setNotice(null);
    void syncHidden();
  }

  // PLAN 31.1/6: the row leaves at once and the server delete waits out the undo
  // window; Undo, or a failed delete, puts it back where it was.
  function deleteHit(id: number) {
    const index = history?.findIndex((h) => h.id === id) ?? -1;
    if (!history || index === -1) return;
    const row = history[index];
    setHistory((p) => (p ? p.filter((h) => h.id !== id) : p));
    const restore = () =>
      setHistory((p) => {
        if (!p || p.some((h) => h.id === id)) return p;
        const at = Math.min(index, p.length);
        return [...p.slice(0, at), row, ...p.slice(at)];
      });
    const cancel = scheduleUndoable(
      () => deleteJobHistoryItem(id),
      () => {
        restore();
        toast("error", t("history.deleteError"));
      },
    );
    toast("info", t("history.deleted"), {
      action: {
        label: t("common:actions.undo"),
        onClick: () => {
          cancel();
          restore();
        },
      },
      durationMs: UNDO_MS,
    });
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
        .then((c) => setCtx(c))
        .catch(() => setCtx({ job_title: "", location: "", work_mode: "any", limit: 10 }))
        .finally(() => setPrefilling(false));
    }
  }

  // limit 0 means the customize box was emptied — block searching until it's 1–25.
  const limitInvalid = customOpen && (ctx?.limit ?? 10) < 1;

  // Boards the in-flight search was asked to scan, snapshotted at launch so
  // the scan ticker doesn't drift if the customize box is edited mid-search.
  const [requestedSources, setRequestedSources] = useState<string[]>(() => searchedSources(null));

  function runSearch() {
    if (!master?.resume || searching || limitInvalid) return;
    // Not customized: null, and the backend derives the role, place and mode
    // from the resume (SEARCH_CONTEXT, a daily count and no monthly use).
    const c = customOpen ? ctx : null;
    // The boards this search will ask: a worldwide-only board (Himalayas, Jobicy)
    // only with the worldwide pass on, as the backend's fan-out does; a freelance
    // search turns the pass on and never asks Drushim or Greenhouse.
    setRequestedSources(searchedSourcesFor(c, searchMode));
    startJobSearch(master.resume, c, searchMode);
    // Remember the picks a customized search ran with (or clear them when the
    // panel is off) so the next visit prefills — best-effort, never blocks.
    updateSearchPrefs(customOpen ? ctx : null).catch(() => {});
  }

  useEffect(() => {
    if (!searchResult) return;
    setEditSearch(false);
    setCtx((p) => p ?? searchResult.context); // so opening Customize later starts from what was searched
    setSourceErrorsDismissed(false); // a fresh result gets a fresh warning
    setShowRestricted(false); // a fresh result starts with the filtered set collapsed
    if (history !== null) loadHistory(); // backend saved the results — keep the History tab fresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchResult]);

  /** Save an uploaded resume as the master (shared logic with TailorPage) and
   * update this page in place — no reload needed.
   *
   * It starts NO search, for every plan (Phase 30 / C10). The first upload used
   * to run one by itself, and a search now uses 1 of the month's uses: a new
   * user spent one on a search they never tapped, under copy saying uploading
   * is free. Not gated on the plan either, because the admin is exempt whatever
   * `plan` says, so a plan-gated auto-search would be a flow the owner never
   * sees on his own account. A search starts from the Find jobs button, and
   * check-mirrors 32(h) keeps it there. */
  async function onResumeUploaded(r: ResumeModel, l: FactsLedger) {
    const firstUpload = !master?.resume;
    const m = await persistMaster(r, l); // best-effort — null when the backend is unreachable
    // A silent failure here is the difference between "my new resume isn't
    // taking" and a message you can act on: persistMaster swallows every error
    // and only toasts on SUCCESS, so without this the page shows the new resume
    // while the server still holds the old one, and the next reload reverts it.
    if (!m) toast("error", t("common:masterResume.saveFailed"));
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
    // The customize picks SURVIVE a resume swap. This used to `setCtx(null)`
    // to drop a stale title prefill, but ctx also carries location, work mode,
    // result count, boards, "posted within" and the worldwide opt-in — six
    // settings that have nothing to do with which file was uploaded — and
    // clearing them read, correctly, as "replacing my resume deleted my search
    // settings". A stale job title is one field the user can see and edit; the
    // other six are not worth destroying to freshen it.
    // The first upload lands on the matches, beside the search button, and that is all.
    if (firstUpload) setMode("matches");
  }

  // `/jobs/match` refuses more than MAX_MATCH_LISTINGS in one ranking (Phase 30 /
  // B4.3: one use covers one ranking, and every listing is two model calls), so
  // the queue stops at that number instead of letting the request fail.
  function addDraft() {
    if (draft.trim().length < 20 || listings.length >= MAX_MATCH_LISTINGS) return;
    setListings((p) => (p.length >= MAX_MATCH_LISTINGS ? p : [...p, draft.trim()]));
    setDraft("");
  }

  async function addUrl() {
    if (!url.trim() || listings.length >= MAX_MATCH_LISTINGS) return;
    setFetching(true);
    setError("");
    try {
      const text = await fetchJob(url);
      if (text.trim().length < 20) throw new Error(t("manual.noText"));
      setListings((p) => (p.length >= MAX_MATCH_LISTINGS ? p : [...p, text]));
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
  // Folded, too, while there are saved matches to open on (PLAN 31.5/3), and
  // while History is still unknown, so a returning visit does not open on the
  // whole form and then fold it under the thumb when the feed arrives. Only an
  // account with nothing saved yet, or an Edit, opens it.
  const hasFeed = history === null || history.length > 0;
  const searchFolded = (!!searchResult || hasFeed) && !searching && !editSearch;
  // The one-line account of what was searched and what came back, said once:
  // on the folded card, or over the results while the card is open.
  const searchSummary =
    searched && searchResult ? (
      <>
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
        {parseWorkModes(searched.work_mode).length > 0 &&
          ` · ${parseWorkModes(searched.work_mode)
            .map((w) => t(`workModes.${w}`))
            .join(", ")}`}
        {allowsRemote(searched.work_mode) && searched.include_worldwide && ` · ${t("search.worldwideTag")}`}
        {freelanceResult && ` · ${t("freelance.tag")}`}
        {" — "}
        {t("search.ranked", { count: searchResult.matches.length })}
        {searchResult.skipped > 0 && t("search.skipped", { count: searchResult.skipped })}
      </>
    ) : null;
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
  /** The saved matches, newest first (PLAN 31.5/3). They are what the page OPENS
   * on, under the folded search; History stopped being a tab of its own. With a
   * search on screen they are the EARLIER ones, the rows its results do not
   * already show, and during a search they wait, so the live results are the
   * only list. An alert email's `?open=` lands here, its row ringed. With
   * nothing saved there is nothing to say: the open search card is the way in. */
  function renderFeed() {
    if (searching) return null;
    const shownUrls = searchResult ? new Set(searchResult.matches.map((m) => normalizeJobUrl(m.url || ""))) : null;
    const rows = (sortedHistory ?? []).filter((h) => !shownUrls || !shownUrls.has(normalizeJobUrl(h.url || "")));
    return (
      <>
          {openMissing && (
            <Card className="text-sm text-ink-muted">
              {t("history.openMissing")}
              {postingLink(openMissing) && (
                <>
                  {" "}
                  <a
                    href={postingLink(openMissing) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-accent hover:underline"
                  >
                    {t("history.openPosting")}
                  </a>
                </>
              )}
            </Card>
          )}
          {historyLoading && !searchResult && (
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

          {/* What the saved matches left out, said together; the box is gone
              (`empty:hidden`) when neither count has anything to say. */}
          {!searchResult && !historyLoading && !historyError && (
            <div className="space-y-1.5 empty:hidden">
              <HiddenCount count={historyHidden} onManage={() => setHideManager(true)} />
              <AppliedCount count={historyApplied} />
            </div>
          )}

          {!historyLoading && !historyError && rows.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
              {/* ONE row at 390 px: the count, a compact sort, and Clear all as an
                  icon below sm. As three wrapping controls they took two rows
                  of the first screen, above the first job. */}
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm text-ink-muted">
                  {searchResult ? (
                    t("history.earlier")
                  ) : (
                    <Trans
                      t={t}
                      i18nKey="history.savedOf"
                      values={{ count: history?.length ?? 0 }}
                      components={[<span key="0" className="font-semibold text-ink" />]}
                    />
                  )}
                </p>
                <label className="flex shrink-0 items-center gap-2 text-xs font-semibold text-ink-muted">
                  <span className="sr-only sm:not-sr-only">{t("sort.label")}</span>
                  <select
                    value={historySort}
                    onChange={(e) => setHistorySort(e.target.value as "searched" | "fit" | "date")}
                    className="rounded-lg border border-line bg-bg-soft px-2 py-1.5 text-xs text-ink focus:border-accent/60 focus:outline-none"
                  >
                    <option value="searched">{t("sort.searched")}</option>
                    <option value="fit">{t("sort.fit")}</option>
                    <option value="date">{t("sort.date")}</option>
                  </select>
                </label>
                {confirmClear ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-ink-muted">{t("history.deleteAll", { count: history?.length ?? 0 })}</span>
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
                    className="shrink-0"
                  >
                    <span className="sr-only sm:not-sr-only">{t("history.clearAll")}</span>
                  </Button>
                )}
              </div>
              {rows.map((hit) => (
                <HistoryRow
                  key={hit.id}
                  hit={hit}
                  onDelete={deleteHit}
                  opened={hit.id === openedHit}
                  onNotForMe={hit.url ? () => void notForMe(hit) : undefined}
                />
              ))}
            </motion.div>
          )}
      </>
    );
  }

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
        </div>
      </div>

      <SkillsEditorModal
        open={showSkills}
        onClose={() => setShowSkills(false)}
        masters={masters}
        onSaved={setMaster}
      />

      {/* NOT height-animated. This wedges: measured on a clean load, the panel
          froze at 80px with a 287px dropzone clipped inside it, so "Replace"
          looked like it did nothing and the master resume could not be changed
          at all. Same defect Disclosure documents. Opacity + transform only. */}
      {showReplace && (
        <div className="animate-fade-up">
          <Card>
            <CardTitle>{t("replaceTitle")}</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">{t("replaceBody")}</p>
            <div className="mt-3">
              <ResumeUpload onParsed={onResumeUploaded} />
            </div>
          </Card>
        </div>
      )}

      {/* Each tab a 44 px target at its 38 px size (`tap-44`, the second
          tap-target pass): its layer adds 3 px above and below, inside the
          page's 24 px spacing, and every tab is wider than 44 px, so the 8 px
          between the two is untouched. Growing them would have moved the first
          saved job down 6 px. */}
      <div className="flex flex-wrap gap-2">
        {(
          [
            { key: "matches", label: t("tabs.matches") },
            { key: "manual", label: t("tabs.manual") },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setMode(tab.key)}
            className={`tap-44 whitespace-nowrap rounded-lg border px-3 py-2 text-sm font-semibold transition-colors sm:px-4 ${
              mode === tab.key
                ? "border-accent/60 bg-bg-soft text-ink"
                : "border-line text-ink-muted hover:text-ink"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {mode === "matches" && (
        <>
          {/* What is waiting on the person, at the top (PLAN 31.5/5): nothing when
              nothing, and each chip one tap from what it counts. */}
          <NeedsYou resume={master.resume} />
          {searchFolded ? (
            // ONE line over the matches (PLAN 31.5/3): what was searched, or
            // "Your latest matches", then Search again and the alert switch.
            // The whole alert form is in Settings now (AlertSwitch links there).
            <Card className="space-y-1 py-3">
              {/* What was searched, once there is a search to name. Over the
                  saved feed alone there is nothing to say that the rows under
                  it do not, and the line cost the first screen a job row. */}
              {searchSummary && (
                <p className="flex min-w-0 items-center gap-2 text-sm text-ink-muted">
                  <Search size={14} className="shrink-0 text-accent-soft" aria-hidden />
                  <span className="min-w-0 truncate">{searchSummary}</span>
                </p>
              )}
              {/* Search in plain words (Phase 32): one row, and the line is read
                  into the fields below, which open for the user to check. */}
              <PlainSearch state={plain} onRead={onPlainRead} disabled={prefilling} />
              <SearchModeSwitch mode={searchMode} onChange={setSearchMode} disabled={searching} hint={false} />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  icon={<Search size={14} />}
                  disabled={prefilling || limitInvalid || searchUses.out}
                  onClick={runSearch}
                >
                  {t("search.again")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditSearch(true)}>
                  {t("search.edit")}
                </Button>
              </div>
              <AlertSwitch />
              {searchError && <p className="text-sm text-danger">{searchError}</p>}
              {dropped && <p className="text-sm text-warn">{t("search.connectionDropped")}</p>}
              <UsesNote feature="search" firstFree />
            </Card>
          ) : (
          <Card>
            <CardTitle>{t("search.cardTitle")}</CardTitle>
            <p className="mt-1 hidden text-sm text-ink-muted sm:block">
              {t("search.cardBody")}
            </p>
            <PlainSearch state={plain} onRead={onPlainRead} disabled={prefilling} className="mt-3" />
            <SearchModeSwitch mode={searchMode} onChange={setSearchMode} disabled={searching} className="mt-3" />

            {/* A 44 px box to tap (the phone polish pass; it was a 20 px line),
                its text where it was: 4 px of margin and 12 of the box. */}
            <label className="mt-1 flex min-h-11 w-fit cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={customOpen}
                onChange={(e) => toggleCustomize(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              {t("search.customize")}
            </label>

            {/* Same wedge: frozen at 78px over 280px of fields, which is why
                the search settings READ as deleted the moment anything on this
                page re-rendered mid-animation. */}
            {customOpen && (
              <div className="animate-fade-up">
                <CustomizeFields ctx={ctx} setCtx={setCtx} prefilling={prefilling} />
              </div>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                loading={searching}
                icon={<Search size={18} />}
                disabled={prefilling || limitInvalid || searchUses.out}
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
              {/* Not an error: the server may still finish this search, and then
                  its jobs are in History and its use is kept (Phase 30 / C3). */}
              {dropped && <span className="text-sm text-warn">{t("search.connectionDropped")}</span>}
            </div>
            <UsesNote feature="search" firstFree className="mt-2" />
            <div className="mt-3">
              <AlertSwitch />
            </div>
          </Card>
          )}

          {notice && (
            <NotForMeNotice
              notice={notice}
              onHideCompany={() => void hideNoticeCompany()}
              onHideWord={(w) => void hideNoticeWord(w)}
              onUndo={() => void undoNotice()}
              onDismiss={() => setNotice(null)}
            />
          )}

          {/* The per-board progress is the best loading state in the app, and
              once the search has answered it is a receipt standing between the
              user and the jobs (measured: 440 px at 390). It folds with the
              search card; a board that failed or came back empty is still said
              above the results (`source_errors`, `source_empty`). */}
          {!searchFolded && (
          <SearchScanPanel
            searching={searching}
            startedAt={startedAt}
            progress={searchProgress}
            result={searchResult}
            requestedSources={requestedSources}
          />
          )}

          {/* Streamed match cards: each scored job lands here the moment its
              `match` frame arrives, sorted in by fit — the same MatchCard the
              final results use, so nothing visually changes when the
              authoritative result replaces them. Also the partial-results
              surface when an interrupted search still scored some jobs. */}
          {liveMatches.length > 0 &&
            (searching || (!searchResult && (!!searchError || dropped || cancelled))) && (
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
                  <MatchCard
                    m={m}
                    best={i === 0}
                    appStatus={statusFor(m)}
                    appId={idFor(m)}
                    freelance={freelanceResult}
                  />
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
                            sources: Object.keys(searchResult.source_errors)
                              .map((s) => sourceLabel(s, i18n.language))
                              .join(", "),
                          })}
                        </p>
                        <ul className="mt-1 space-y-0.5 text-xs opacity-90">
                          {Object.entries(searchResult.source_errors).map(([s, msg]) => (
                            <li key={s} dir="auto">
                              {sourceLabel(s, i18n.language)}: {msg}
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
                      sources: Object.keys(searchResult.source_empty)
                        .map((s) => sourceLabel(s, i18n.language))
                        .join(", "),
                    })}
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {/* The summary lives on the folded search card; while that
                      card is open for editing it is said here instead. */}
                  {!searchFolded && searchSummary && <p className="text-sm text-ink-muted">{searchSummary}</p>}
                  <div className="flex flex-wrap items-center gap-4">
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
                {/* Never silent (PLAN 31.5/4): what the server left out before
                    selection, plus the rows hidden in this view since; and the
                    jobs the user already applied to (Phase 32), which the server
                    left out and counted the same way. */}
                <div className="space-y-1.5 empty:hidden">
                  <HiddenCount
                    count={
                      (searchResult.hidden ?? 0) +
                      searchResult.matches.filter((m) => m.url && gone.has(normalizeJobUrl(m.url))).length
                    }
                    onManage={() => setHideManager(true)}
                  />
                  <AppliedCount count={searchResult.applied ?? 0} />
                  {freelanceResult && <NotFreelanceCount count={searchResult.not_freelance ?? 0} />}
                </div>
                {(searchResult.filtered?.length ?? 0) > 0 &&
                  (() => {
                    // Counted per reason, by name, in `filteredSummary`
                    // (jobs/shared.ts), which check-mirrors 31 executes over
                    // every mix of reasons: the sentences below are claims
                    // about the rows under them.
                    const { restricted, closed, market, workMode, notRemote, everyRestricted } =
                      filteredSummary(searchResult);
                    return (
                      <p className="flex flex-wrap items-center gap-2 text-xs text-warn">
                        {/* Each icon is held to its OWN sentence. As loose
                            flex items, an icon stayed at the end of one line
                            while its sentence wrapped onto the next, and at
                            390px the long market sentence always wraps. */}
                        {restricted > 0 && (
                          <span className="flex min-w-0 items-start gap-1.5">
                            <Globe size={13} className="mt-0.5 shrink-0" />
                            {/* "Every job" is only true when every row under
                                it states a restriction and nothing ranked or
                                was skipped (`skipped` counts postings that
                                failed to fetch or score, and claiming they
                                stated a restriction contradicts the "N skipped"
                                line directly above). `filteredSummary` decides
                                that from the rows themselves. */}
                            {everyRestricted
                              ? t("search.geoAllFiltered")
                              : t("search.geoFiltered", { count: restricted })}
                          </span>
                        )}
                        {closed > 0 && (
                          <span className="flex min-w-0 items-start gap-1.5">
                            <Ghost size={13} className="mt-0.5 shrink-0" />
                            {t("search.filteredClosed", { count: closed })}
                          </span>
                        )}
                        {market > 0 && (
                          <span className="flex min-w-0 items-start gap-1.5">
                            <Banknote size={13} className="mt-0.5 shrink-0" />
                            {t("search.filteredMarket", { count: market })}
                          </span>
                        )}
                        {workMode > 0 && (
                          <span className="flex min-w-0 items-start gap-1.5">
                            <Building2 size={13} className="mt-0.5 shrink-0" />
                            {t("search.filteredWorkMode", { count: workMode })}
                          </span>
                        )}
                        {notRemote > 0 && (
                          <span className="flex min-w-0 items-start gap-1.5">
                            <Laptop size={13} className="mt-0.5 shrink-0" />
                            {t("search.filteredNotRemote", { count: notRemote })}
                          </span>
                        )}
                        {/* ONE toggle for every sentence: `showRestricted`
                            reveals the whole `filtered` list, so a control per
                            reason would promise a filter this reveal does not
                            implement. */}
                        <button
                          type="button"
                          onClick={() => setShowRestricted((v) => !v)}
                          className="font-semibold underline underline-offset-2"
                        >
                          {t(showRestricted ? "search.geoHide" : "search.geoShow")}
                        </button>
                      </p>
                    );
                  })()}
                {visible(sortedMatches).map((m, i) => (
                  <motion.div
                    key={m.url || i}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: EASE, delay: Math.min(i, 12) * 0.04 }}
                  >
                    <MatchCard
                      m={m}
                      best={m === bestMatch}
                      appStatus={statusFor(m)}
                      appId={idFor(m)}
                      onNotForMe={m.url ? () => void notForMe(m) : undefined}
                      freelance={freelanceResult}
                    />
                  </motion.div>
                ))}
                {/* A freelance search always ends with the way to the gigs it
                    cannot read (XPlace, Upwork, LinkedIn, a group) and links to
                    look for them with this search's title, and with nothing found
                    that is the whole answer. */}
                {freelanceResult && <FreelanceNote empty={searchResult.matches.length === 0} title={searchResult.context.job_title} />}
                {showRestricted &&
                  (searchResult.filtered ?? []).map((job, i) => (
                    <RestrictedRow key={job.url || `filtered-${i}`} job={job} />
                  ))}
                {/* BELOW the jobs, since PLAN 31.2/6, and only when a job can
                    clear its bar at the lowest setting it offers: above the list
                    it stood between the user and the results, and on a search
                    with nothing strong enough it showed a disabled "Tailor 0
                    matches". Rounded as the card and the email round (the
                    displayed integer, job-search.md). */}
                {searchResult.matches.some(
                  (m) => m.url && m.jd_text && Math.round(m.overall) >= KIT_THRESHOLDS[0],
                ) && (
                  <BatchTailorCard matches={searchResult.matches} attractKey={startedAt} />
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {renderFeed()}
        </>
      )}

      {mode === "manual" && (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardTitle>{t("manual.pasteTitle")}</CardTitle>
              <textarea
                dir="auto"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t("manual.pastePlaceholder")}
                className="mt-3 min-h-[140px] w-full resize-y rounded-xl border border-line bg-bg-soft p-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
              />
              <Button size="sm" className="mt-2" variant="secondary" icon={<Plus size={14} />} disabled={draft.trim().length < 20 || listings.length >= MAX_MATCH_LISTINGS} onClick={addDraft}>
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
                <Button
                  size="sm"
                  variant="secondary"
                  loading={fetching}
                  icon={<Link2 size={14} />}
                  disabled={listings.length >= MAX_MATCH_LISTINGS}
                  onClick={addUrl}
                >
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
            <Button
              size="lg"
              loading={running}
              icon={<Trophy size={18} />}
              disabled={listings.length === 0 || searchUses.out}
              onClick={rank}
            >
              {t("manual.rank", { count: listings.length })}
            </Button>
            {/* Said where the limit bites, once the queue is full; both add
                controls above are disabled at the same number. */}
            {listings.length >= MAX_MATCH_LISTINGS && (
              <span className="text-xs text-ink-muted">{t("manual.maxListings", { max: MAX_MATCH_LISTINGS })}</span>
            )}
            {error && <span className="text-sm text-danger">{error}</span>}
            <UsesNote feature="search" firstFree className="w-full" />
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
                    <MatchCard m={m} best={i === 0} appStatus={statusFor(m)} appId={idFor(m)} />
                  </motion.div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      <HiddenManager
        open={hideManager}
        hidden={hidden}
        onChange={(next) => {
          void saveHidden(next).then((saved) => {
            if (saved) void syncHidden();
          });
        }}
        onClose={() => setHideManager(false)}
      />
    </div>
  );
}
