// Batch auto-tailor kits UI (PLAN 8.1/8.2; split out of JobsPage.tsx — 12.5d).
import { useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ExternalLink,
  Send,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Wand2,
} from "lucide-react";
import { Badge, Button, Card, CardTitle, ProgressRing, useToast } from "../../components/ui";
import { getKitsState, startKitBatch, subscribeKits } from "../../state/kitsStore";
import type { JobMatch, KitJobIn, KitOut } from "../../types";
import { CompanyAvatar, JobResultCard } from "./cards";
import { inputCls, sourceLabel } from "./shared";

// Batch auto-tailor (PLAN 8.1): jobs at/above the fit threshold become queued
// "application kits" — the backend tailors them one process-next call at a
// time while the user keeps browsing.
export const KIT_MAX_BATCH = 10; // mirrors the backend's MAX_BATCH
export const KIT_DEFAULT_THRESHOLD = 75;
export const KIT_THRESHOLDS = [60, 65, 70, 75, 80, 85, 90] as const;

export function kitJobFromMatch(m: JobMatch): KitJobIn {
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

export function BatchTailorCard({
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

export function KitRow({
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
