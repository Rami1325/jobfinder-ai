import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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
  Trash2,
} from "lucide-react";
import {
  approveKit,
  downloadResume,
  getKit,
  rejectKit,
  resumeFilename,
  saveKitCoverLetter,
} from "../api/client";
import ChangeLog from "../components/ChangeLog";
import CoverLetter from "../components/CoverLetter";
import MatchReport from "../components/MatchReport";
import VoicePanel from "../components/VoicePanel";
import { apiErrorMessage } from "../lib/apiError";
import { UNDO_MS } from "../lib/undoableDelete";
import { putKit, removeKitUndoable } from "../state/kitsStore";
import { editContainsValue, mergeForReview } from "../lib/resumeDiff";
import { Badge, Button, Card, CardTitle, ProgressRing, Skeleton, Stamp, useToast } from "../components/ui";
import type { KitDetail, KitOut } from "../types";
import { sourceLabel } from "./jobs/shared";

// A draft's state as a chip (the tracker's To review draws the four it lists).
const STATUS_TONE: Record<KitOut["status"], "neutral" | "mint" | "partial" | "danger"> = {
  queued: "neutral",
  running: "partial",
  done: "mint",
  failed: "danger",
  approved: "mint",
  rejected: "neutral",
  submitted: "mint",
};

/** Review one batch-tailored draft (PLAN 8.2; a "kit" in the code): the
 * per-bullet accept/reject diff, match report, guard status, and cover letter —
 * then Approve it onto its job in the tracker or Reject it with a reason.
 * Reuses the Tailor page's prop-driven components; decisions live in local
 * state, and the effective resume they produce is what gets approved and
 * downloaded. Since PLAN 31.4/5 it is reached from the tracker's To review and
 * from its job's page, and it is where a draft is deleted; an approved draft's
 * Comeet send is on its job's page. */
export default function KitReviewPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation("jobs");
  const toast = useToast();
  const nav = useNavigate();

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
        if (!alive) return;
        setKit(k);
        // The letter this kit's page generated before, which the card below
        // mounts with. It lived in page state alone, so a reload lost it.
        setCover(k.cover_letter ?? "");
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

  /** A new letter from the card: shown at once, and stored on the kit so a
   * reload shows it again. A failed save says so, because the letter is then
   * on this page and nowhere else. */
  function onCoverGenerated(text: string) {
    setCover(text);
    if (!kit) return;
    saveKitCoverLetter(kit.id, text).catch(() => toast("error", t("kitReview.coverSaveError")));
  }

  function mergeReview(updated: KitOut) {
    setKit((k) => (k ? { ...k, ...updated } : k));
    // The tracker's To review and the Tracker tab's count read the store, and
    // nothing else would tell it the draft was decided.
    putKit(updated);
  }

  /** Delete the draft, with the undo window every delete in the app waits out
   * (check-mirrors 51), and go back to where drafts wait. */
  function onDelete() {
    if (!kit) return;
    const undo = removeKitUndoable(kit, () => toast("error", t("kits.deleteError")));
    toast("info", t("kits.deleted"), {
      action: { label: t("common:actions.undo"), onClick: undo },
      durationMs: UNDO_MS,
    });
    nav("/tracker", { state: { show: "review" } });
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
      to="/tracker"
      state={{ show: "review" }}
      className="tap-44 inline-flex items-center gap-1.5 text-sm font-semibold text-accent-soft hover:underline"
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
  // The row an approval put the draft on; the tracker when none is linked.
  const jobHref = kit.application_id ? `/applications/${kit.application_id}` : "/tracker";

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
                className="tap-44 inline-flex items-center gap-1 text-accent-soft hover:underline"
              >
                <ExternalLink size={12} />{" "}
                {t("card.openOn", { source: sourceLabel(kit.source, i18n.language) || "LinkedIn" })}
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
              className="min-h-11 flex-1"
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
              className="min-h-11 flex-1"
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

      {/* A decided draft is its job's now: both banners lead to the job's page,
          where it is downloaded, written a letter for, and (Comeet) sent. */}
      {kit.status === "approved" && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-mint/40 bg-mint/10 px-3 py-2 text-sm text-mint">
          <span>{t("kitReview.approvedBanner")}</span>
          <Link to={jobHref} className="tap-44 font-semibold underline">
            {t("kitReview.openJob")}
          </Link>
        </div>
      )}
      {kit.status === "submitted" && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-mint/40 bg-mint/10 px-3 py-2 text-sm text-mint">
          <span>{t("kitReview.submittedBanner")}</span>
          {kit.submit_note && (
            <a href={kit.submit_note} target="_blank" rel="noreferrer" className="tap-44 font-semibold underline">
              {t("kits.questionnaireLink")}
            </a>
          )}
          <Link to={jobHref} className="tap-44 font-semibold underline">
            {t("kitReview.openJob")}
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
            <Button variant="danger" size="sm" loading={rejecting} onClick={onReject} className="min-h-11">
              {t("kitReview.confirmReject")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRejectOpen(false)} className="min-h-11">
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
            <CoverLetter
              resume={effectiveResume}
              jd={kit.jd}
              onGenerated={onCoverGenerated}
              onEdited={onCoverGenerated}
              initialText={cover}
              postingText={kit.jd_text}
            />
          )}
        </>
      )}

      {/* Where a draft is deleted since the Jobs page's Kits tab went (PLAN
          31.4/5). A draft still queued gives its use back; one that ran keeps it. */}
      <div className="flex justify-center pt-2">
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 size={15} />}
          className="min-h-11 text-ink-muted hover:text-danger"
          disabled={approving || rejecting}
          onClick={onDelete}
        >
          {t("kits.delete")}
        </Button>
      </div>
    </motion.div>
  );
}
