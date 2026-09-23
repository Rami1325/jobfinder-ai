// Batch auto-tailor (PLAN 8.1; split out of JobsPage.tsx — 12.5d). The drafts it
// makes are reviewed from the tracker's To review since PLAN 31.4/5, where the
// Jobs page's Kits tab went.
import { useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Wand2 } from "lucide-react";
import { Button, Card, CardTitle, useToast } from "../../components/ui";
import UsesNote from "../../components/UsesNote";
import { useUses } from "../../lib/usesStore";
import { getKitsState, startKitBatch, subscribeKits } from "../../state/kitsStore";
import type { JobMatch } from "../../types";
import { inputCls, kitJobFromMatch, normalizeJobUrl } from "./shared";

// Batch auto-tailor (PLAN 8.1): jobs at/above the fit threshold become queued
// "application kits" — the backend tailors them one process-next call at a
// time while the user keeps browsing.
export const KIT_MAX_BATCH = 10; // mirrors the backend's MAX_BATCH
export const KIT_DEFAULT_THRESHOLD = 75;
export const KIT_THRESHOLDS = [60, 65, 70, 75, 80, 85, 90] as const;

export function BatchTailorCard({
  matches,
  attractKey,
}: {
  matches: JobMatch[];
  /** Changes when a fresh search lands — restarts the attention pulse (PLAN
   * 15.9: users scrolled straight past this card to the result rows). */
  attractKey?: number | null;
}) {
  const { t } = useTranslation("jobs");
  const { t: tCommon } = useTranslation();
  const toast = useToast();
  const nav = useNavigate();
  const { batching, total, done, lastKit, lastBatch, error, kits } = useSyncExternalStore(
    subscribeKits,
    getKitsState,
  );
  const uses = useUses("tailor");
  const [threshold, setThreshold] = useState<number>(KIT_DEFAULT_THRESHOLD);
  // Threshold the DISPLAYED integer, not the raw float. The card, the fit ring
  // and the alert email all show `Math.round(overall)`, so a job at 74.6 reads
  // as "75% fit" on the very row this control filters — and the backend's
  // `alerts.displayed_score` rounds the same way for the 75% mail. Comparing
  // the float here made this queue the one surface that disagreed, which is
  // exactly what sharing the number 75 with KIT_DEFAULT_THRESHOLD was for.
  const qualifying = matches
    .filter((m) => m.url && m.jd_text && Math.round(m.overall) >= threshold)
    .sort((a, b) => b.overall - a.overall);
  // A job that already holds a kit (anything but a failed one) is skipped by the
  // server and costs nothing, so here it takes no place in the batch and no use
  // (Phase 30 / C4). A kits list never loaded subtracts nothing: the server decides.
  const kitted = new Set(
    (kits ?? []).filter((k) => k.status !== "failed" && k.url).map((k) => normalizeJobUrl(k.url)),
  );
  const fresh = qualifying.filter((m) => !kitted.has(normalizeJobUrl(m.url)));
  // Every new kit uses 1, paid when the batch is queued, and the server refuses
  // a whole batch bigger than what is left. So the batch stops at what is left.
  const room = uses.remaining === null ? KIT_MAX_BATCH : Math.min(KIT_MAX_BATCH, uses.remaining);
  const eligible = fresh.slice(0, room);
  const usesCapped =
    uses.remaining !== null && uses.remaining > 0 && uses.remaining < Math.min(KIT_MAX_BATCH, fresh.length);
  // The line under the button: the cap when uses cut the batch short, else how
  // many this batch uses. One kit reads UsesNote's own sentence, and none left
  // reads its zero line.
  const batchLine = usesCapped
    ? tCommon("uses.batchCap", { count: eligible.length, total: fresh.length })
    : eligible.length > 1
      ? tCommon("uses.batchNote", { count: eligible.length, remaining: uses.remaining ?? 0 })
      : undefined;

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
    <Card className="relative">
      {/* Post-search attention pulse: an accent ring that breathes three times
          then goes quiet. Only the overlay's opacity animates (compositor-cheap
          per the 12.5e rules); the reduced-motion killswitch disables it. */}
      {!batching && attractKey != null && eligible.length > 0 && (
        <span
          key={attractKey}
          aria-hidden
          className="animate-kit-attract pointer-events-none absolute -inset-px rounded-xl2 border-2 border-accent/70 shadow-[0_0_24px_rgb(var(--accent)/0.35)]"
        />
      )}
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
      {!batching && qualifying.length === 0 && (
        <p className="mt-2 text-xs text-ink-muted">{t("batch.none", { threshold })}</p>
      )}
      {!batching && qualifying.length > 0 && fresh.length === 0 && (
        <p className="mt-2 text-xs text-ink-muted">{t("batch.allSkipped")}</p>
      )}
      {!batching && (eligible.length > 0 || (uses.out && fresh.length > 0)) && (
        <UsesNote feature="tailor" className="mt-2">
          {batchLine}
        </UsesNote>
      )}
      {/* The per-run cap, unless uses cut the batch shorter and said so above. */}
      {!batching && !usesCapped && eligible.length >= KIT_MAX_BATCH && (
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
          {/* The drafts wait in the tracker's To review (PLAN 31.4/5). */}
          <button
            onClick={() => nav("/tracker", { state: { show: "review" } })}
            className="font-semibold text-accent-soft hover:underline"
          >
            {t("batch.viewKits")}
          </button>
        </div>
      )}
    </Card>
  );
}
