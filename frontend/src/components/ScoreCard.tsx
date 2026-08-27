import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import type { CoverageResult, FabricationFlag } from "../types";
import { Card, CardTitle, ProgressRing, Stamp } from "./ui";
import { cn } from "../lib/cn";

/**
 * The fabrication guard surfaced as a first-class number next to the match —
 * no competitor can show this. Clicking scrolls to the trust panel.
 */
function GuardTile({ flags }: { flags: FabricationFlag[] }) {
  const { t } = useTranslation("tailor");
  const clean = flags.length === 0;
  return (
    <button
      type="button"
      onClick={() => document.getElementById("trust-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
      className="group flex flex-col items-center gap-3"
      title={t("score.guardDetail")}
    >
      <div className="relative transition-transform group-hover:scale-105">
        <div
          className={cn(
            "flex h-28 w-28 flex-col items-center justify-center rounded-full border-[6px]",
            clean ? "border-mint/60 bg-mint/10" : "border-danger/60 bg-danger/10",
          )}
        >
          {clean ? <ShieldCheck size={24} className="text-mint" /> : <ShieldAlert size={24} className="text-danger" />}
          <span className="mt-0.5 text-2xl font-bold tabular-nums text-ink">{flags.length}</span>
        </div>
        <span className="pointer-events-none absolute inset-x-0 -bottom-2 flex justify-center">
          <Stamp tone={clean ? "mint" : "danger"} delay={1.4}>
            {clean ? t("score.stampVerified") : t("score.stampReview")}
          </Stamp>
        </span>
      </div>
      <p className="text-sm font-semibold text-ink">{t("score.guard")}</p>
      <motion.span
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.2, duration: 0.35 }}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
          clean ? "bg-mint/10 text-mint" : "bg-danger/10 text-danger",
        )}
      >
        {clean ? t("score.guardClean") : t("score.guardFlags", { count: flags.length })}
      </motion.span>
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.2, duration: 0.35 }}
        className="max-w-[26ch] text-center text-xs leading-snug text-ink-faint"
      >
        {clean ? t("score.guardNoteClean") : t("score.guardNoteFlags", { count: flags.length })}
      </motion.p>
    </button>
  );
}

interface Props {
  /** Live, deterministic, recomputed from the document as it stands. */
  coverage: CoverageResult | null;
  coverageStale?: boolean;
  /** One model reading. Null until a fit check or a tailor has produced one. */
  fitScore: number | null;
  /** The model's own sentence about that reading. */
  rationale?: string;
  /** When the fit reading was taken, epoch ms. */
  scoredAt: number | null;
  flags: FabricationFlag[];
}

/**
 * Two numbers on two different clocks, and the guard.
 *
 * This replaced six rings — before/after pairs for keyword coverage, recruiter
 * fit, and a blended `overall`. Every part of that was a problem:
 *
 *   * `overall` is `0.5*coverage + 0.5*fit`: a live deterministic half averaged
 *     with a frozen model sample. Half of it is stale by construction, which is
 *     what the old body copy was apologising for when it said the rings "still
 *     show the fully-AI version". No amount of recomputation fixes a blend.
 *
 *   * A before→after pair on FIT is two samples at temperature 0.3. A few points
 *     either way is sampling noise, not an improvement, and rendering it with an
 *     up-arrow claims otherwise.
 *
 * So: coverage is live and shows its own raw count, because "24 of 31 terms" is
 * checkable in a way that "78%" is not. Fit is one reading with the time it was
 * taken and no delta. The guard is unchanged — it was always live and always
 * deterministic.
 */
export default function ScoreCard({ coverage, coverageStale, fitScore, rationale, scoredAt, flags }: Props) {
  const { t, i18n } = useTranslation("tailor");
  const time =
    scoredAt !== null
      ? new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(scoredAt)
      : "";

  return (
    <Card>
      <CardTitle>{t("fit.title")}</CardTitle>
      <div className="mt-5 grid grid-cols-1 gap-8 sm:grid-cols-2 sm:gap-6 xl:grid-cols-3 xl:gap-4">
        {/* --- live, deterministic ---------------------------------------- */}
        <div className="flex flex-col items-center gap-3">
          <div className={cn("transition-opacity", coverageStale && "opacity-60")}>
            <ProgressRing value={coverage?.keyword_coverage ?? 0} size={112} tone="accent" delay={0.1} />
          </div>
          <p className="text-sm font-semibold text-ink">{t("fit.coverage")}</p>
          {coverage && (
            // The partial count is not a detail. `scorer.keyword_analysis`
            // credits a partial 0.5 toward coverage_pct while `covered` counts
            // only status === "covered", so the ring and this line were two
            // different arithmetics: 3 covered / 3 partial / 4 missing renders
            // a 45% ring above "3 of 10". Stating all three is what makes the
            // percentage above it add up.
            <p className="text-xs tabular-nums text-ink-muted">
              {t("fit.coverageSub", {
                covered: coverage.covered,
                total: coverage.total,
                partial: coverage.partial,
              })}
            </p>
          )}
          <p className="max-w-[30ch] text-center text-xs leading-snug text-ink-faint">{t("fit.coverageNote")}</p>
        </div>

        {/* --- one model reading, timestamped, never animated -------------- */}
        <div className="flex flex-col items-center gap-3">
          {fitScore === null ? (
            <div className="flex h-28 w-28 items-center justify-center rounded-full border-[6px] border-line">
              <span className="px-2 text-center text-[11px] font-medium leading-tight text-ink-faint">
                {t("fit.notMeasured")}
              </span>
            </div>
          ) : (
            <ProgressRing value={fitScore} size={112} tone="mint" delay={0.1} />
          )}
          <p className="text-sm font-semibold text-ink">{t("fit.recruiter")}</p>
          <p className="max-w-[32ch] text-center text-xs leading-snug text-ink-faint">
            {fitScore === null ? t("fit.notMeasuredNote") : t("fit.asOf", { time })}
          </p>
        </div>

        <GuardTile flags={flags} />
      </div>
      {rationale && fitScore !== null && (
        <p className="mt-6 text-sm leading-relaxed text-ink-muted">{rationale}</p>
      )}
    </Card>
  );
}
