import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Crosshair, Scissors, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChangeLogEntry, CVPlan, FabricationFlag, LengthReport, ResumeModel } from "../types";
import type { ResumeTemplate } from "../api/client";
import type { DiffSeg, EditSection, ResumeEdit } from "../lib/resumeDiff";
import { editContainsValue, editValueOnDocument, flagStates, keywordsServed, wordDiff } from "../lib/resumeDiff";
import { changeLead, noteSectionKey, reasonSection } from "../lib/changeNotes";
import {
  CURATION_KEY,
  curationCause,
  groupEdits,
  isTruncation,
  opensByDefault,
  removedProjectName,
  type EditGroup,
} from "../lib/editGroups";
import PageBadge from "./PageBadge";
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
  /**
   * Edit id → the state of the user's OWN wording on the block that edit
   * describes. `"yours"` = it is on the page right now and neither string in
   * this row is; `"hidden"` = it is kept but not applied, because a decision
   * elsewhere took the line it was on off the document; `"removed"` = the USER
   * cleared the line and it is gone from this application's CV.
   *
   * The third state is not a nicety. Until 23.8 an anchor with no path was
   * `"hidden"` whatever put it there, so clearing a line — the user's own
   * deletion — was reported as "a declined change removed the line it was on",
   * kept a mint "Yours" badge on a line that no longer exists, and offered two
   * buttons that both silently PUT THE LINE BACK under labels about choosing
   * between two wordings.
   *
   * A hand-edit OUTRANKS the accept/decline decision for its block, so these
   * rows swap their Accept/Reject control for controls that each say what they
   * do. Silently letting a later Decline overwrite text the user typed is the
   * data loss this exists to prevent; silently letting the override win while
   * Accept/Reject stayed live would leave a control that does nothing, which is
   * the other thing this panel refuses to ship.
   */
  overridden?: Record<string, "yours" | "hidden" | "removed">;
  /** How many blocks of the document the user wrote themselves — including ones
   * no row here describes. The clean body copy names them, because the guard
   * never read a word of them. */
  overrideCount?: number;
  /** Accept this edit AND drop the user's wording, in one tap. */
  onUseAi?: (id: string) => void;
  /** Reject this edit AND drop the user's wording, in one tap. */
  onUseOriginal?: (id: string) => void;
  /** Undo the user's own DELETION, leaving the accept/decline decision alone —
   * neither of the two above describes putting a deleted line back. */
  onRestoreMine?: (id: string) => void;
  /**
   * `card` (the kit page) is the panel as it always was. `drawer` is the tailored
   * draft's review since PLAN 31.3/3: no card around it, no page chip (the
   * summary over the paper carries it), each section under the reason the tailor
   * wrote for it instead of a separate "AI notes" list, and "Left out of this
   * version" rendered apart by `LeftOut`, below the keywords and the voice check.
   */
  variant?: "card" | "drawer";
  /** Drawer only: what sits between the claims and the change groups (the lines
   * the user typed, which belong beside the changes they outrank). */
  beforeGroups?: ReactNode;
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

/** Accept / reject, as one segmented control. Each half is a 44 px target at
 * its 24 px face (the third tap-target pass): it wears `tap-44`, whose 10 px of
 * layer above and below stay inside the edit's card (its `py-2.5`), so a row
 * keeps its height. The halves round their own outer corners; the control used
 * to clip them with `overflow-hidden`, which would cut the layers off. Each
 * half is wider than 44 px, so the two never share a tap. */
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
    <span className="ms-auto inline-flex shrink-0 rounded-lg border border-line">
      <button
        type="button"
        aria-pressed={!isRejected}
        onClick={() => onDecide(false)}
        className={cn(
          "tap-44 inline-flex items-center gap-1 rounded-s-[7px] px-2 py-1 text-xs font-medium transition",
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
          "tap-44 inline-flex items-center gap-1 rounded-e-[7px] border-s border-line px-2 py-1 text-xs font-medium transition",
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
  flagOnDoc,
  onDecide,
  decryptDelay,
  onShowInDoc,
  override,
  onUseAi,
  onUseOriginal,
  onRestoreMine,
}: {
  edit: ResumeEdit;
  flags: FabricationFlag[];
  jdKeywords: string[];
  isRejected: boolean;
  /** Whether a flagged value this edit introduced is STILL on the document. The
   * row cannot answer this itself — it holds a wording, not the block that
   * wording landed in — and answering it from `isRejected` is the inference the
   * override layer broke. */
  flagOnDoc: boolean;
  onDecide: (rejected: boolean) => void;
  decryptDelay: number;
  onShowInDoc?: () => void;
  override?: "yours" | "hidden" | "removed";
  onUseAi?: () => void;
  onUseOriginal?: () => void;
  onRestoreMine?: () => void;
}) {
  const { t } = useTranslation("tailor");
  const d = useMemo(
    () => (edit.kind === "edited" ? wordDiff(edit.before, edit.after) : null),
    [edit.kind, edit.before, edit.after],
  );
  // The keywords this WORDING serves, and only while that wording is what the
  // block says. `edit.after` is what the badges read, so with a hand-edit over
  // the block they credit the AI's sentence for terms the user may have just
  // typed away — the same "describes the decision, not the document" error the
  // flag rows carried, one line down.
  const serves = override ? [] : keywordsServed(edit, jdKeywords);
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
          <Badge tone={flagOnDoc ? "danger" : "mint"}>
            <ShieldAlert size={11} />
            {flagOnDoc ? t("review.guardFlagged", { category: editFlags[0].category }) : t("review.flagResolved")}
          </Badge>
        ) : (
          // "Nothing new" is the GUARD's verdict on the AI's wording, and it has
          // no verdict at all on a sentence the user typed after the fact — so
          // the badge goes with the wording it describes.
          edit.kind !== "removed" &&
          !override && (
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
              // 44 px wide and Decide's 24 px tall, wearing `tap-44` for the
              // height: a 13 px icon's layer would have reached Decide, 8 px away.
              className="tap-44 grid h-6 w-11 shrink-0 place-items-center text-ink-faint transition hover:text-accent-soft"
            >
              <Crosshair size={13} />
            </button>
          )}
          {/* The third state. Accept/Reject is REPLACED, not disabled: while an
              override stands, neither of those two words describes what is on
              the paper, and a segmented control that silently loses to
              something else is the "button that does nothing" this panel is
              built to avoid. */}
          {override ? (
            // A deleted line is not "Yours" in the mint sense — the mint badge on
            // a line the user had removed said the opposite of what happened.
            <Badge tone={override === "removed" ? "danger" : "mint"}>
              {override === "removed" ? t("review.yoursDeleted") : t("review.yours")}
            </Badge>
          ) : (
            <Decide
              isRejected={isRejected}
              onDecide={onDecide}
              acceptLabel={t("review.accept")}
              rejectLabel={t("review.reject")}
            />
          )}
        </span>
      </div>

      {/* Above the diff, not below it: the reader has to know that neither
          string underneath is on their CV BEFORE they read them. */}
      {override && (
        <div
          className={cn(
            "mt-2 space-y-2 rounded-lg border px-2.5 py-2",
            override === "removed" ? "border-warn/30 bg-warn/5" : "border-mint/30 bg-mint/5",
          )}
        >
          <p className="text-xs leading-relaxed text-ink-muted">
            {override === "removed"
              ? t("review.yoursRemoved")
              : override === "hidden"
                ? t("review.yoursHidden")
                : t("review.yoursNote")}
          </p>
          {override === "removed" ? (
            // ONE control, because there is only one thing to offer. The two
            // below are a choice between two WORDINGS, and both of them would
            // put the line back — under labels that never say so.
            <button
              type="button"
              onClick={onRestoreMine}
              className="min-h-11 rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-ink-muted transition hover:bg-panel-2 hover:text-ink"
            >
              {t("review.yoursRestore")}
            </button>
          ) : (
            <>
              {/* Each is one tap and each says which wording it takes: "use the
                  AI's" IS accept + clear, "use my original" IS reject + clear.
                  On an ADDITION there is no original to use — declining takes
                  the line off the CV and the user's text with it — so that
                  button says what it actually does. */}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onUseAi}
                  className="min-h-11 rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-ink-muted transition hover:bg-panel-2 hover:text-ink"
                >
                  {t("review.useAi")}
                </button>
                <button
                  type="button"
                  onClick={onUseOriginal}
                  className="min-h-11 rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-ink-muted transition hover:bg-panel-2 hover:text-ink"
                >
                  {edit.kind === "added" ? t("review.dontAdd") : t("review.useOriginal")}
                </button>
              </div>
              {/* VISIBLE, not a `title`. The warning that both of these discard
                  what was typed used to live in a tooltip, and the primary
                  device here has no hover at all — on a phone it did not exist. */}
              <p className="text-[11px] leading-relaxed text-ink-faint">{t("review.yoursDiscard")}</p>
            </>
          )}
        </div>
      )}

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
  overridden,
  overrideCount = 0,
  onUseAi,
  onUseOriginal,
  onRestoreMine,
  variant = "card",
  beforeGroups,
}: Props) {
  const { t } = useTranslation("tailor");
  const drawer = variant === "drawer";

  // Explicit user toggles only; anything untouched falls back to the default,
  // so a new tailor result gets fresh defaults without a reset effect and an
  // accept/reject re-render never closes what the user opened.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const isFlagged = useMemo(
    () => (e: ResumeEdit) => flags.some((f) => editContainsValue(e, f.value)),
    [flags],
  );
  const groups = useMemo(() => groupEdits(edits, isFlagged), [edits, isFlagged]);

  /**
   * Is a flagged value still on the DOCUMENT, on the block this edit landed in?
   *
   * THIS USED TO BE `rejected.has(e.id)`, and that inference was sound for
   * exactly as long as rejecting was the only way to change a line: the guard
   * flags a value BECAUSE it is not in the original, so putting the original
   * back removes it. Since the tailored document is typed on, a rejection and a
   * hand-edit can stand on the same block at once and `applyOverrides` runs
   * LAST — the override wins the paper while the rejection won the flag row.
   * Reject the flagged edit (panel goes mint, "All flagged claims resolved"),
   * then type over the same bullet keeping the invented number: the mint stayed
   * and the number shipped. Reproduced by execution, not reasoned about.
   *
   * The reading lives in `lib/resumeDiff` (`flagStates`, `editValueOnDocument`)
   * since PLAN 31.3/3, because the summary line over the paper states the same
   * count and one question may have only one answer. The subtree search, and
   * why a missing document never reads as resolved, are documented there.
   */
  const onDocument = (e: ResumeEdit, value: string): boolean =>
    editValueOnDocument(e, value, anchoredEdits, effective);
  /** A flag is resolved when nothing on the document still carries its value. */
  const flagRows = flagStates(flags, edits, anchoredEdits, effective);
  const clean = flags.length === 0;
  const allResolved = !clean && flagRows.every((r) => r.resolved);

  const acceptedCount = edits.filter((e) => !rejected.has(e.id)).length;

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

  // Each section under the reason the tailor wrote for it (PLAN 31.3/3). The
  // drawer prints a section's reasons once, above its first unflagged group; a
  // reason with no section of its own stays in the notes at the end.
  const reasons = useMemo(() => {
    const bySection = new Map<EditSection, ChangeLogEntry[]>();
    const loose: ChangeLogEntry[] = [];
    for (const c of changelog) {
      const s = reasonSection(c.section);
      if (s && decided.some((g) => g.section === s)) bySection.set(s, [...(bySection.get(s) ?? []), c]);
      else loose.push(c);
    }
    return { bySection, loose };
  }, [changelog, decided]);

  const groupCard = (g: EditGroup) => {
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
            // Both wear `tap-44` (14 px of layer each way): the row's 14 px of
            // top padding keeps the layers off the group's header button, and
            // under them are 8 px of spacing and the first card's padding.
            <div className="flex gap-3 pt-3.5 text-xs">
              <button
                type="button"
                onClick={() => setManyRejected(groupIds, false)}
                disabled={rejectedHere === 0}
                className="tap-44 text-mint hover:underline disabled:cursor-default disabled:opacity-40"
              >
                {t("groups.acceptGroup")}
              </button>
              <button
                type="button"
                onClick={() => setManyRejected(groupIds, true)}
                disabled={rejectedHere === groupIds.length}
                className="tap-44 text-danger hover:underline disabled:cursor-default disabled:opacity-40"
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
              // The same document reading the flag rows use, so the row
              // badge and the row above it can never disagree about one
              // value.
              flagOnDoc={flags.some((f) => editContainsValue(edit, f.value) && onDocument(edit, f.value))}
              onDecide={(r) => setRejected(edit.id, r)}
              decryptDelay={Math.min(i, 15) * 40}
              onShowInDoc={onShowInDoc && anchoredEdits?.[edit.id] ? () => onShowInDoc(edit.id) : undefined}
              override={overridden?.[edit.id]}
              onUseAi={onUseAi && (() => onUseAi(edit.id))}
              onUseOriginal={onUseOriginal && (() => onUseOriginal(edit.id))}
              onRestoreMine={onRestoreMine && (() => onRestoreMine(edit.id))}
            />
          ))}
        </div>
      </Disclosure>
    );
  };

  // The drawer's list: flagged groups first under their own heading, then each
  // section once, under the tailor's reason for it.
  const drawerGroups = () => {
    const out: ReactNode[] = [];
    let last: EditSection | null = null;
    let flaggedHeading = false;
    for (const g of decided) {
      if (g.flagged > 0) {
        if (!flaggedHeading) {
          flaggedHeading = true;
          out.push(
            <h4 key="h:flagged" className="pt-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-danger">
              {t("review.toCheck")}
            </h4>,
          );
        }
        out.push(groupCard(g));
        continue;
      }
      if (g.section !== last) {
        last = g.section;
        const why = reasons.bySection.get(g.section) ?? [];
        out.push(
          <div key={`h:${g.section}`} className="pt-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
              {t(`sections.${g.section}`)}
            </h4>
            {why.map((c, i) => (
              <p key={i} dir="auto" className="mt-0.5 text-xs leading-relaxed text-ink-faint">
                {c.reason ? t("review.sectionWhy", { change: changeLead(c.change), reason: c.reason }) : c.change}
              </p>
            ))}
          </div>,
        );
      }
      out.push(groupCard(g));
    }
    return out;
  };

  const notes = drawer ? reasons.loose : changelog;
  // A note's section in the reader's language; a section the model wrote in its
  // own words, as written.
  const noteSection = (section: string) => {
    const key = noteSectionKey(section);
    return key ? t(key) : section;
  };

  const body = (
    <>
      {!drawer && (
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
              {/* The clean body is the one sentence here that makes a claim about
                  the WHOLE document ("every employer, title, date, credential and
                  number… also appears in your original"), and the guard read only
                  the AI's rewrite. Anything the user typed afterwards it has never
                  seen, so the count is named rather than quietly folded in. */}
              {clean
                ? overrideCount > 0
                  ? t("changelog.cleanBodyEdited", { count: overrideCount })
                  : t("changelog.cleanBody")
                : allResolved
                  ? t("review.resolvedBody")
                  : t("changelog.flagged", { count: flags.length })}
            </p>
          </div>
        </div>
      )}

      {/* In the drawer the claims are ONE line with its icon, and the rows under
          it when there are any: the same sentences the card used, so what the
          guard can and cannot say is stated in one set of words. */}
      {drawer && (
        <p
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
            clean || allResolved ? "border-mint/30 bg-mint/5 text-ink-muted" : "border-danger/30 bg-danger/5 text-ink",
          )}
        >
          {clean || allResolved ? (
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-mint" />
          ) : (
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" />
          )}
          <span>
            {clean
              ? overrideCount > 0
                ? t("changelog.cleanBodyEdited", { count: overrideCount })
                : t("changelog.cleanBody")
              : allResolved
                ? t("review.resolvedBody")
                : t("changelog.flagged", { count: flags.length })}
          </span>
        </p>
      )}

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

      {drawer && beforeGroups}

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
                className="tap-44 text-mint hover:underline disabled:cursor-default disabled:opacity-40"
              >
                {t("review.acceptAll")}
              </button>
              <button
                type="button"
                onClick={() => onSetRejected(edits.map((e) => e.id))}
                disabled={acceptedCount === 0}
                className="tap-44 text-danger hover:underline disabled:cursor-default disabled:opacity-40"
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
          {!drawer && <PageBadge resume={effective} template={template} className="ms-auto" />}
        </div>
      )}

      {edits.length === 0 ? (
        <p className="mt-2 text-sm text-ink-muted">{t("changelog.noChanges")}</p>
      ) : (
        <div className="mt-3 space-y-2">
          {drawer ? drawerGroups() : decided.map(groupCard)}

          {!drawer && curation && (
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
              overridden={overridden}
            />
          )}
        </div>
      )}

      {notes.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer py-3.5 text-xs font-medium text-ink-muted hover:text-ink">
            {drawer ? t("review.otherNotes") : t("review.aiNotes")}
          </summary>
          <div className="mt-2 space-y-2">
            {notes.map((c, i) => (
              <div key={i} className="rounded-lg border-s-2 border-accent bg-panel-2/60 px-3 py-2">
                <div className="text-sm">
                  <span className="font-semibold capitalize text-accent-soft">{noteSection(c.section)}</span>
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
    </>
  );

  // The drawer is the card's content without the card: the drawer is already
  // the container, and a bordered, glowing card inside it is a box in a box.
  return drawer ? (
    <section id="trust-panel" className="scroll-mt-4">
      {body}
    </section>
  ) : (
    <Card
      id="trust-panel"
      glow={clean || allResolved}
      className={cn("scroll-mt-20", clean || allResolved ? "border-mint/40" : "border-danger/50")}
    >
      {body}
    </Card>
  );
}

/**
 * "Left out of this version", on its own (PLAN 31.3/3): the drawer shows it
 * after the keywords and the voice check, as its own section, where the card
 * kept it inside the change list. The same `CurationCard`, over the same group
 * `groupEdits` makes, and the same `rejected` set, so a Restore here and one in
 * the card form are one decision. `groupEdits` is handed a never-flagged
 * predicate on purpose: the quiet card provably holds no flag (see
 * `opensByDefault`), so the flag rule has nothing to decide here.
 */
export function LeftOut({
  edits,
  rejected,
  onSetRejected,
  original = null,
  lengthReport,
  plan,
  overridden,
}: {
  edits: ResumeEdit[];
  rejected: ReadonlySet<string>;
  onSetRejected: (ids: string[]) => void;
  original?: ResumeModel | null;
  lengthReport?: LengthReport;
  plan?: CVPlan | null;
  overridden?: Record<string, "yours" | "hidden" | "removed">;
}) {
  const curation = useMemo(() => groupEdits(edits, () => false).find((g) => g.key === CURATION_KEY), [edits]);
  const [open, setOpen] = useState<boolean | null>(null);
  if (!curation) return null;
  const setMany = (ids: string[], isRejected: boolean) => {
    const next = new Set(rejected);
    for (const id of ids) {
      if (isRejected) next.add(id);
      else next.delete(id);
    }
    onSetRejected([...next]);
  };
  return (
    <CurationCard
      group={curation}
      open={open ?? opensByDefault(curation)}
      onToggle={() => setOpen(!(open ?? opensByDefault(curation)))}
      original={original}
      lengthReport={lengthReport}
      plan={plan}
      rejected={rejected}
      onRestore={(id, r) => setMany([id], r)}
      onRestoreAll={(ids) => setMany(ids, true)}
      overridden={overridden}
    />
  );
}

/**
 * Everything from the resume that isn't in this CV, in one quiet card.
 *
 * Deliberately NOT N accept/decline rows: most of these are decisions the model
 * was told to make, and one collapsed card is the honest weight for them. It is
 * also the one card that provably cannot hide a fabrication flag — flag matching
 * needs a non-empty `after`, and every member here is either a removal or a
 * truncation of text already in the ledger.
 *
 * "Restore" is not new machinery: rejecting a removal is exactly what puts the
 * original content back, so this reuses the same `rejected` set as everything
 * else and the resume the user downloads can never disagree with these buttons.
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
  overridden,
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
  /** Every removal lands in THIS card rather than in an `EditRow`, so the
   * vanish rule's "its row says so" has to be answerable here too: restore a
   * cut bullet, rewrite it, un-restore, and the user's text is kept but not on
   * the page. No two-button treatment is needed — the Restore toggle is already
   * the decision, and un-restoring discards nothing — but the retention has to
   * be VISIBLE or it is a surprise on the next toggle. */
  overridden?: Record<string, "yours" | "hidden" | "removed">;
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
            className="inline-flex min-h-11 items-center text-xs font-medium text-accent-soft hover:underline"
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
                    {overridden?.[e.id] && (
                      <Badge tone={overridden[e.id] === "removed" ? "danger" : "mint"}>
                        {overridden[e.id] === "removed" ? t("review.yoursDeleted") : t("review.yours")}
                      </Badge>
                    )}
                    <button
                      type="button"
                      aria-pressed={isRestored}
                      onClick={() => onRestore(e.id, !isRestored)}
                      className={cn(
                        "min-h-11 shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium transition",
                        isRestored
                          ? "border-mint/40 bg-mint/15 text-mint"
                          : "border-line text-ink-muted hover:bg-panel-2 hover:text-ink",
                      )}
                    >
                      {isRestored ? t("curation.restored") : t("curation.restore")}
                    </button>
                    {/* VISIBLE, on its own line — this said the same thing in a
                        `title`, which on the phone this app is built for does
                        not exist at all. Three states, because a line the user
                        DELETED and a line a decision hid are not the same fact
                        about the same row. */}
                    {overridden?.[e.id] && (
                      <span className="w-full text-[11px] leading-relaxed text-ink-faint">
                        {overridden[e.id] === "removed"
                          ? t("review.yoursRemoved")
                          : overridden[e.id] === "hidden"
                            ? t("review.yoursHidden")
                            : t("review.yoursHere")}
                      </span>
                    )}
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
