import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Building2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Mail,
  MessageSquareText,
  Mic,
  Send,
  Trash2,
} from "lucide-react";
import {
  analyzeJD,
  downloadResume,
  getApplication,
  listApplications,
  resumeFilename,
  updateApplication,
  type ResumeTemplate,
} from "../api/client";
import CoverLetter from "../components/CoverLetter";
import RatingSelect from "../components/RatingSelect";
import EmailTimeline from "../components/inbox/EmailTimeline";
import { formatDay, useLocaleTag } from "../components/inbox/shared";
import UsesNote from "../components/UsesNote";
import { Button, Card, CardTitle, Modal, Skeleton, useToast } from "../components/ui";
import { usePageImages } from "../hooks/useFilePreview";
import { followUpStage } from "../hooks/useJobContext";
import { useMasterResume } from "../hooks/useMasterResume";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { apiErrorMessage } from "../lib/apiError";
import { sendRefusal, sendRefusalKey } from "../lib/sendRefusal";
import { cn } from "../lib/cn";
import { TEMPLATE_IDS } from "../lib/templateSpecs";
import { useUses } from "../lib/usesStore";
import { sendKitApplication } from "../state/kitsStore";
import { getTailorState } from "../state/tailorStore";
import { useNextStep } from "../hooks/useNextStep";
import type { ApplicationDetail, ApplicationOut, JDModel } from "../types";
import { applicantsText, attributedSource, employmentText, postedAgo, proposalFirst, sourceLabel } from "./jobs/shared";

/** The tracker's statuses in board order, as the backend stores them. The board
 * (`TrackerPage`'s COLUMNS) lists the same five. */
const STATUSES = ["saved", "applied", "interview", "offer", "rejected"] as const;

/** Status → the chip face the board uses for it. */
const STATUS_FACE: Record<string, string> = {
  saved: "border-line bg-panel-2 text-ink-muted",
  applied: "border-accent/50 bg-accent/15 text-accent-soft",
  interview: "border-warn/50 bg-warn/15 text-warn",
  offer: "border-mint/50 bg-mint/15 text-mint",
  rejected: "border-danger/50 bg-danger/15 text-danger",
};

/** The template the resume was SENT in, for a download from this page; ""
 * (a row from before 17.3) or an id this build does not know renders the
 * default, never a guess (PLAN 31.1/8). */
function sentTemplate(template: string | undefined): ResumeTemplate | undefined {
  return (TEMPLATE_IDS as readonly string[]).includes(template ?? "") ? (template as ResumeTemplate) : undefined;
}

function is404(e: unknown): boolean {
  return (e as { response?: { status?: number } })?.response?.status === 404;
}

/**
 * One job, one page (PLAN 31.4). Everything the app knows about a tracked job,
 * from what its row already holds and the emails the inbox tied to it: the
 * posting, the resume made for it, its letter, the tools that prepare for it,
 * what happened and when, and the notes. It replaced the tracker's detail
 * modal. Full screen on a phone; from `lg` the applications are a list beside
 * it (master-detail), so moving between jobs is one tap.
 *
 * Viewing it never calls a model. "What they ask for" reads the analysis a fit
 * check, tailor or kit already stored; the only counted buttons are the ones
 * that say so under themselves (Tailor, and the letter's own card).
 */
export default function JobPage() {
  const { id: rawId } = useParams();
  const id = Number(rawId);
  const { t } = useTranslation("tracker");
  const wide = useMediaQuery("(min-width: 1024px)");
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "failed">("loading");

  const load = useCallback(async () => {
    if (!Number.isInteger(id) || id <= 0) {
      setState("missing");
      return;
    }
    setState((s) => (s === "ready" ? s : "loading"));
    try {
      const d = await getApplication(id);
      setDetail(d);
      setState("ready");
    } catch (e) {
      setState(is404(e) ? "missing" : "failed");
    }
  }, [id]);

  useEffect(() => {
    setDetail(null);
    setState("loading");
    void load();
  }, [load]);

  const body =
    state === "ready" && detail ? (
      <JobBody key={detail.id} detail={detail} onChange={setDetail} reload={load} />
    ) : state === "loading" ? (
      <div role="status" aria-label={t("job.loading")} className="space-y-4">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    ) : (
      <Card className="py-10 text-center">
        <p className="text-sm text-ink">{state === "missing" ? t("job.notFound") : t("job.loadError")}</p>
        <div className="mt-4 flex justify-center gap-2">
          {state === "failed" && (
            <Button size="sm" onClick={() => void load()} className="min-h-11">
              {t("job.retry")}
            </Button>
          )}
          <Link to="/tracker" className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-accent hover:underline">
            {t("job.back")}
          </Link>
        </div>
      </Card>
    );

  return (
    <div className="lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start lg:gap-8">
      {/* The master list is mounted only where it is shown: a phone never
          fetches it, and never has two copies of the job list on the page. */}
      {wide && <JobList currentId={id} />}
      <div className="min-w-0">
        {/* `tap-44` at its 36 px (the third tap-target pass): 4 px of layer
            into the page's top padding and the 12 px under it. */}
        <Link
          to="/tracker"
          className="tap-44 mb-3 inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink lg:hidden"
        >
          <ArrowLeft size={16} className="rtl:-scale-x-100" />
          {t("job.back")}
        </Link>
        {body}
      </div>
    </div>
  );
}

/** The applications beside the job on a desktop, newest first: the master half of
 * master-detail. The row on screen is marked as the current page. */
function JobList({ currentId }: { currentId: number }) {
  const { t } = useTranslation("tracker");
  const [apps, setApps] = useState<ApplicationOut[] | null>(null);
  useEffect(() => {
    let alive = true;
    listApplications()
      .then((a) => alive && setApps(a))
      .catch(() => alive && setApps([]));
    return () => {
      alive = false;
    };
    // Re-read when the job changes: a status set on the last job shows on its row.
  }, [currentId]);
  return (
    <nav aria-label={t("job.list")} className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border border-line/60 bg-panel/40 p-2">
      <Link to="/tracker" className="flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-ink-muted hover:text-ink">
        <ArrowLeft size={14} className="rtl:-scale-x-100" />
        {t("job.back")}
      </Link>
      {apps === null ? (
        <div className="space-y-2 p-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {apps.map((a) => (
            <li key={a.id}>
              <NavLink
                to={`/applications/${a.id}`}
                className={({ isActive }) =>
                  cn(
                    "block rounded-lg px-2.5 py-2 transition-colors",
                    isActive ? "bg-accent/15 text-ink" : "text-ink-muted hover:bg-panel-2 hover:text-ink",
                  )
                }
              >
                <span dir="auto" className="block truncate text-sm font-medium">
                  {a.job_title || t("job.untitled")}
                </span>
                <span className="flex items-center gap-1.5 text-xs">
                  <span dir="auto" className="min-w-0 truncate">
                    {a.company}
                  </span>
                  <span className="shrink-0 text-ink-faint">· {t(`status.${a.status || "saved"}`)}</span>
                </span>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

/** The page itself, for one loaded application. `onChange` writes a newer copy
 * of the row back to the parent; `reload` reads it again from the server (after
 * an email on it was undone, which may delete the row altogether). */
function JobBody({
  detail,
  onChange,
  reload,
}: {
  detail: ApplicationDetail;
  onChange: (d: ApplicationDetail) => void;
  reload: () => Promise<void>;
}) {
  const { t } = useTranslation("tracker");
  const { t: tJobs, i18n } = useTranslation("jobs");
  // A posting from a board that asks to be credited (Himalayas) names it on
  // its link back; the row keeps no source, so the posting's host says which.
  const credited = attributedSource(undefined, detail.job_url ?? "");
  const toast = useToast();
  const nav = useNavigate();
  const nextStep = useNextStep();

  // A PATCH answers with the list shape; the fields it can change are copied
  // onto the detail, and nothing else is guessed.
  const patch = useCallback(
    async (fields: Parameters<typeof updateApplication>[1], rollback?: () => void) => {
      try {
        const out = await updateApplication(detail.id, fields);
        onChange({
          ...detail,
          status: out.status,
          notes: out.notes,
          excitement: out.excitement,
          interviewed: out.interviewed,
          applied_at: out.applied_at ?? detail.applied_at,
          ...(fields.cover_letter !== undefined ? { cover_letter: fields.cover_letter } : {}),
          ...(fields.jd !== undefined ? { jd: fields.jd } : {}),
          ...(fields.status !== undefined && fields.status !== detail.status
            ? { status_changed_at: new Date().toISOString(), status_source: "manual" }
            : {}),
        });
        return true;
      } catch {
        rollback?.();
        return false;
      }
    },
    [detail, onChange],
  );

  async function setStatus(status: string) {
    const from = detail.status;
    if (!(await patch({ status }))) toast("error", t("job.statusError"));
    // The step after it (PLAN 31.5/6): a reminder once applied, practice once
    // it is an interview. Only a real change.
    else if (status !== from) nextStep(status, detail.id);
  }

  async function rate(n: number) {
    if (!(await patch({ excitement: n }))) toast("error", t("toasts.excitementError"));
  }

  const posted = detail.posted_at ? postedAgo(detail.posted_at, tJobs) : "";
  // The board's competition line (Phase 32), from the search history's current
  // reading of this posting; the page never fetches one, and the server sends
  // none once it is a day old.
  const competition = applicantsText(detail.applicants, tJobs);
  // The board's employment type (2026-09-28), from the same History row; nothing
  // for full-time or unknown.
  const employment = employmentText(detail.employment, tJobs);
  const meta = [detail.company, employment, detail.location, posted && t("job.posted", { when: posted }), competition].filter(
    Boolean,
  );

  return (
    <div className="space-y-5">
      <header>
        <h1 dir="auto" className="text-2xl font-bold leading-tight text-ink">
          {detail.job_title || t("job.untitled")}
        </h1>
        {/* Each part is its own direction (a Latin company and place, a Hebrew
            date), and the dots sit BETWEEN the isolates in the page's own
            direction: inside an English part, a dot landed on its far end under
            the Hebrew UI ("· Tel Aviv, IsraelWix"), seen at 390 px. */}
        {meta.length > 0 && (
          <p className="mt-1 text-sm text-ink-muted">
            {meta.map((part, i) => (
              <span key={i}>
                {i > 0 && <span aria-hidden> · </span>}
                <span dir="auto">{part}</span>
              </span>
            ))}
          </p>
        )}
        {/* Each control here is a 44 px box, the owner's touch floor (the phone
            polish pass): the status chip, the rating and the posting link were
            36 px tall and a star 28 px wide. The page has the room, so the
            boxes grow and the faces keep their size. */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusSelect status={detail.status || "saved"} onChange={(s) => void setStatus(s)} />
          <RatingSelect value={detail.excitement || 0} onRate={(n) => void rate(n)} className="min-h-11" />
          {/* Only a scored row has a match to show: an unscored one stores 0.0,
              and "Match 0%" would be a measurement nobody took. */}
          {detail.overall_score ? (
            <span className="rounded-md bg-panel-2 px-2 py-0.5 text-xs font-semibold tabular-nums text-ink-muted">
              {t("job.match", { pct: Math.round(detail.overall_score) })}
            </span>
          ) : null}
          {detail.job_url && (
            <a
              href={detail.job_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-accent hover:underline"
            >
              <ExternalLink size={15} />
              {credited
                ? tJobs("card.openOn", { source: sourceLabel(credited, i18n.language) })
                : t("job.openPosting")}
            </a>
          )}
        </div>
      </header>

      <AsksSection detail={detail} />
      <ResumeSection detail={detail} />
      <LetterSection detail={detail} onSaved={(letter) => onChange({ ...detail, cover_letter: letter })} onJd={(jd) => onChange({ ...detail, jd })} />
      <SendSection detail={detail} reload={reload} />
      <PrepareSection detail={detail} />
      <TimelineSection detail={detail} reload={reload} />
      <NotesSection detail={detail} onSaved={(notes) => onChange({ ...detail, notes })} />

      {/* The delete itself runs on the tracker, which already waits out an undo
          window with the card back in its place on Undo (check-mirrors 51). */}
      <div className="flex justify-center pt-2">
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 size={15} />}
          className="min-h-11 text-ink-muted hover:text-danger"
          onClick={() => nav("/tracker", { state: { remove: detail.id } })}
        >
          {t("job.delete")}
        </Button>
      </div>
    </div>
  );
}

/** The status as ONE tappable chip, like the board's: the face shows it, and a
 * native select lies over it, transparent and labelled, so a phone opens its own
 * picker and a screen reader hears "Status, Applied". */
function StatusSelect({ status, onChange }: { status: string; onChange: (s: string) => void }) {
  const { t } = useTranslation("tracker");
  return (
    <span className="relative inline-flex min-h-11 items-center">
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold leading-none",
          STATUS_FACE[status] ?? STATUS_FACE.saved,
        )}
      >
        {t(`status.${status}`)}
        <ChevronDown size={12} aria-hidden />
      </span>
      <select
        value={status}
        aria-label={t("statusLabel")}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      >
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {t(`status.${s}`)}
          </option>
        ))}
      </select>
    </span>
  );
}

/** "What they ask for": the must-haves and nice-to-haves of the analysis a fit
 * check, tailor or kit already stored, and the posting itself one tap away. With
 * no analysis stored it says how to get one; it never runs one on its own. */
function AsksSection({ detail }: { detail: ApplicationDetail }) {
  const { t } = useTranslation("tracker");
  const [open, setOpen] = useState(false);
  const jd = detail.jd ?? null;
  const must = jd?.hard_skills ?? [];
  const nice = jd?.preferred_skills ?? [];
  return (
    <Card>
      <CardTitle>{t("job.asks.title")}</CardTitle>
      {must.length || nice.length ? (
        <div className="mt-3 space-y-3">
          {must.length > 0 && <TermList label={t("job.asks.must")} terms={must} strong />}
          {nice.length > 0 && <TermList label={t("job.asks.nice")} terms={nice} />}
        </div>
      ) : (
        <p className="mt-2 text-sm text-ink-muted">{t("job.asks.none")}</p>
      )}
      {detail.jd_text ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-accent hover:underline"
          >
            {open ? t("job.asks.hidePosting") : t("job.asks.showPosting")}
            <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} aria-hidden />
          </button>
          {/* Shown or not, never a height tween (check-mirrors 11). */}
          {open && (
            <div
              dir="auto"
              className="mt-2 max-h-[28rem] overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-bg-soft p-3 text-sm leading-relaxed text-ink"
            >
              {detail.jd_text}
            </div>
          )}
        </>
      ) : (
        <p className="mt-3 text-xs text-ink-faint">{t("job.asks.noPosting")}</p>
      )}
    </Card>
  );
}

function TermList({ label, terms, strong }: { label: string; terms: string[]; strong?: boolean }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted rtl:tracking-normal">{label}</p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {terms.map((term) => (
          <li
            key={term}
            dir="auto"
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs",
              strong ? "border-accent/40 bg-accent/10 text-ink" : "border-line bg-panel-2 text-ink-muted",
            )}
          >
            {term}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Your resume for this job": the draft saved with it (its first page, both
 * downloads in the template it was made in, and the way back to it on the
 * document), a batch draft on its way, or Tailor. */
function ResumeSection({ detail }: { detail: ApplicationDetail }) {
  const { t } = useTranslation("tracker");
  const { t: tCommon } = useTranslation();
  const nav = useNavigate();
  const fitUses = useUses("fit_check");
  const resume = detail.tailored_resume;
  const template = sentTemplate(detail.template);
  const pics = usePageImages(resume, template ?? "standard", !!resume);
  const kit = detail.pending_kit ?? null;
  // The draft's review is in this tab's tailor store while the tab that made it
  // is open, and stored with the row since PLAN 31.4/4, so the document can
  // open it again after a reload (`?open_app=`, `openSavedReview`). In this tab
  // the page goes straight back to it, unsaved typing included.
  const store = getTailorState();
  const inThisTab = store.savedAppId === detail.id && !!store.result;
  const openHref = inThisTab ? "/app" : detail.has_review ? `/app?open_app=${detail.id}` : null;
  const tailorHref = `/app?tailor_app=${detail.id}`;

  if (!resume) {
    return (
      <Card>
        <CardTitle>{t("job.resume.title")}</CardTitle>
        {kit ? (
          kit.status === "done" ? (
            <div className="mt-2">
              <p className="text-sm text-ink">{t("job.resume.kitDone")}</p>
              <Button className="mt-3" icon={<FileText size={15} />} onClick={() => nav(`/kits/${kit.id}`)}>
                {t("job.resume.kitReview")}
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-muted">{t("job.resume.kitWorking")}</p>
          )
        ) : (
          <div className="mt-2">
            <p className="text-sm text-ink-muted">{t("job.resume.none")}</p>
            <Button className="mt-3" icon={<FileText size={15} />} onClick={() => nav(tailorHref)}>
              {t("job.resume.tailor")}
            </Button>
            <UsesNote feature="fit_check" className="mt-2">
              {tCommon("uses.fitThenTailor", { count: fitUses.remaining ?? 0 })}
            </UsesNote>
          </div>
        )}
      </Card>
    );
  }

  const filename = resumeFilename(resume.contact.name, detail.company);
  const first = pics.data?.pages[0];
  return (
    <Card>
      <CardTitle>{t("job.resume.title")}</CardTitle>
      {kit?.status === "done" && (
        <p className="mt-2 text-sm text-ink">
          {t("job.resume.kitDone")}{" "}
          <Link to={`/kits/${kit.id}`} className="inline-flex min-h-11 items-center font-medium text-accent hover:underline">
            {t("job.resume.kitReview")}
          </Link>
        </p>
      )}
      <div className="mt-3 flex gap-4">
        <div className="w-28 shrink-0 sm:w-36">
          {first ? (
            <img
              src={`data:image/png;base64,${first}`}
              alt={t("job.resume.preview")}
              className="w-full rounded-md border border-line bg-white shadow-card"
            />
          ) : pics.failed ? (
            <p className="text-xs text-ink-faint">{t("job.resume.previewFailed")}</p>
          ) : (
            <Skeleton className="aspect-[1/1.414] w-full" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={<Download size={15} />}
              aria-label={t("job.resume.downloadWord")}
              onClick={() => void downloadResume(resume, "docx", filename, template)}
              className="min-h-11"
            >
              {t("job.resume.word")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Download size={15} />}
              aria-label={t("job.resume.downloadPdf")}
              onClick={() => void downloadResume(resume, "pdf", filename, template)}
              className="min-h-11"
            >
              {t("job.resume.pdf")}
            </Button>
          </div>
          {openHref ? (
            <Button size="sm" variant="ghost" icon={<FileText size={15} />} onClick={() => nav(openHref)} className="min-h-11">
              {t("job.resume.open")}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={<FileText size={15} />} onClick={() => nav(tailorHref)} className="min-h-11">
              {t("job.resume.retailor")}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/** The letter for this job. With the posting's analysis stored, it is the
 * letter card the tailor page used (the same pass, keyed by the same analysis,
 * so a change the tailor page paid for is still included here). Without one,
 * "Write a cover letter" first reads the posting (a daily count, never a monthly
 * use), stores that analysis on the row, and then shows the card, whose own
 * note says what the letter costs before it is written. */
function LetterSection({
  detail,
  onSaved,
  onJd,
}: {
  detail: ApplicationDetail;
  onSaved: (letter: string) => void;
  onJd: (jd: JDModel) => void;
}) {
  const { t } = useTranslation("tracker");
  const toast = useToast();
  const { master } = useMasterResume();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  // The draft made for this job, or the master when there is none: a letter is
  // written from what will be sent.
  const resume = detail.tailored_resume ?? master?.resume ?? null;
  const jd = detail.jd ?? null;

  async function save(letter: string) {
    try {
      await updateApplication(detail.id, { cover_letter: letter });
      onSaved(letter);
    } catch {
      toast("error", t("job.letter.saveError"));
    }
  }

  async function read() {
    setError("");
    setReading(true);
    try {
      const analysed = await analyzeJD(detail.jd_text);
      // Stored with the job, so the next visit (and the letter's pass) finds it.
      await updateApplication(detail.id, { jd: analysed }).catch(() => undefined);
      onJd(analysed);
    } catch (e) {
      setError(apiErrorMessage(e, t("job.letter.readError")));
    } finally {
      setReading(false);
    }
  }

  if (jd && resume) {
    // A letter or a proposal (2026-09-28), one pass per posting either way; the
    // text the user edits in the box is saved on the row like a written one. A
    // job its board labels Contract or Freelance opens on the proposal.
    return (
      <CoverLetter
        resume={resume}
        jd={jd}
        initialText={detail.cover_letter}
        initialKind={proposalFirst(detail.employment) ? "proposal" : "letter"}
        postingText={detail.jd_text}
        onGenerated={(letter) => void save(letter)}
        onEdited={(letter) => void save(letter)}
      />
    );
  }

  return (
    <Card>
      <CardTitle>{t("job.letter.title")}</CardTitle>
      {detail.cover_letter && <SavedLetter text={detail.cover_letter} />}
      {!resume ? (
        <p className="mt-2 text-sm text-ink-muted">
          <Link to="/app" className="inline-flex min-h-11 items-center font-medium text-accent hover:underline">
            {t("job.letter.needsResume")}
          </Link>
        </p>
      ) : detail.jd_text ? (
        <div className="mt-3">
          <Button size="sm" variant="secondary" loading={reading} icon={<Mail size={15} />} onClick={() => void read()} className="min-h-11">
            {reading ? t("job.letter.reading") : t("job.letter.write")}
          </Button>
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </div>
      ) : (
        <p className="mt-2 text-sm text-ink-muted">{t("job.letter.needsPosting")}</p>
      )}
    </Card>
  );
}

/** A letter already on the row, shown in its own direction with Copy. */
function SavedLetter({ text }: { text: string }) {
  const { t } = useTranslation("tracker");
  const toast = useToast();
  return (
    <div className="mt-3">
      <div
        dir="auto"
        className="whitespace-pre-wrap break-words rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink"
      >
        {text}
      </div>
      <Button
        className="mt-2 min-h-11"
        size="sm"
        variant="ghost"
        icon={<Copy size={14} />}
        onClick={() => {
          void navigator.clipboard.writeText(text);
          toast("success", t("job.letter.copied"));
        }}
      >
        {t("job.letter.copy")}
      </Button>
    </div>
  );
}

/** Send the application through Comeet (PLAN 8.4), offered here since the Jobs
 * page's Kits tab went (PLAN 31.4/5). Only while the server names a kit that may
 * send (`send_kit`: approved, a Comeet posting, no flags, and the job's draft
 * still clean); the send itself re-checks all of it, and the per-company rule,
 * the bot check and the daily cap too, each refusal a sentence of its own. It
 * sends the draft and the letter on this page, and this is a REAL application,
 * so it asks first. */
function SendSection({ detail, reload }: { detail: ApplicationDetail; reload: () => Promise<void> }) {
  const { t } = useTranslation("tracker");
  const { t: tCommon } = useTranslation();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const kit = detail.send_kit ?? null;
  if (!kit) return null;
  const company = detail.company || detail.job_title;

  async function send() {
    if (!kit || sending) return;
    setSending(true);
    try {
      const sent = await sendKitApplication(kit.id);
      setAsking(false);
      const questionnaire = sent.submit_note;
      // The company's follow-up questions, when it sent any: a toast long enough
      // to reach, and the link stays in the notes the send wrote.
      toast("success", t("job.send.sent", { company }), questionnaire
        ? {
            action: { label: t("job.send.questionnaire"), onClick: () => window.open(questionnaire, "_blank", "noopener,noreferrer") },
            durationMs: 12000,
          }
        : undefined);
      // The row is Applied now, with the send written into its notes.
      await reload();
    } catch (e: unknown) {
      // A refusal is read by its code, in the reader's language (lib/sendRefusal);
      // anything else (the daily cap, a session that ended, a network failure)
      // by apiErrorMessage, as before.
      const refusal = sendRefusal(e);
      toast("error", refusal ? t(sendRefusalKey(refusal.code), refusal.params) : apiErrorMessage(e, t("job.send.error")));
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardTitle>{t("job.send.title")}</CardTitle>
      <p className="mt-1 text-sm text-ink-muted">{t("job.send.body", { company })}</p>
      <Button className="mt-3" icon={<Send size={15} className="rtl:-scale-x-100" />} onClick={() => setAsking(true)}>
        {t("job.send.cta")}
      </Button>
      <Modal open={asking} onClose={() => !sending && setAsking(false)} title={t("job.send.confirmTitle")} maxWidth="max-w-lg">
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">{t("job.send.confirmBody", { company })}</p>
          <p className="text-xs text-ink-faint">{t("job.send.note")}</p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setAsking(false)} disabled={sending} className="min-h-11">
              {tCommon("actions.cancel")}
            </Button>
            <Button size="sm" loading={sending} icon={<Send size={14} className="rtl:-scale-x-100" />} onClick={() => void send()} className="min-h-11">
              {t("job.send.confirm")}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

/** The tools that prepare for this job, each opened with the job's posting,
 * company and role (`?app=` names the job, so the tool can find its way back). */
function PrepareSection({ detail }: { detail: ApplicationDetail }) {
  const { t } = useTranslation("tracker");
  const { t: tInterview } = useTranslation("interview");
  const { t: tTools } = useTranslation("tools");
  const app = `app=${detail.id}`;
  const posting = { jdText: detail.jd_text, company: detail.company, jobTitle: detail.job_title };
  const items: { to: string; label: string; icon: ReactNode; state?: unknown }[] = [
    { to: `/interview?${app}`, label: tInterview("mode.questions"), icon: <MessageSquareText size={17} /> },
    { to: `/interview?${app}&mode=mock`, label: tInterview("mode.mock"), icon: <Mic size={17} /> },
    { to: `/tools/company-brief?${app}`, label: tTools("cards.brief.title"), icon: <Building2 size={17} />, state: { ...posting, url: detail.job_url } },
    { to: `/tools/outreach?${app}`, label: tTools("cards.outreach.title"), icon: <Send size={17} />, state: posting },
    {
      to: `/tools/follow-up?${app}`,
      label: tTools("cards.followup.title"),
      icon: <Mail size={17} />,
      state: { company: detail.company, role: detail.job_title, stage: followUpStage(detail.status) },
    },
  ];
  return (
    <Card>
      <CardTitle>{t("job.prepare.title")}</CardTitle>
      <ul className="mt-2 divide-y divide-line/60">
        {items.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              state={item.state}
              className="flex min-h-11 items-center gap-3 py-2 text-sm font-medium text-ink hover:text-accent"
            >
              <span className="text-ink-muted">{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <ChevronRight size={16} className="text-ink-faint rtl:-scale-x-100" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** What happened and when, from what the row records: when it was added, when
 * it was sent, the ONE status change it keeps, and every email the inbox tied
 * to it. There is no history beyond these, so none is made up. */
function TimelineSection({ detail, reload }: { detail: ApplicationDetail; reload: () => Promise<void> }) {
  const { t } = useTranslation("tracker");
  const locale = useLocaleTag();
  const facts: { key: string; label: string; when: string }[] = [];
  facts.push({
    key: "added",
    label: detail.source === "email" ? t("job.timeline.addedEmail") : t("job.timeline.added"),
    when: detail.created_at,
  });
  if (detail.applied_at) facts.push({ key: "applied", label: t("job.timeline.applied"), when: detail.applied_at });
  // A hand-made change past Applied. Applied has its own line, and a change an
  // email made is in the emails below, with its Undo.
  if (
    detail.status_source === "manual" &&
    detail.status_changed_at &&
    detail.status !== "saved" &&
    detail.status !== "applied"
  ) {
    facts.push({
      key: "moved",
      label: t("job.timeline.moved", { status: t(`status.${detail.status}`) }),
      when: detail.status_changed_at,
    });
  }
  const shown = facts
    .map((f) => ({ ...f, day: formatDay(f.when, locale), at: new Date(f.when).getTime() }))
    .filter((f) => f.day)
    .sort((a, b) => b.at - a.at);
  return (
    <Card>
      <CardTitle>{t("job.timeline.title")}</CardTitle>
      <ol className="mt-2 space-y-1.5">
        {shown.map((f) => (
          <li key={f.key} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-ink">{f.label}</span>
            <span className="shrink-0 text-xs tabular-nums text-ink-faint">{f.day}</span>
          </li>
        ))}
      </ol>
      {detail.email_events?.length ? (
        <div className="mt-4">
          <EmailTimeline events={detail.email_events} onUndone={() => void reload()} />
        </div>
      ) : null}
    </Card>
  );
}

function NotesSection({ detail, onSaved }: { detail: ApplicationDetail; onSaved: (notes: string) => void }) {
  const { t } = useTranslation("tracker");
  const toast = useToast();
  const [draft, setDraft] = useState(detail.notes);
  const [saving, setSaving] = useState(false);
  // Notes written elsewhere while the page is open (a Comeet send appends its
  // record, PLAN 31.4/5) replace the box's text when nothing was typed in it.
  // Otherwise the box kept the old notes, and Save wrote them over the record.
  const [seen, setSeen] = useState(detail.notes);
  if (detail.notes !== seen) {
    setSeen(detail.notes);
    if (draft === seen) setDraft(detail.notes);
  }
  async function save() {
    setSaving(true);
    try {
      const out = await updateApplication(detail.id, { notes: draft });
      onSaved(out.notes);
      toast("success", t("notes.saved"));
    } catch {
      toast("error", t("notes.error"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card>
      <CardTitle>{t("notes.label")}</CardTitle>
      {/* The note's own direction: English notes under the Hebrew UI put their
          full stop on the wrong end ("with .Dana"), seen at 390 px. */}
      <textarea
        dir="auto"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t("notes.placeholder")}
        aria-label={t("notes.label")}
        rows={3}
        className="mt-2 w-full resize-y rounded-xl border border-line bg-bg-soft p-3 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="secondary" loading={saving} disabled={draft === detail.notes} onClick={() => void save()} className="min-h-11">
          {t("notes.save")}
        </Button>
      </div>
    </Card>
  );
}
