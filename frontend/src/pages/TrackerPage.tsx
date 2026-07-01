import { useEffect, useState } from "react";
import { Trash2, Eye, Download } from "lucide-react";
import {
  deleteApplication,
  downloadResume,
  getApplication,
  listApplications,
  updateApplication,
} from "../api/client";
import ResumeView from "../components/ResumeView";
import { Badge, Button, Card, Modal, Skeleton, useToast } from "../components/ui";
import { cn } from "../lib/cn";
import type { ApplicationDetail, ApplicationOut } from "../types";

const COLUMNS: { key: string; label: string; tone: "neutral" | "accent" | "partial" | "mint" | "danger" }[] = [
  { key: "saved", label: "Saved", tone: "neutral" },
  { key: "applied", label: "Applied", tone: "accent" },
  { key: "interview", label: "Interview", tone: "partial" },
  { key: "offer", label: "Offer", tone: "mint" },
  { key: "rejected", label: "Rejected", tone: "danger" },
];
const STATUSES = COLUMNS.map((c) => c.key);

export default function TrackerPage() {
  const [apps, setApps] = useState<ApplicationOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const toast = useToast();

  async function refresh() {
    setLoading(true);
    try {
      setApps(await listApplications());
    } catch {
      setError("Could not load applications. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function changeStatus(id: number, status: string) {
    const updated = await updateApplication(id, { status });
    setApps((prev) => prev.map((a) => (a.id === id ? updated : a)));
  }

  async function remove(id: number) {
    await deleteApplication(id);
    setApps((prev) => prev.filter((a) => a.id !== id));
    toast("info", "Application deleted");
  }

  async function view(id: number) {
    setOpen(true);
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await getApplication(id));
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">Application tracker</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {apps.length} application{apps.length === 1 ? "" : "s"} · move them across stages as you go.
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : apps.length === 0 ? (
        <Card className="text-center">
          <p className="text-sm text-ink-muted">
            No applications yet. Tailor a résumé and click “Save to tracker”.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {COLUMNS.map((col) => {
            const items = apps.filter((a) => (a.status || "saved") === col.key);
            return (
              <div key={col.key} className="flex flex-col gap-3">
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    <Badge tone={col.tone}>{col.label}</Badge>
                  </div>
                  <span className="text-xs text-ink-faint">{items.length}</span>
                </div>
                <div className="flex flex-col gap-3">
                  {items.map((a) => (
                    <div
                      key={a.id}
                      className="rounded-xl border border-line bg-gradient-to-b from-panel to-panel/70 p-3.5 shadow-card"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-ink">{a.job_title || "—"}</p>
                          <p className="truncate text-xs text-ink-muted">{a.company || "—"}</p>
                        </div>
                        <span
                          className={cn(
                            "shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums",
                            a.overall_score >= 80
                              ? "bg-mint/15 text-mint"
                              : a.overall_score >= 60
                                ? "bg-warn/15 text-warn"
                                : "bg-panel-2 text-ink-muted",
                          )}
                        >
                          {Math.round(a.overall_score)}%
                        </span>
                      </div>
                      <div className="mt-2 text-[11px] text-ink-faint">{a.created_at?.slice(0, 10)}</div>
                      <div className="mt-3 flex items-center gap-1.5">
                        <select
                          value={a.status}
                          onChange={(e) => changeStatus(a.id, e.target.value)}
                          className="flex-1 rounded-lg border border-line bg-bg-soft px-2 py-1.5 text-xs capitalize text-ink focus:border-accent/60 focus:outline-none"
                        >
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => view(a.id)}
                          title="View"
                          className="rounded-lg border border-line p-1.5 text-ink-muted hover:text-ink"
                        >
                          <Eye size={15} />
                        </button>
                        <button
                          onClick={() => remove(a.id)}
                          title="Delete"
                          className="rounded-lg border border-line p-1.5 text-ink-muted hover:border-danger/50 hover:text-danger"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={detail ? `${detail.job_title || "Résumé"}${detail.company ? " · " + detail.company : ""}` : "Loading…"}
      >
        {detailLoading && <Skeleton className="h-64 w-full" />}
        {detail && (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <Badge tone="accent">Match {Math.round(detail.overall_score)}%</Badge>
              <div className="flex-1" />
              {detail.tailored_resume && (
                <>
                  <Button size="sm" icon={<Download size={15} />} onClick={() => downloadResume(detail.tailored_resume!, "docx")}>
                    .docx
                  </Button>
                  <Button size="sm" variant="secondary" icon={<Download size={15} />} onClick={() => downloadResume(detail.tailored_resume!, "pdf")}>
                    .pdf
                  </Button>
                </>
              )}
            </div>
            {detail.tailored_resume ? (
              <ResumeView resume={detail.tailored_resume} />
            ) : (
              <p className="text-sm text-ink-muted">No saved résumé for this entry.</p>
            )}
            {detail.cover_letter && (
              <>
                <h3 className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                  Cover letter
                </h3>
                <div className="whitespace-pre-wrap rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink">
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
