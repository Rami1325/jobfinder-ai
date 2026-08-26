import { useEffect, useMemo, useState } from "react";
import { Check, Crosshair, FileText, Scissors, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChangeLogEntry, CVPlan, FabricationFlag, LengthReport, ResumeModel } from "../types";
import type { ResumeTemplate } from "../api/client";
import type { DiffSeg, EditSection, ResumeEdit } from "../lib/resumeDiff";
import { editContainsValue, keywordsServed, wordDiff } from "../lib/resumeDiff";
import {
  CURATION_KEY,
  curationCause,
  groupEdits,
  isTruncation,
  opensByDefault,
  removedProjectName,
  type EditGroup,
} from "../lib/editGroups";
import { usePageCount } from "../hooks/usePageCount";
import { Badge, Card, CardTitle, DecryptText, Disclosure } from "./ui";
import { cn } from "../lib/cn";

interface Props {
  edits: ResumeEdit[];
  changelog: ChangeLogEntry[];
  flags: FabricationFlag[];
  jdKeywords: string[];
  rejected: ReadonlySet<string>;
  onSetRejected: (ids: string[]) => void;
  /** The diff baseline — names a removed project without parsing its text. */
  original?: ResumeModel | null;
  /** What the user will actually download, for the live page measurement. */
  effective?: ResumeModel | null;
  lengthReport?: LengthReport;
  plan?: CVPlan | null;
  template?: ResumeTemplate;
  /** Jump from a review row to the block it changed in the document. */
  onShowInDoc?: (id: string) => void;
  /** Edit id → block path. Only anchored edits get a jump button: an accepted
   * removal has no block on the page, and a button that does nothing is worse
   * than no button. */
  anchoredEdits?: Record<string, string>;
  /** The reverse jump — the document asking for an edit to be shown. The nonce
   * makes clicking the same block twice re-fire. */
  focusEdit?: { id: string; nonce: number } | null;
}

const CURATION_SECTION_ORDER: EditSection[] = [
  "projects",
  "experience",
  "skills",
  "certifications",
  "education",
  "militaryService",
  "languages",
  "headline",
  "summary",
  "contact",
];

/** Drop a leading "Label — " from a formatted entry, so the curation row can
 * show the name in bold without printing it twice. `formatProject` and friends
 * embed the name in the text they format; the row prints it separately. */
function stripLabel(text: string, label: string): string {
  const body = (text ?? "").trim();
  if (!label) return body;
  const prefix = `${label} — `;
  if (body.startsWith(prefix)) return body.slice(prefix.length).trim();
  return body === label ? "" : body;
}

const kindTone: Record<ResumeEdit["kind"], "accent" | "mint" | "danger"> = {
  edited: "accent",
  added: "mint",
  removed: "danger",
};

function DiffText({
  segs,
  mode,
  decryptDelay,
}: {
  segs: DiffSeg[];
  mode: "before" | "after";
  /** ms — when set, the rewritten (after) segments resolve out of a scramble on first mount. */
  decryptDelay?: number;
}) {
  return (
    <span dir="auto" className="whitespace-pre-wrap">
      {segs.map((s, i) =>
        s.op === "same" ? (
          <span key={i}>{s.text}</span>
        ) : mode === "before" ? (
          <del key={i} className="rounded bg-danger/15 px-0.5 text-danger no-underline line-through">
            {s.text}
          </del>
        ) : (
          <mark key={i} className="rounded bg-mint/20 px-0.5 font-medium text-mint">
            {decryptDelay === undefined ? s.text : <DecryptText text={s.text} duration={400} delay={decryptDelay} />}
          </mark>
        ),
      )}
    </span>
  );
}

/** Accept / reject, as one segmented control. */
function Decide({
  isRejected,
  onDecide,
  acceptLabel,
  rejectLabel,
}: {
  isRejected: boolean;
  onDecide: (rejected: boolean) => void;
  acceptLabel: string;
  rejectLabel: string;
}) {
  return (
    <span className="ms-auto inline-flex shrink-0 overflow-hidden rounded-lg border border-line">
      <button
        type="button"
        aria-pressed={!isRejected}
        onClick={() => onDecide(false)}
        className={cn(
          "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium transition",
          !isRejected ? "bg-mint/20 text-mint" : "text-ink-muted hover:bg-panel-2 hover:text-ink",
        )}
      >
        <Check size={12} /> {acceptLabel}
      </button>
      <button
        type="button"
        aria-pressed={isRejected}
        onClick={() => onDecide(true)}
        className={cn(
          "inline-flex items-center gap-1 border-s border-line px-2 py-1 text-xs font-medium transition",
          isRejected ? "bg-danger/15 text-danger" : "text-ink-muted hover:bg-panel-2 hover:text-ink",
        )}
      >
        <X size={12} /> {rejectLabel}
      </button>
    </span>
  );
}

/** One full edit, with its before/after diff. Mounted only while its group is
 * open — which is also what keeps `wordDiff`'s LCS off every collapsed row on
 * every re-render. */
function EditRow({
  edit,
  flags,
  jdKeywords,
  isRejected,
  onDecide,
  decryptDelay,
  onShowInDoc,
}: {
  edit: ResumeEdit;
  flags: FabricationFlag[];
  jdKeywords: string[];
  isRejected: boolean;
  onDecide: (rejected: boolean) => void;
  decryptDelay: number;
  onShowInDoc?: () => void;
}) {
  const { t } = useTranslation("tailor");
  const d = useMemo(
    () => (edit.kind === "edited" ? wordDiff(edit.before, edit.after) : null),
    [edit.kind, edit.before, edit.after],
  );
  const serves = keywordsServed(edit, jdKeywords);
  const editFlags = flags.filter((f) => editContainsValue(edit, f.value));

  return (
    <div
      data-edit-id={edit.id}
      className={cn("rounded-lg border border-line bg-panel-2/60 px-3 py-2.5", isRejected && "opacity-70")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={kindTone[edit.kind]}>{t(`review.kind.${edit.kind}`)}</Badge>
        {edit.context && (
          <span dir="auto" className="min-w-0 truncate text-xs text-ink-muted">
            {edit.context}
          </span>
        )}
        {editFlags.length > 0 ? (
          <Badge tone={isRejected ? "mint" : "danger"}>
            <ShieldAlert size={11} />
            {isRejected ? t("review.flagResolved") : t("review.guardFlagged", { category: editFlags[0].category })}
          </Badge>
        ) : (
          edit.kind !== "removed" && (
            <Badge tone="mint">
              <ShieldCheck size={11} /> {t("review.guardOk")}
            </Badge>
          )
        )}
        {/* One auto margin, not two — a second `ms-auto` in the same flex row
            splits the free space instead of pushing to the end. */}
        <span className="ms-auto inline-flex items-center gap-2">
          {onShowInDoc && (
            <button
              type="button"
              onClick={onShowInDoc}
              aria-label={t("review.showInDoc")}
              title={t("review.showInDoc")}
              className="shrink-0 text-ink-faint transition hover:text-accent-soft"
            >
              <Crosshair size={13} />
            </button>
          )}
          <Decide
            isRejected={isRejected}
            onDecide={onDecide}
            acceptLabel={t("review.accept")}
            rejectLabel={t("review.reject")}
          />
        </span>
      </div>

      <div className="mt-2 space-y-1 text-sm leading-relaxed">
        {edit.kind === "edited" && d && (
          <>
            <div className="text-ink-muted">
              <DiffText segs={d.before} mode="before" />
            </div>
            <div className="text-ink">
              <DiffText segs={d.after} mode="after" decryptDelay={decryptDelay} />
            </div>
          </>
        )}
        {edit.kind === "added" && (
          <div dir="auto" className="whitespace-pre-wrap text-ink">
            <DecryptText text={edit.after} duration={400} delay={decryptDelay} />
          </div>
        )}
        {edit.kind === "removed" && (
          <div dir="auto" className="whitespace-pre-wrap text-ink-muted line-through">
            {edit.before}
          </div>
        )}
      </div>

      {(serves.length > 0 || isRejected) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {serves.length > 0 && (
            <>
              <span className="text-xs text-ink-faint">{t("review.serves")}</span>
              {serves.map((kw) => (
                <Badge key={kw} tone="accent">
                  {kw}
                </Badge>
              ))}
            </>
          )}
          {isRejected && (
            <span className="ms-auto text-xs font-medium text-warn">{t(`review.rejectedNote.${edit.kind}`)}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** The trust panel: fabrication check + the review, as decisions rather than rows. */
export default function ChangeLog({
  edits,
  changelog,
  flags,
  jdKeywords,
  rejected,
  onSetRejected,
  original = null,
  effective = null,
  lengthReport,
  plan,
  template = "classic",
  onShowInDoc,
  anchoredEdits,
  focusEdit,
}: Props) {
  const { t } = useTranslation("tailor");

  // Explicit user toggles only; anything untouched falls back to the default,
  // so a new tailor result gets fresh defaults without a reset effect and an
  // accept/reject re-render never closes what the user opened.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const isFlagged = useMemo(
    () => (e: ResumeEdit) => flags.some((f) => editContainsValue(e, f.value)),
    [flags],
  );
  const groups = useMemo(() => groupEdits(edits, isFlagged), [edits, isFlagged]);

  // A flag is resolved when every edit that introduced its value is rejected.
  const flagRows = flags.map((f) => {
    const carriers = edits.filter((e) => editContainsValue(e, f.value));
    return { flag: f, resolved: carriers.length > 0 && carriers.every((e) => rejected.has(e.id)) };
  });
  const clean = flags.length === 0;
  const allResolved = !clean && flagRows.every((r) => r.resolved);

  const acceptedCount = edits.filter((e) => !rejected.has(e.id)).length;
  const pages = usePageCount(effective, template, !!effective);

  const setRejected = (id: string, isRejected: boolean) => {
    const next = new Set(rejected);
    if (isRejected) next.add(id);
    else next.delete(id);
    onSetRejected([...next]);
  };
  const setManyRejected = (ids: string[], isRejected: boolean) => {
    const next = new Set(rejected);
    for (const id of ids) {
      if (isRejected) next.add(id);
      else next.delete(id);
    }
    onSetRejected([...next]);
  };

  const isOpen = (g: EditGroup) => toggled[g.key] ?? opensByDefault(g);
  const toggle = (g: EditGroup) => setToggled((p) => ({ ...p, [g.key]: !isOpen(g) }));

  // Document block → this panel. Open the group that holds the edit, then scroll
  // to it. `toggled` is "explicit user toggles only", so writing one key is
  // exactly the supported operation and cannot disturb any other group. The row
  // only exists once its group is open, hence the rAF.
  useEffect(() => {
    if (!focusEdit) return;
    const g = groups.find((x) => x.edits.some((e) => e.id === focusEdit.id));
    if (g) setToggled((p) => ({ ...p, [g.key]: true }));
    const raf = requestAnimationFrame(() => {
      // Scoped through the panel's own id rather than a ref: `Card` is a plain
      // function component, so React 18 would drop a `ref` prop on it, and
      // making the shared UI kit forwardRef for one caller is the wrong trade.
      document
        .querySelector<HTMLElement>(`#trust-panel [data-edit-id="${CSS.escape(focusEdit.id)}"]`)
        ?.scrollIntoView({
          block: "center",
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        });
    });
    return () => cancelAnimationFrame(raf);
  }, [focusEdit, groups]);

  const curation = groups.find((g) => g.key === CURATION_KEY);
  const decided = groups.filter((g) => g.key !== CURATION_KEY);

  // --- the live page badge ------------------------------------------------ //
  const pageBadge = (() => {
    if (pages.failed && !pages.data) return <span className="text-xs text-ink-faint">{t("pages.unavailable")}</span>;
    if (!pages.data) return null;
    const { pages: n, max_pages: max, hard_max_pages: hard } = pages.data;
    const value = t("pages.value", { count: n });
    const over = n > max;
    const hardOver = n > hard;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-xs transition-opacity",
          pages.stale && "opacity-50",
          hardOver ? "font-medium text-danger" : over ? "font-medium text-warn" : "text-ink-muted",
        )}
      >
        <FileText size={12} aria-hidden />
        {hardOver
          ? t("pages.hardOver", { pages: value, hard })
          : over
            ? t("pages.over", { pages: value, max })
            : t("pages.fits", { pages: value, max })}
        {pages.stale && <span className="text-ink-faint">· {t("pages.measuring")}</span>}
      </span>
    );
  })();

  return (
    <Card
      id="trust-panel"
      glow={clean || allResolved}
      className={cn("scroll-mt-20", clean || allResolved ? "border-mint/40" : "border-danger/50")}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "grid h-11 w-11 shrink-0 place-items-center rounded-xl",
            clean || allResolved ? "bg-mint/15 text-mint" : "bg-danger/15 text-danger",
          )}
        >
          {clean || allResolved ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}
        </span>
        <div>
          <CardTitle>{clean ? t("changelog.cleanTitle") : t("changelog.flaggedTitle")}</CardTitle>
          <p className="mt-0.5 text-sm text-ink-muted">
            {clean
              ? t("changelog.cleanBody")
              : allResolved
                ? t("review.resolvedBody")
                : t("changelog.flagged", { count: flags.length })}
          </p>
        </div>
      </div>

      {!clean && (
        <div className="mt-4 space-y-2">
          {flagRows.map(({ flag: f, resolved }, i) => (
            <div
              key={i}
              className={cn(
                "rounded-lg border px-3 py-2 text-sm",
                resolved ? "border-mint/30 bg-mint/10" : "border-danger/30 bg-danger/10",
              )}
            >
              <span className={cn("font-semibold capitalize", resolved ? "text-mint" : "text-danger")}>
                {f.category}:
              </span>{" "}
              <span className={cn("text-ink", resolved && "line-through opacity-60")}>{f.value}</span>
              {resolved && <span className="ms-2 text-xs font-medium text-mint">{t("review.flagResolved")}</span>}
              {!resolved && f.detail && <div className="mt-0.5 text-xs text-ink-muted">{f.detail}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">{t("review.title")}</h3>
        {edits.length > 0 && (
          <>
            <span className="text-xs tabular-nums text-ink-faint">
              {t("review.accepted", { accepted: acceptedCount, total: edits.length })}
            </span>
            <span className="ms-auto flex gap-3 text-xs">
              <button
                type="button"
                onClick={() => onSetRejected([])}
                disabled={acceptedCount === edits.length}
                className="text-mint hover:underline disabled:cursor-default disabled:opacity-40"
              >
                {t("review.acceptAll")}
              </button>
              <button
                type="button"
                onClick={() => onSetRejected(edits.map((e) => e.id))}
                disabled={acceptedCount === 0}
                className="text-danger hover:underline disabled:cursor-default disabled:opacity-40"
              >
                {t("review.rejectAll")}
              </button>
            </span>
          </>
        )}
      </div>
      {edits.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-xs text-ink-faint">{t("review.note")}</p>
          {pageBadge && <span className="ms-auto">{pageBadge}</span>}
        </div>
      )}

      {edits.length === 0 ? (
        <p className="mt-2 text-sm text-ink-muted">{t("changelog.noChanges")}</p>
      ) : (
        <div className="mt-3 space-y-2">
          {decided.map((g) => {
            const open = isOpen(g);
            const groupIds = g.edits.map((e) => e.id);
            const rejectedHere = groupIds.filter((id) => rejected.has(id)).length;
            return (
              <Disclosure
                key={g.key}
                open={open}
                onToggle={() => toggle(g)}
                className="bg-panel-2/30"
                summary={
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={g.cls === "addition" ? "mint" : "accent"}>{t(`groups.${g.cls}.title`)}</Badge>
                    <span className="text-xs font-medium text-ink-muted">{t(`sections.${g.section}`)}</span>
                    {g.context && (
                      <span dir="auto" className="min-w-0 truncate text-xs text-ink-faint">
                        {g.context}
                      </span>
                    )}
                    <span className="text-xs tabular-nums text-ink-faint">
                      {t(`groups.${g.cls}.count`, { count: g.edits.length })}
                    </span>
                    {g.flagged > 0 && (
                      <Badge tone="danger">
                        <ShieldAlert size={11} /> {t("groups.flagged", { count: g.flagged })}
                      </Badge>
                    )}
                    {rejectedHere > 0 && (
                      <span className="text-xs font-medium text-warn">
                        {t("groups.rejectedHere", { count: rejectedHere })}
                      </span>
                    )}
                  </span>
                }
              >
                <div className="space-y-2 px-3 pb-3">
                  {g.edits.length > 1 && (
                    <div className="flex gap-3 text-xs">
                      <button
                        type="button"
                        onClick={() => setManyRejected(groupIds, false)}
                        disabled={rejectedHere === 0}
                        className="text-mint hover:underline disabled:cursor-default disabled:opacity-40"
                      >
                        {t("groups.acceptGroup")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setManyRejected(groupIds, true)}
                        disabled={rejectedHere === groupIds.length}
                        className="text-danger hover:underline disabled:cursor-default disabled:opacity-40"
                      >
                        {t("groups.rejectGroup")}
                      </button>
                    </div>
                  )}
                  {g.section === "skills" && g.cls === "addition" && (
                    <p className="text-xs text-ink-faint">{t("additions.skillsNote")}</p>
                  )}
                  {g.edits.map((edit, i) => (
                    <EditRow
                      key={edit.id}
                      edit={edit}
                      flags={flags}
                      jdKeywords={jdKeywords}
                      isRejected={rejected.has(edit.id)}
                      onDecide={(r) => setRejected(edit.id, r)}
                      decryptDelay={Math.min(i, 15) * 40}
                      onShowInDoc={
                        onShowInDoc && anchoredEdits?.[edit.id] ? () => onShowInDoc(edit.id) : undefined
                      }
                    />
                  ))}
                </div>
              </Disclosure>
            );
          })}

          {curation && (
            <CurationCard
              group={curation}
              open={isOpen(curation)}
              onToggle={() => toggle(curation)}
              original={original}
              lengthReport={lengthReport}
              plan={plan}
              rejected={rejected}
              onRestore={setRejected}
              onRestoreAll={(ids) => setManyRejected(ids, true)}
            />
          )}
        </div>
      )}

      {changelog.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-medium text-ink-muted hover:text-ink">
            {t("review.aiNotes")}
          </summary>
          <div className="mt-2 space-y-2">
            {changelog.map((c, i) => (
              <div key={i} className="rounded-lg border-s-2 border-accent bg-panel-2/60 px-3 py-2">
                <div className="text-sm">
                  <span className="font-semibold capitalize text-accent-soft">{c.section}</span>
                  <span className="text-ink"> — {c.change}</span>
                </div>
                {c.reason && (
                  <div className="mt-0.5 text-xs text-ink-muted">{t("changelog.why", { reason: c.reason })}</div>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </Card>
  );
}

/**
 * Everything from the résumé that isn't in this CV, in one quiet card.
 *
 * Deliberately NOT N accept/decline rows: most of these are decisions the model
 * was told to make, and one collapsed card is the honest weight for them. It is
 * also the one card that provably cannot hide a fabrication flag — flag matching
 * needs a non-empty `after`, and every member here is either a removal or a
 * truncation of text already in the ledger.
 *
 * "Restore" is not new machinery: rejecting a removal is exactly what puts the
 * original content back, so this reuses the same `rejected` set as everything
 * else and the résumé the user downloads can never disagree with these buttons.
 */
function CurationCard({
  group,
  open,
  onToggle,
  original,
  lengthReport,
  plan,
  rejected,
  onRestore,
  onRestoreAll,
}: {
  group: EditGroup;
  open: boolean;
  onToggle: () => void;
  original: ResumeModel | null;
  lengthReport?: LengthReport;
  plan?: CVPlan | null;
  rejected: ReadonlySet<string>;
  onRestore: (id: string, rejectedNow: boolean) => void;
  onRestoreAll: (ids: string[]) => void;
}) {
  const { t } = useTranslation("tailor");
  const ids = group.edits.map((e) => e.id);
  const restored = ids.filter((id) => rejected.has(id)).length;
  // The count describes the CURRENT document, not the tailor's original cut —
  // otherwise restoring everything left the header reading "21 things aren't in
  // this CV · 21 restored", two true statements that contradict each other.
  const remaining = ids.length - restored;

  const bySection = CURATION_SECTION_ORDER.map((section) => ({
    section,
    items: group.edits.filter((e) => e.section === section),
  })).filter((s) => s.items.length > 0);

  return (
    <Disclosure
      open={open}
      onToggle={onToggle}
      className="border-line/70 bg-bg-soft"
      summary={
        <span className="flex flex-wrap items-center gap-2">
          <Scissors size={13} aria-hidden className="text-ink-faint" />
          <span className="text-xs font-medium text-ink-muted">{t("curation.title")}</span>
          {remaining > 0 && (
            <span className="text-xs text-ink-faint">{t("curation.count", { count: remaining })}</span>
          )}
          {restored > 0 && (
            <span className="text-xs font-medium text-mint">
              {remaining === 0 ? t("curation.allRestored") : t("curation.restoredNote", { count: restored })}
            </span>
          )}
        </span>
      }
    >
      <div className="space-y-3 px-3 pb-3">
        <p className="text-xs leading-relaxed text-ink-faint">
          <span className="text-ink-muted">{t("curation.complete")}</span> {t("curation.ambiguity")}
        </p>
        {restored < ids.length && (
          <button
            type="button"
            onClick={() => onRestoreAll(ids)}
            className="text-xs font-medium text-accent-soft hover:underline"
          >
            {t("curation.restoreAll")}
          </button>
        )}

        {bySection.map(({ section, items }) => (
          <div key={section}>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
              {t(`sections.${section}`)}
            </div>
            <div className="space-y-1">
              {items.map((e) => {
                const isRestored = rejected.has(e.id);
                const cause = curationCause(e, original, lengthReport, plan);
                const truncated = isTruncation(e);
                // Two complementary sources, because the two shapes carry the
                // name in different places: a dropped project has `context: ""`
                // and is named by its index, while a SHORTENED one is a `.desc`
                // edit whose context is already the project name.
                const label = removedProjectName(e, original) || e.context;
                // `formatProject` renders "Name — description", so printing the
                // label beside it duplicated the name on every project row.
                const body = truncated ? t("curation.truncated") : stripLabel(e.before, label);
                return (
                  <div
                    key={e.id}
                    className={cn(
                      "flex flex-wrap items-start gap-2 rounded-lg border px-2.5 py-1.5",
                      isRestored ? "border-mint/30 bg-mint/5" : "border-line/60",
                    )}
                  >
                    <span dir="auto" className="min-w-0 flex-1 text-xs leading-relaxed text-ink-muted line-clamp-2">
                      {label && <span className="font-medium text-ink">{label}</span>}
                      {label && body && " — "}
                      {body}
                    </span>
                    {cause !== "unknown" && (
                      <Badge tone="accent">{cause === "budget" ? t("curation.byBudget") : t("curation.byPlan")}</Badge>
                    )}
                    <button
                      type="button"
                      aria-pressed={isRestored}
                      onClick={() => onRestore(e.id, !isRestored)}
                      className={cn(
                        "shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium transition",
                        isRestored
                          ? "border-mint/40 bg-mint/15 text-mint"
                          : "border-line text-ink-muted hover:bg-panel-2 hover:text-ink",
                      )}
                    >
                      {isRestored ? t("curation.restored") : t("curation.restore")}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Disclosure>
  );
}
