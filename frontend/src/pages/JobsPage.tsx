import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Briefcase, Plus, Link2, Trophy, ArrowRight, X } from "lucide-react";
import { fetchJob, matchJobs } from "../api/client";
import ResumeGate from "../components/ResumeGate";
import { useMasterResume } from "../hooks/useMasterResume";
import { Badge, Button, Card, CardTitle, ProgressRing, Skeleton, useToast } from "../components/ui";
import type { JobMatch } from "../types";

export default function JobsPage() {
  const { master, loading } = useMasterResume();
  const [listings, setListings] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [matches, setMatches] = useState<JobMatch[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const nav = useNavigate();
  const toast = useToast();

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
          <Briefcase className="text-accent-soft" /> Job match
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Add listings (paste or by URL) and rank them by fit against your master résumé.
        </p>
      </div>

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
              className="flex-1 rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
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
              <Card key={i} className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <ProgressRing value={m.overall} size={92} stroke={8} label="Fit" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {i === 0 && <Badge tone="mint">Best match</Badge>}
                    <p className="truncate font-semibold text-ink">{m.title || "Untitled role"}</p>
                  </div>
                  <p className="text-sm text-ink-muted">{m.company || "—"}</p>
                  <div className="mt-2 flex flex-wrap gap-3 text-xs text-ink-muted">
                    <span>ATS coverage {Math.round(m.keyword_coverage)}%</span>
                    <span>Recruiter fit {Math.round(m.fit_score)}%</span>
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
                  onClick={() => nav("/app", { state: { jdText: m.jd_text } })}
                >
                  Tailor to this
                </Button>
              </Card>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
