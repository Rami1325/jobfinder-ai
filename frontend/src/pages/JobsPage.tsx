import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
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
  searchJobs,
} from "../api/client";
import ResumeGate from "../components/ResumeGate";
import { useMasterResume } from "../hooks/useMasterResume";
import { Badge, Button, Card, CardTitle, ProgressRing, Skeleton, useToast } from "../components/ui";
import type { JobMatch, JobSearchHit, JobSearchResult, SearchContext } from "../types";

const inputCls =
  "rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none disabled:opacity-50";

const WORK_MODES = [
  { value: "any", label: "Any" },
  { value: "remote", label: "Remote" },
  { value: "onsite", label: "On-site" },
  { value: "hybrid", label: "Hybrid" },
];

function MatchCard({ m, best }: { m: JobMatch; best: boolean }) {
  const nav = useNavigate();
  return (
    <Card className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <ProgressRing value={m.overall} size={92} stroke={8} label="Fit" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {best && <Badge tone="mint">Best match</Badge>}
          <p className="truncate font-semibold text-ink">{m.title || "Untitled role"}</p>
        </div>
        <p className="text-sm text-ink-muted">
          {m.company || "—"}
          {m.location ? ` · ${m.location}` : ""}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
          <span>ATS coverage {Math.round(m.keyword_coverage)}%</span>
          <span>Recruiter fit {Math.round(m.fit_score)}%</span>
          {m.url && (
            <a
              href={m.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-accent-soft hover:underline"
            >
              <ExternalLink size={12} /> View on LinkedIn
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
        icon={<ArrowRight size={15} />}
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
        Tailor to this
      </Button>
    </Card>
  );
}

function HistoryRow({ hit, onDelete }: { hit: JobSearchHit; onDelete: (id: number) => void }) {
  const nav = useNavigate();
  return (
    <Card className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <ProgressRing value={hit.overall} size={64} stroke={6} label="Fit" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-ink">{hit.title || "Untitled role"}</p>
        <p className="text-sm text-ink-muted">
          {hit.company || "—"}
          {hit.location ? ` · ${hit.location}` : ""}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
          <span>Searched {hit.searched_at.slice(0, 10)}</span>
          {hit.url && (
            <a
              href={hit.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-accent-soft hover:underline"
            >
              <ExternalLink size={12} /> Open on LinkedIn
            </a>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<ArrowRight size={14} />}
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
          Tailor
        </Button>
        <button
          onClick={() => onDelete(hit.id)}
          title="Remove from history"
          className="rounded-lg border border-line p-2 text-ink-muted transition-colors hover:border-danger/50 hover:text-danger"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </Card>
  );
}

export default function JobsPage() {
  const { master, loading } = useMasterResume();
  const [mode, setMode] = useState<"search" | "manual" | "history">("search");
  const toast = useToast();

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
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<JobSearchResult | null>(null);
  const [searchError, setSearchError] = useState("");

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
      setHistoryError(e?.response?.data?.detail || "Could not load your search history.");
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
      toast("error", "Could not delete that entry.");
    }
  }

  async function clearAll() {
    setClearing(true);
    try {
      await clearJobHistory();
      setHistory([]);
      setConfirmClear(false);
      toast("success", "History cleared");
    } catch {
      toast("error", "Could not clear history.");
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

  async function runSearch() {
    if (!master?.resume) return;
    setSearching(true);
    setSearchError("");
    setSearchResult(null);
    try {
      const r = await searchJobs(master.resume, customOpen ? ctx : null);
      setSearchResult(r);
      if (!ctx) setCtx(r.context); // so opening Customize later starts from what was searched
      if (history !== null) loadHistory(); // backend saved the results — keep the History tab fresh
    } catch (e: any) {
      setSearchError(e?.response?.data?.detail || "Something went wrong.");
    } finally {
      setSearching(false);
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
      if (text.trim().length < 20) throw new Error("No readable text found at that URL.");
      setListings((p) => [...p, text]);
      setUrl("");
      toast("success", "Fetched job posting");
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "Could not fetch that URL.");
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
      setError(e?.response?.data?.detail || "Something went wrong.");
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!master?.resume) return <ResumeGate feature="job matching" />;

  const searched = searchResult?.context;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
          <Briefcase className="text-accent-soft" /> Job match
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Find LinkedIn jobs that fit your master résumé — or add listings yourself — and rank
          them best to worst.
        </p>
      </div>

      <div className="flex gap-2">
        {(
          [
            { key: "search", label: "Find on LinkedIn" },
            { key: "manual", label: "Paste / URL" },
            { key: "history", label: history ? `History (${history.length})` : "History" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setMode(t.key)}
            className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${
              mode === t.key
                ? "border-accent/60 bg-bg-soft text-ink"
                : "border-line text-ink-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {mode === "search" && (
        <>
          <Card>
            <CardTitle>Find jobs on LinkedIn</CardTitle>
            <p className="mt-1 text-sm text-ink-muted">
              We read your résumé, work out what role and location to search for, scan LinkedIn's
              public job listings, and rank every match by fit. Fully automatic — or customize
              the search below.
            </p>

            <label className="mt-4 flex w-fit cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={customOpen}
                onChange={(e) => toggleCustomize(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              Customize search
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
                      Job title
                      <input
                        value={ctx?.job_title ?? ""}
                        disabled={prefilling}
                        onChange={(e) =>
                          setCtx((p) => ({ ...(p as SearchContext), job_title: e.target.value }))
                        }
                        placeholder={prefilling ? "Detecting from your résumé…" : "e.g. Backend Engineer"}
                        className={inputCls}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
                      Location
                      <input
                        value={ctx?.location ?? ""}
                        disabled={prefilling}
                        onChange={(e) =>
                          setCtx((p) => ({ ...(p as SearchContext), location: e.target.value }))
                        }
                        placeholder={prefilling ? "Detecting from your résumé…" : "e.g. Tel Aviv, Israel"}
                        className={inputCls}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
                      Work mode
                      <select
                        value={ctx?.work_mode ?? "any"}
                        disabled={prefilling}
                        onChange={(e) =>
                          setCtx((p) => ({ ...(p as SearchContext), work_mode: e.target.value }))
                        }
                        className={inputCls}
                      >
                        {WORK_MODES.map((w) => (
                          <option key={w.value} value={w.value}>
                            {w.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
                      Jobs to rank (1–25)
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
                Find jobs for me
              </Button>
              {searchError && <span className="text-sm text-danger">{searchError}</span>}
            </div>
          </Card>

          {searching && (
            <div className="space-y-3">
              <p className="text-sm text-ink-muted">
                Searching LinkedIn and scoring each job against your résumé — this can take a
                minute or two.
              </p>
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          <AnimatePresence>
            {searchResult && !searching && (
              <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                {searched && (
                  <p className="text-sm text-ink-muted">
                    Searched <span className="font-semibold text-ink">{searched.job_title}</span>
                    {searched.location && (
                      <>
                        {" "}in <span className="font-semibold text-ink">{searched.location}</span>
                      </>
                    )}
                    {searched.work_mode !== "any" && ` · ${searched.work_mode}`} —{" "}
                    {searchResult.matches.length} job
                    {searchResult.matches.length === 1 ? "" : "s"} ranked
                    {searchResult.skipped > 0 && `, ${searchResult.skipped} skipped`}
                  </p>
                )}
                {searchResult.matches.map((m, i) => (
                  <MatchCard key={m.url || i} m={m} best={i === 0} />
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
              <CardTitle>Paste a listing</CardTitle>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Paste a job description…"
                className="mt-3 min-h-[140px] w-full resize-y rounded-xl border border-line bg-bg-soft p-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
              />
              <Button size="sm" className="mt-2" variant="secondary" icon={<Plus size={14} />} disabled={draft.trim().length < 20} onClick={addDraft}>
                Add listing
              </Button>
            </Card>

            <Card>
              <CardTitle>Add by URL</CardTitle>
              <p className="mt-1 text-xs text-ink-muted">We fetch the page and extract the text.</p>
              <div className="mt-3 flex gap-2">
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://…/job-posting"
                  className={`flex-1 ${inputCls}`}
                />
                <Button size="sm" variant="secondary" loading={fetching} icon={<Link2 size={14} />} onClick={addUrl}>
                  Fetch
                </Button>
              </div>

              {listings.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                    {listings.length} listing{listings.length > 1 ? "s" : ""} queued
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
              Rank {listings.length > 0 ? listings.length : ""} job{listings.length === 1 ? "" : "s"} by fit
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
                Retry
              </Button>
            </Card>
          )}

          {!historyLoading && !historyError && history && history.length === 0 && (
            <Card>
              <CardTitle>No saved searches yet</CardTitle>
              <p className="mt-1 text-sm text-ink-muted">
                Run a job search — every scraped job is saved here so you can apply later.
              </p>
            </Card>
          )}

          {!historyLoading && !historyError && history && history.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-ink-muted">
                  <span className="font-semibold text-ink">{history.length}</span> of 100 saved
                </p>
                {confirmClear ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-ink-muted">Delete all {history.length}?</span>
                    <Button size="sm" variant="danger" loading={clearing} onClick={clearAll}>
                      Yes, clear all
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={14} />}
                    onClick={() => setConfirmClear(true)}
                  >
                    Clear all
                  </Button>
                )}
              </div>
              {history.map((hit) => (
                <HistoryRow key={hit.id} hit={hit} onDelete={deleteHit} />
              ))}
            </motion.div>
          )}
        </>
      )}
    </div>
  );
}
