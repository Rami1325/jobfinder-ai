import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Check,
  Download,
  ExternalLink,
  ShieldAlert,
  ShieldCheck,
  ThumbsDown,
} from "lucide-react";
import {
  approveKit,
  downloadResume,
  getKit,
  rejectKit,
  resumeFilename,
} from "../api/client";
import ChangeLog from "../components/ChangeLog";
import CoverLetter from "../components/CoverLetter";
import MatchReport from "../components/MatchReport";
import VoicePanel from "../components/VoicePanel";
import { apiErrorMessage } from "../lib/apiError";
import { editContainsValue, mergeForReview } from "../lib/resumeDiff";
import { Badge, Button, Card, CardTitle, ProgressRing, Skeleton, Stamp, useToast } from "../components/ui";
import type { KitDetail, KitOut } from "../types";

// Mirrors the Kits tab chips on JobsPage.
const STATUS_TONE: Record<KitOut["status"], "neutral" | "mint" | "partial" | "danger"> = {
  queued: "neutral",
  running: "partial",
  done: "mint",
  failed: "danger",
  approved: "mint",
  rejected: "neutral",
  submitted: "mint",
};

/** Review one application kit (PLAN 8.2): the per-bullet accept/reject diff,
 * match report, guard status, and cover letter — then Approve into the
 * tracker (ready to send) or Reject with a reason. Reuses the Tailor page's
 * prop-driven components; decisions live in local state, and the effective
 * resume they produce is what gets approved and downloaded. */
export default function KitReviewPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation("jobs");
  const toast = useToast();

  const [kit, setKit] = useState<KitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [rejectedEdits, setRejectedEdits] = useState<string[]>([]);
  const [cover, setCover] = useState("");
  const [approving, setApproving] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [downloading, setDownloading] = useState<"docx" | "pdf" | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError("");
    getKit(Number(id))
      .then((k) => {
        if (alive) setKit(k);
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(apiErrorMessage(e, t("kitReview.loadError")));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Same three memos as TailorPage (5.3): one merge walk emits the edit list
  // AND the effective resume, so decisions can never drift from the diff.
  const base = kit?.base_resume ?? null;
  const tailored = kit?.result?.tailored_resume ?? null;
  const rejectedSet = useMemo(() => new Set(rejectedEdits), [rejectedEdits]);
  const merged = useMemo(
    () => (base && tailored ? mergeForReview(base, tailored, rejectedSet) : null),
    [base, tailored, rejectedSet],
  );
  const edits = merged?.edits ?? [];
  const effectiveResume = merged?.resume ?? tailored;

  // A flag is resolved when every edit carrying its value was rejected
  // (same rule ChangeLog renders); unresolved flags warn next to Approve.
  const unresolvedFlags = useMemo(() => {
    const flags = kit?.result?.fabrication_flags ?? [];
    return flags.filter((f) => {
      const carriers = edits.filter((e) => editContainsValue(e, f.value));
      return !(carriers.length > 0 && carriers.every((c) => rejectedSet.has(c.id)));
    }).length;
  }, [kit, edits, rejectedSet]);

  function mergeReview(updated: KitOut) {
    setKit((k) => (k ? { ...k, ...updated } : k));
  }

  async function onApprove() {
    if (!kit) return;
    setApproving(true);
    try {
      // No rejections => let the backend use the kit's full tailored resume.
      mergeReview(await approveKit(kit.id, rejectedSet.size > 0 ? effectiveResume : null, cover));
      toast("success", t("kitReview.approvedToast"));
    } catch (e: unknown) {
      toast("error", apiErrorMessage(e, t("kitReview.approveError")));
    } finally {
      setApproving(false);
    }
  }

  async function onReject() {
    if (!kit) return;
    setRejecting(true);
    try {
      mergeReview(await rejectKit(kit.id, rejectReason));
      setRejectOpen(false);
      toast("info", t("kitReview.rejectedToast"));
    } catch (e: unknown) {
      toast("error", apiErrorMessage(e, t("kitReview.rejectError")));
    } finally {
      setRejecting(false);
    }
  }

  async function onDownload(fmt: "docx" | "pdf") {
    if (!kit || !effectiveResume) return;
    setDownloading(fmt);
    try {
      await downloadResume(
        effectiveResume,
        fmt,
        resumeFilename(effectiveResume.contact?.name ?? "", kit.company),
      );
    } catch (e: unknown) {
      toast("error", apiErrorMessage(e, t("kitReview.downloadError")));
    } finally {
      setDownloading(null);
    }
  }

  const backLink = (
    <Link
      to="/jobs"
      state={{ tab: "kits" }}
      className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent-soft hover:underline"
    >
      <ArrowLeft size={15} className="rtl:-scale-x-100" /> {t("kitReview.back")}
    </Link>
  );

  if (loading) {
    return (
      <div className="space-y-4">
        {backLink}
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (loadError || !kit) {
    return (
      <div className="space-y-4">
        {backLink}
        <Card>
          <p className="text-sm text-danger">{loadError || t("kitReview.loadError")}</p>
        </Card>
      </div>
    );
  }

  const reviewable = kit.status === "done";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-5"
    >
      {backLink}

      <Card className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <ProgressRing value={kit.score_after} size={92} stroke={8} label={t("kits.after")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="min-w-0 max-w-full truncate text-xl font-bold text-ink">
              {kit.job_title || t("card.untitled")}
            </h1>
            <Badge tone={STATUS_TONE[kit.status]} className="shrink-0">
              {t(`kits.status.${kit.status}`)}
            </Badge>
            {kit.flag_count > 0 ? (
              <Badge tone="danger" className="inline-flex shrink-0 items-center gap-1">
                <ShieldAlert size={11} /> {t("kits.guardFlags", { count: kit.flag_count })}
              </Badge>
            ) : (
              <Badge tone="mint" className="inline-flex shrink-0 items-center gap-1">
                <ShieldCheck size={11} /> {t("kits.guardClean")}
              </Badge>
            )}
            {/* The guard's verdict, stamped (B1). Decorative — the badges above
                stay the textual source of truth. Skipped for rejected kits so
                an "APPROVED" stamp never sits next to a Rejected chip. */}
            {kit.result && kit.status !== "rejected" && (
              <Stamp
                tone={kit.flag_count > 0 ? "danger" : "mint"}
                delay={0.3}
                className="ms-1 shrink-0"
              >
                {kit.flag_count > 0 ? <ShieldAlert size={11} /> : <ShieldCheck size={11} />}
                {kit.flag_count > 0 ? t("kitReview.stampFlags") : t("kitReview.stampClean")}
              </Stamp>
            )}
          </div>
          <p className="text-sm text-ink-muted">
            {kit.company || "—"}
            {kit.location ? ` · ${kit.location}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
            <span className="font-semibold text-ink">
              {t("kits.score", {
                before: Math.round(kit.score_before),
                after: Math.round(kit.score_after),
              })}
            </span>
            <span>{t("kits.searchFit", { pct: Math.round(kit.search_overall) })}</span>
            {kit.url && (
              <a
                href={kit.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent-soft hover:underline"
              >
                <ExternalLink size={12} />{" "}
                {t("card.openOn", { source: kit.source || "LinkedIn" })}
              </a>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-2">
          <Button
            icon={<Check size={15} />}
            loading={approving}
            disabled={!reviewable || rejecting}
            onClick={onApprove}
          >
            {t("kitReview.approve")}
          </Button>
          <Button
            variant="ghost"
            icon={<ThumbsDown size={14} />}
            disabled={!reviewable || approving}
            onClick={() => setRejectOpen((v) => !v)}
          >
            {t("kitReview.reject")}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              icon={<Download size={13} />}
              loading={downloading === "docx"}
              disabled={!effectiveResume}
              onClick={() => onDownload("docx")}
            >
              DOCX
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              icon={<Download size={13} />}
              loading={downloading === "pdf"}
              disabled={!effectiveResume}
              onClick={() => onDownload("pdf")}
            >
              PDF
            </Button>
          </div>
        </div>
      </Card>

      {reviewable && unresolvedFlags > 0 && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          {t("kitReview.unresolvedFlags", { count: unresolvedFlags })}
        </div>
      )}

      {kit.status === "approved" && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-mint/40 bg-mint/10 px-3 py-2 text-sm text-mint">
          <span>{t("kitReview.approvedBanner")}</span>
          <Link to="/tracker" className="font-semibold underline">
            {t("kitReview.viewInTracker")}
          </Link>
        </div>
      )}
      {kit.status === "submitted" && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-mint/40 bg-mint/10 px-3 py-2 text-sm text-mint">
          <span>{t("kitReview.submittedBanner")}</span>
          {kit.submit_note && (
            <a href={kit.submit_note} target="_blank" rel="noreferrer" className="font-semibold underline">
              {t("kits.questionnaireLink")}
            </a>
          )}
          <Link to="/tracker" className="font-semibold underline">
            {t("kitReview.viewInTracker")}
          </Link>
        </div>
      )}
      {kit.status === "rejected" && (
        <div className="rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm text-ink-muted">
          {t("kitReview.rejectedBanner")}
          {kit.reject_reason && (
            <span dir="auto"> — {kit.reject_reason}</span>
          )}
        </div>
      )}
      {(kit.status === "queued" || kit.status === "running") && (
        <Card>
          <p className="text-sm text-ink-muted">{t("kitReview.notReady")}</p>
        </Card>
      )}
      {kit.status === "failed" && (
        <Card>
          <p dir="auto" className="text-sm text-danger">
            {t("kitReview.failed", { error: kit.error })}
          </p>
        </Card>
      )}

      {rejectOpen && reviewable && (
        <Card>
          <CardTitle>{t("kitReview.rejectTitle")}</CardTitle>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder={t("kitReview.rejectPlaceholder")}
            dir="auto"
            className="mt-3 min-h-[70px] w-full resize-y rounded-xl border border-line bg-bg-soft p-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
          />
          <div className="mt-3 flex items-center gap-2">
            <Button variant="danger" size="sm" loading={rejecting} onClick={onReject}>
              {t("kitReview.confirmReject")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRejectOpen(false)}>
              {t("common:actions.cancel")}
            </Button>
          </div>
        </Card>
      )}

      {kit.result && base && tailored && (
        <>
          <p className="text-xs text-ink-muted">{t("kitReview.downloadNote")}</p>
          {/* Humanization audit (16.4): same panel as the Tailor page — voice
              score and positioning story. Old kits stored
              before Phase 16 have no voice_report and render nothing. */}
          <VoicePanel
            report={kit.result.voice_report}
            plan={kit.result.plan}
          />
          <ChangeLog
            edits={edits}
            changelog={kit.result.changelog}
            flags={kit.result.fabrication_flags}
            jdKeywords={kit.jd?.keywords ?? []}
            rejected={rejectedSet}
            onSetRejected={setRejectedEdits}
            original={base}
            effective={effectiveResume}
            lengthReport={kit.result.length_report}
            plan={kit.result.plan}
          />
          {effectiveResume && kit.jd_text && (
            <MatchReport gaps={kit.result.score_after.gaps} jdText={kit.jd_text} />
          )}
          {effectiveResume && kit.jd && (
            <CoverLetter resume={effectiveResume} jd={kit.jd} onGenerated={setCover} initialText={cover} />
          )}
        </>
      )}
    </motion.div>
  );
}
