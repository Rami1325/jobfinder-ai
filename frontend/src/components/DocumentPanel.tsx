import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { EntryInsertKind, NamedInsertKind } from "../lib/resumeBlocks";
import { useTranslation } from "react-i18next";
import {
  ClipboardCheck,
  Download,
  FileUp,
  FileText,
  LayoutTemplate,
  ListChecks,
  Monitor,
  ScanEye,
  type LucideIcon,
  X,
  History,
} from "lucide-react";
import ResumeView, { type BlockMark } from "./ResumeView";
import ReviewPanel, { badCount } from "./ReviewPanel";
import TemplatePicker from "./TemplatePicker";
import ResumeUpload from "./ResumeUpload";
import XrayResult from "./XrayResult";
import { usePageImages, usePdfPreview, useXray } from "../hooks/useFilePreview";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { downloadResume, resumeFilename, reviewRewrites, type ResumeTemplate } from "../api/client";
import { PDF_ONLY, TEMPLATE_SPECS } from "../lib/templateSpecs";
import { Button, Card, CardTitle, MoreMenu, Skeleton, type MoreItem } from "./ui";
import { apiErrorMessage } from "../lib/apiError";
import { cn } from "../lib/cn";
import type { FactsLedger, ResumeModel, ReviewResult, ReviewRewrite } from "../types";

export type { MoreItem };
export type DocView = "screen" | "file" | "ats";
const VIEWS: DocView[] = ["screen", "file", "ats"];

/** What the drawer is showing: the deterministic review of the document
 * ("Check my CV"), or a tailored draft's changes (PLAN 31.3/3). ONE drawer,
 * so the two can never be open over each other, and one set of rules (the
 * portal, the inline-end edge, the focus trap below `lg`) serves both. */
export type DrawerPane = "review" | "changes";

// The phone row's actions after the review (check-mirrors 44 holds the review
// first). On a tailored draft the bar on the tab bar already holds both
// downloads, and the changes open from the toolbar's "N changes" and the
// summary over the paper: a third door to the same drawer in a 358 px row was
// clipped at its count (measured at 390), so the draft's row is the template
// alone. The desktop rail keeps a Changes tool, where everything is in view.
const PHONE_MASTER = ["template", "download"];
const PHONE_DRAFT = ["template"];

const ICON = { screen: Monitor, file: FileText, ats: ScanEye } as const;

/** One entry in the tool list. `active` is present only on the toggles (the
 * three views and the template panel) — a verb like Download has no state, and
 * the difference is what decides whether `aria-pressed` is emitted at all. */
interface Tool {
  key: string;
  Icon: LucideIcon;
  label: string;
  active?: boolean;
  /**
   * A live number ON the control — the count of things to fix.
   *
   * THE METRIC IS THE AFFORDANCE. Before this, no control on `/app` carried a
   * number at all: you had to open a panel to learn whether it had anything in
   * it, so the panel that had nothing to say was indistinguishable from the one
   * with three broken dates. It is honest to put here for the same reason the
   * page badge and the coverage count sit on the toolbar — it is a deterministic,
   * uncapped, free read, not a model call, so it costs nothing to keep current.
   *
   * `undefined` = not measured yet (and NOT zero, the rule this repo applies to
   * every nullable it stores): the badge is absent while the first review is in
   * flight rather than announcing a clean document a moment before it finds
   * three problems. `0` is a real measurement and still draws nothing — a "0"
   * pinned to a button is noise, and the panel says "clean" in words.
   */
  count?: number;
  /** What the count is. `danger` (the default) is things to fix, the review's;
   * `accent` is things to look at, a draft's changes (PLAN 31.3/3): 24 changes
   * in the red of 24 problems says the tailor did something wrong 24 times. */
  countTone?: "danger" | "accent";
  /** The pill's visible text on a phone when `label` is too long for a row
   * with no room to scroll ("Download" for "Download .pdf"). `label` stays the
   * tooltip, and the icon says the rest. */
  short?: string;
  onClick: () => void;
}

/**
 * One tool, in the two shapes the two mount points need: a labelled pill in the
 * scrolling row on a phone, an icon square in the rail beside the paper on a
 * desktop. The label is the visible text in the first and the accessible name
 * in the second — never both, or the square's accessible name would repeat text
 * that is not on screen.
 */
function ToolButton({ tool, labelled }: { tool: Tool; labelled?: boolean }) {
  const { Icon } = tool;
  // Zero draws nothing — see `Tool.count`. `> 0` and not `!= null`, so an
  // undefined count and a measured zero take the same (silent) branch without
  // the two ever being stored as the same thing.
  const badge = (tool.count ?? 0) > 0 ? tool.count : null;
  return (
    <button
      type="button"
      title={tool.label}
      // The count has to reach the accessible name too, or the one control on
      // this page that carries a number is the one control a screen reader
      // learns nothing new from. On the labelled pill the number is a sibling
      // text node and is read as part of the button already, so it is added
      // only where the visible label is replaced by `aria-label`: the rail's
      // squares, and a pill showing its `short` text, whose full name is the
      // one to hear ("PDF" alone could be the view).
      aria-label={labelled && !tool.short ? undefined : badge ? `${tool.label} (${badge})` : tool.label}
      aria-pressed={tool.active}
      onClick={tool.onClick}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        // min-h-8: 32 px, the floor every other tap target here keeps. The pill
        // measured 30 px at 390 (the 2026-09-21 pass).
        labelled ? "min-h-8 snap-start px-3 py-1.5" : "h-10 w-10",
        tool.active
          ? "border-accent bg-accent text-white"
          : "border-line bg-panel text-ink-muted hover:border-accent/40 hover:text-ink",
      )}
    >
      <Icon size={labelled ? 13 : 16} aria-hidden />
      {labelled && (tool.short ?? tool.label)}
      {/* In the labelled row the count rides inline after the text; in the icon
          rail it is a corner pip, positioned with LOGICAL properties so it
          lands on the far top corner in RTL as well. `aria-hidden` on the pip:
          the number is already in `aria-label` above, and announcing it twice
          is worse than not announcing it. */}
      {badge !== null &&
        (labelled ? (
          <span
            className={cn(
              "rounded-full px-1.5 text-[11px] font-semibold tabular-nums",
              tool.active
                ? "bg-white/25 text-white"
                : tool.countTone === "accent"
                  ? "bg-accent/15 text-accent"
                  : "bg-danger/15 text-danger",
            )}
          >
            {badge}
          </span>
        ) : (
          <span
            aria-hidden
            className={cn(
              "absolute -top-1.5 -end-1.5 min-w-[16px] rounded-full border border-panel px-1 text-[10px] font-semibold leading-4 tabular-nums text-white",
              tool.countTone === "accent" ? "bg-accent" : "bg-danger",
            )}
          >
            {badge}
          </span>
        ))}
    </button>
  );
}

interface Props {
  resume: ResumeModel;
  template: ResumeTemplate;
  view: DocView;
  onView: (v: DocView) => void;
  /** Given only when the caller owns the template choice — see the rail's own
   * comment on why the picker belongs beside the paper. */
  onTemplate?: (t: ResumeTemplate) => void;
  company?: string;
  marks?: Map<string, BlockMark>;
  /** Passed straight through to ResumeView, and deliberately NOT merged into
   * `marks` — see its own Props note there. */
  flags?: Map<string, "bad" | "warn">;
  /** The deterministic review of the document above, as it stands right now.
   * `null` = not measured yet, which is why the tool's badge is absent rather
   * than zero until the first response lands. */
  review?: ReviewResult | null;
  /** A newer review is in flight; the panel dims rather than emptying. */
  reviewStale?: boolean;
  reviewFailed?: boolean;
  /**
   * Point the document at one block — the review row → paper jump.
   *
   * THE GATE FOR THE WHOLE REVIEW TOOL, the way `onTemplate` gates the picker
   * and `onReplace` gates the dropzone. A panel whose rows cannot be tapped is
   * a report, and a report is the thing this feature is not; the caller is also
   * the only party that can implement the jump, because it owns `docView` and
   * `scrollIntoView` on a `display:none` node is a silent no-op.
   */
  onJumpToBlock?: (path: string) => void;
  /**
   * Commit a suggested rewrite. Absent = the rewrites UI is not offered.
   *
   * This is the caller's own inline-commit function, unchanged: master ⇒
   * `applyBlockEdit`, tailored draft ⇒ `setBlockOverride`. Nothing in this
   * component or in `ReviewPanel` writes a resume.
   */
  onUseRewrite?: (path: string, text: string) => void;
  activeBlock?: string | null;
  /** Passed straight through to ResumeView — see its own doc comment. */
  activeNonce?: number;
  onSelectBlock?: (path: string) => void;
  /** Tap a block to edit it. Passed only when the document is the MASTER —
   * a tailored draft is a review surface, not an editing one. */
  onEditBlock?: (path: string) => void;
  onInlineCommit?: (path: string, text: string) => void;
  onAddSkill?: (groupLabel: string, text: string) => void;
  /** Both or neither — ResumeView renders the seven-row add control only when
   * it can serve all seven. See its own Props note. */
  onAdd?: (kind: EntryInsertKind) => void;
  onAddNamed?: (kind: NamedInsertKind, text: string) => void;
  onAddBullet?: (entryPath: string) => void;
  /** Passed straight through to ResumeView — one line at the foot of the paper
   * for a surface that cannot add. */
  footNote?: string;
  /** Swap the master resume for a newly uploaded file. Given only when the
   * document IS the master — replacing the file under a tailor review would be
   * replacing the thing being reviewed. Its absence hides the tool entirely,
   * the same way `onTemplate` gates the picker. */
  onReplace?: (resume: ResumeModel, ledger: FactsLedger) => void;
  /** More entries for the phone row's "⋯" (PLAN 31.2/3), after Replace. */
  moreItems?: MoreItem[];
  /** Open the master's version history (PLAN 31.6/3). Given only where the
   * document is the master, the same gate as `onReplace`. */
  onHistory?: () => void;
  /**
   * A tailored draft's review, as the drawer's second pane (PLAN 31.3/3): the
   * changes, the keywords, the voice check and what was left out, in the drawer
   * "Check my CV" already opens, instead of four cards under the paper. `count`
   * rides the tool the way the review's does: absent, never 0, until known.
   */
  changes?: { count?: number; content: ReactNode };
  /** The pane the drawer shows, when the PAGE decides it: the toolbar's
   * "N changes", the summary over the paper and a changed block on it all open
   * the changes. Without `onPane` the drawer keeps its own state. */
  pane?: DrawerPane | null;
  onPane?: (pane: DrawerPane | null) => void;
}

/**
 * The document, in the three forms that are actually different things:
 * what it looks like on screen (an approximation you can click), what the file
 * really is (the PDF the Download button produces), and what a parser gets back
 * out of that file.
 *
 * INLINE TABS, not a modal, and that is a measured choice. `Modal` binds ESC on
 * `window` and closes on a backdrop click — once focus enters a PDF plugin its
 * key and click events never reach either, so both exits die. Its panel also has
 * no `max-h` and no `overflow`, so a page-tall embed pushes the close button off
 * screen; the only remaining exit scrolls away. Fixing that is a behaviour change
 * across six shipped dialogs, including the tracker's détail modal. The template
 * panel below opens for the same reason as a panel and not as a dialog.
 *
 * The screen view stays MOUNTED (hidden) when another tab is active, because it
 * owns the block anchors the review panel jumps to — `scrollIntoView` on a
 * `display:none` node is a no-op.
 */
const DocumentPanel = forwardRef<HTMLDivElement, Props>(function DocumentPanel(
  { resume, template, view, onView, onTemplate, company = "", marks, flags, review, reviewStale, reviewFailed, onJumpToBlock, onUseRewrite, activeBlock, activeNonce, onSelectBlock, onEditBlock, onInlineCommit, onAddSkill, onAdd, onAddNamed, onAddBullet, footNote, onReplace, moreItems, onHistory, changes, pane: paneProp, onPane },
  screenRef,
) {
  const { t } = useTranslation("tailor");
  // From sm the browser draws the real PDF in a frame; below it, a phone gets
  // pictures of the same file (PLAN 31.2/4). Only the one the screen shows is
  // fetched.
  const framesPdf = useMediaQuery("(min-width: 640px)");
  const pdf = usePdfPreview(resume, template, view === "file" && framesPdf);
  const pics = usePageImages(resume, template, view === "file" && !framesPdf);
  const xray = useXray(resume, template, view === "ats");
  const [tplOpen, setTplOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  // The drawer's pane. Controlled by the page when it passes `onPane` (a draft's
  // changes open from three places outside this component); its own otherwise.
  const [ownPane, setOwnPane] = useState<DrawerPane | null>(null);
  const pane: DrawerPane | null = onPane ? (paneProp ?? null) : ownPane;
  const setPane = onPane ?? setOwnPane;
  // Open at all, whichever pane: the name the focus trap and the page's
  // reserved width have always read.
  const reviewOpen = pane !== null;
  // The blocks the pointer is over in the drawer. Local to this component
  // because nothing above it needs to know: it paints a tint and is gone on
  // mouseleave, so lifting it to TailorPage would re-render the whole
  // document surface on every row the pointer crosses.
  const [hoverPaths, setHoverPaths] = useState<Set<string> | null>(null);
  // Only for `aria-modal`: the drawer traps nothing at `lg` and above, where it
  // sits beside the paper rather than over it.
  const isWide =
    typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
  // Below `lg` the drawer is modal, so focus goes into it when it opens, stays in
  // it on Tab, and returns to the "Check my CV" pill when it closes. It used to
  // stay on the pill, outside an `aria-modal` dialog (the 2026-09-21 390 px
  // pass). From `lg` it sits beside the paper and takes nothing.
  const drawerRef = useRef<HTMLElement>(null);
  useDialogFocus(reviewOpen && !!onJumpToBlock && !isWide, drawerRef);
  // Closing drops the tint with the drawer. Without this, moving the pointer
  // off a row and onto the close button leaves the highlighted blocks lit with
  // nothing on screen that explains them — a mark on the document the user
  // cannot get rid of short of hovering another row.
  const closeReview = () => {
    setPane(null);
    setHoverPaths(null);
  };
  // A draft's changes close with the draft: "Back to my resume" or a new tailor
  // takes `changes` away, and a drawer left open on a pane with nothing in it
  // would be a blank panel with a close button.
  useEffect(() => {
    if (pane === "changes" && !changes) setPane(null);
  }, [pane, changes]); // eslint-disable-line react-hooks/exhaustive-deps

  // THE DRAWER RESERVES ITS WIDTH FROM `lg` UP, where it has no backdrop and is
  // meant to sit BESIDE the document rather than over it. It is `position:
  // fixed` and the page's column is centred (`.app-col`), so on any viewport whose centring
  // gutter is under 380px the drawer lands ON TOP of the content — measured at
  // 1707px in Hebrew: drawer 0-380 against a toolbar at 272-1424 and a tool rail
  // at 304-344, so the Tailor button, the template picker, both downloads and
  // Replace were all under the panel that hid them.
  //
  // A CLASS ON `body`, not padding on a container, because the things it has to
  // move are SIBLINGS in three different components: the sticky
  // `DocumentToolbar` is rendered by `TailorPage`, the rail and the sheet by
  // this file. Padding the row here moved the rail and left the toolbar behind —
  // which is the bug the owner screenshotted. One rule on `main` moves all of
  // them, and `padding-inline-end` is logical so it pushes away from whichever
  // edge the drawer is actually on.
  useEffect(() => {
    const on = reviewOpen && !!onJumpToBlock;
    document.body.classList.toggle("review-open", on);
    return () => document.body.classList.remove("review-open");
  }, [reviewOpen, onJumpToBlock]);

  // Escape closes it, the same shape `Modal` and `BlockEditSheet` use. Below
  // `lg` this drawer IS modal -- it and its backdrop both cover the z-30 tab bar
  // -- and a full-screen overlay with no keyboard dismissal is the one thing
  // every other overlay in this app already gets right.
  useEffect(() => {
    if (!reviewOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeReview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reviewOpen]);
  /* THE SUGGESTIONS LIVE HERE, not inside ReviewPanel, and the reason is money.
     That panel is rendered conditionally — an inline Card, never a height tween
     (check 11) — so it unmounts the moment the review is closed. With the
     rewrites in its own state, closing the panel silently discarded a result
     the user had just spent a use on, and reopening it offered to spend a
     second one for the same three sentences. `tplOpen` / `replaceOpen` are up
     here for the same structural reason; this one just also has a price.

     The call is made here rather than passed in because it is the panel's own
     button, not the page's: `POST /tools/review/rewrites` needs nothing the
     page owns beyond the resume this component already renders. What the page
     DOES own is the write — `onUseRewrite` — because master-vs-tailored is its
     rule and nothing here may reimplement it. */
  const [rewrites, setRewrites] = useState<ReviewRewrite[] | null>(null);
  const [rewritesDropped, setRewritesDropped] = useState(0);
  const [rewritesBusy, setRewritesBusy] = useState(false);
  // The refusal's own sentence (Phase 30 / C4), shown under the button: at the
  // monthly limit it says when uses come back.
  const [rewritesError, setRewritesError] = useState("");

  async function suggestRewrites() {
    setRewritesBusy(true);
    setRewritesError("");
    try {
      // `paths: []` = "pick the rewritable findings server-side". The panel's
      // own REWRITABLE list only decides whether the BUTTON is on screen, so
      // the selection has exactly one author.
      const res = await reviewRewrites(resume, []);
      setRewrites(res.rewrites);
      setRewritesDropped(res.dropped);
    } catch (e) {
      setRewritesError(apiErrorMessage(e, t("doc.review.failed")));
    } finally {
      setRewritesBusy(false);
    }
  }
  // Read for the note under the screen view only — ResumeView resolves its own
  // spec from the same table. `?? classic` is `get_template`'s own fallback.
  const spec = TEMPLATE_SPECS[template] ?? TEMPLATE_SPECS.classic;

  /* Defined once, mounted twice — the same arrangement `SidebarBody` uses for
     the rail and the drawer, and for the same reason: a tool that exists in one
     viewport and not the other is a tool nobody maintains. The copy that is not
     showing is `display:none`, which takes it out of the accessibility tree
     entirely, so the two mounts can never read as duplicate controls. */
  const tools: Tool[] = [
    ...VIEWS.map((v) => ({
      key: v,
      Icon: ICON[v],
      label: t(`doc.views.${v}`),
      active: view === v,
      onClick: () => onView(v),
    })),
    // The picker lives beside the paper because the template governs all three
    // views AND the download. While its only home was inside the tailor result,
    // the PDF and ATS tabs rendered whatever `template` happened to be — you
    // could not see the design you were about to send until you had paid for a
    // tailor, and could not change it from the master document at all.
    ...(onTemplate
      ? [
          {
            key: "template",
            Icon: LayoutTemplate,
            label: t("download.templateLabel"),
            active: tplOpen,
            onClick: () => setTplOpen((o) => !o),
          },
        ]
      : []),
    // The review. Placed BEFORE Download deliberately: it is the control that
    // has something to say about the file you are about to download, and a
    // list whose most consequential item comes after the terminal action reads
    // as an afterthought. It is also the only tool here carrying a number, and
    // that number is the reason it is on the rail rather than inside a tab.
    ...(onJumpToBlock
      ? [
          {
            key: "review",
            Icon: ClipboardCheck,
            label: t("doc.review.tool"),
            short: t("doc.review.short"),
            active: pane === "review",
            // `undefined` until the first response, never 0 — see `Tool.count`.
            count: review ? badCount(review) : undefined,
            onClick: () => (pane === "review" ? closeReview() : setPane("review")),
          },
        ]
      : []),
    // A tailored draft's changes (PLAN 31.3/3), beside the review they share a
    // drawer with.
    ...(onJumpToBlock && changes
      ? [
          {
            key: "changes",
            Icon: ListChecks,
            label: t("doc.changes.tool"),
            active: pane === "changes",
            count: changes.count,
            countTone: "accent" as const,
            onClick: () => (pane === "changes" ? closeReview() : setPane("changes")),
          },
        ]
      : []),
    {
      key: "download",
      Icon: Download,
      label: t("download.pdf"),
      short: t("download.short"),
      onClick: () =>
        downloadResume(resume, "pdf", resumeFilename(resume.contact?.name ?? "", company), template),
    },
    // Replacing the file used to be possible ONLY from the Jobs page, because
    // /app offers the dropzone in its empty state and nowhere else — so the
    // one page that IS the resume was the one page that could not change it.
    // It rides the shared tool list rather than the toolbar for the reason the
    // list exists: a control defined once is mounted in both the phone row and
    // the desktop rail, and cannot exist in one viewport only.
    ...(onReplace
      ? [
          {
            key: "replace",
            Icon: FileUp,
            label: t("doc.replace.tool"),
            active: replaceOpen,
            onClick: () => setReplaceOpen((o) => !o),
          },
        ]
      : []),
    // The master's own history (PLAN 31.6/3), beside Replace for the same
    // reason: the page that IS the resume offers everything done to it.
    ...(onHistory ? [{ key: "history", Icon: History, label: t("doc.history.tool"), onClick: onHistory }] : []),
  ];

  // THE PHONE ROW LEADS WITH THE REVIEW. The row showed ~366 px of ~940, and in
  // the shared order the review is 5th, behind three view pills and Template,
  // so the only number on the row was off-screen on first paint (measured at
  // 390 px, 2026-09-21). Only this row moves: the desktop rail keeps the order
  // the list documents, where everything is in view.
  //
  // AND IT HOLDS ACTIONS ONLY (PLAN 31.2/3). The three views were pills in the
  // same scrolling row as the verbs, so Download sat 6th, off-screen, behind
  // things that are not actions at all. The views are a segmented control of
  // their own under this row, and what has no slot here (Replace, and what the
  // page adds) is under "⋯", so Download is always in view.
  const phoneTools = [...tools.filter((x) => x.key === "review"), ...tools.filter((x) => (changes ? PHONE_DRAFT : PHONE_MASTER).includes(x.key))];
  const more: MoreItem[] = [
    ...(onReplace
      ? [{ key: "replace", label: t("doc.replace.tool"), Icon: FileUp, onClick: () => setReplaceOpen((o) => !o) }]
      : []),
    ...(onHistory ? [{ key: "history", label: t("doc.history.tool"), Icon: History, onClick: onHistory }] : []),
    ...(moreItems ?? []),
  ];

  return (
    // Flex + logical properties, never absolute positioning: the rail has to
    // land on the far side of the paper in RTL as well, and `gap` + source
    // order do that with no second rule. `items-start` is what gives the rail
    // a sticky range — a stretched flex child has nothing to slide inside.
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1 space-y-3">
        {/* The actions, then "⋯". The pills still scroll themselves (below
            1024px the body is `overflow-x: clip`, so a row that can exceed the
            width has to own its own scroller, and a long Hebrew label can), but
            "⋯" sits OUTSIDE that scroller: an absolutely placed list inside an
            `overflow-x-auto` box is clipped by it. Hidden from `lg`, where the
            same list stands up as the rail. */}
        <div className="flex items-start gap-1.5 lg:hidden">
          <div
            role="group"
            aria-label={t("doc.toolsLabel")}
            className="-ms-1 flex min-w-0 flex-1 snap-x gap-1.5 overflow-x-auto pb-1 ps-1 lg:hidden"
          >
            {phoneTools.map((tool) => (
              <ToolButton key={tool.key} tool={tool} labelled />
            ))}
          </div>
          {more.length > 0 && <MoreMenu items={more} label={t("doc.more")} />}
        </div>

        {/* The views, as one segmented control directly over what they switch
            (PLAN 31.2/3). After the actions row on purpose: check-mirrors 44
            reads the FIRST phone group, which must lead with the review. */}
        <div
          role="group"
          aria-label={t("doc.viewsLabel")}
          className="flex rounded-lg border border-line bg-panel-2/40 p-0.5 lg:hidden"
        >
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => onView(v)}
              className={cn(
                // `flex-auto`, not `flex-1`: each segment starts from its own
                // text, so "What the ATS reads" is not cut to a third of the row.
                "min-h-8 min-w-0 flex-auto truncate rounded-md px-2 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                view === v ? "bg-panel text-ink shadow-sm" : "text-ink-muted hover:text-ink",
              )}
            >
              {t(`doc.views.${v}`)}
            </button>
          ))}
        </div>

        {/* Full width, directly under the tools, and animated on transform and
            opacity only — a click-to-open element that tweens `height: auto`
            wedges at 0px with its content present underneath. */}
        {onTemplate && tplOpen && (
          <Card className="animate-fade-up">
            <TemplatePicker value={template} onChange={onTemplate} label={t("download.templateLabel")} />
          </Card>
        )}

        {/* Same shape and the same reasons as the template panel above: an
            inline Card, opacity + transform only. The panel closes itself on a
            successful parse — the new document appears directly beneath it, so
            leaving the dropzone open would sit between the user and the thing
            they just uploaded. */}
        {onReplace && replaceOpen && (
          <Card className="animate-fade-up">
            <CardTitle>{t("doc.replace.title")}</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">{t("doc.replace.body")}</p>
            <div className="mt-3">
              <ResumeUpload
                onParsed={(r, l) => {
                  setReplaceOpen(false);
                  onReplace(r, l);
                }}
              />
            </div>
          </Card>
        )}

        {/* THE REVIEW IS A DRAWER, not an inline card (owner's request,
            2026-09-04). Three things about it are load-bearing.

            It slides on TRANSFORM and opacity ONLY — never a height tween.
            check-mirrors 11 fails the build on one and there are seven shipped
            defects behind it, including this exact panel shape twice on the
            Jobs page where Replace froze at 80px over a 287px dropzone.

            It opens from the INLINE-END edge, so it is on the right in English
            and the left in Hebrew, and `--drawer-from` flips the keyframe with
            it — a hard-coded `translateX(100%)` would slide the Hebrew drawer
            in from the far side, straight across the document it is about to
            sit beside.

            It starts BELOW the `h-14` header (`top-14`) and sits at `z-40`:
            under the header's `z-[45]` so the app's own chrome stays reachable
            while it is open, and under the `z-50` modal layer so it can never
            paint over `BlockEditSheet`'s scrim. */}
        {/* PORTALLED TO `document.body`, and that is not tidiness — it is the
            only thing that makes `fixed` mean fixed. An ancestor of this panel
            carries a `transform` (a motion wrapper mid-tween), and a
            transformed element becomes the containing block for every
            fixed-position descendant, so the drawer resolved against a div two
            thousand pixels down the page instead of the viewport. Measured
            before the portal: top 162, bottom 3316, pinned to neither edge.
            `AccessGate`, `BlockEditSheet` and `Modal` all portal for the same
            reason. */}
        {onJumpToBlock && reviewOpen && createPortal(
          <>
            {/* Backdrop on small screens only: at 390px the drawer covers the
                paper, so there has to be somewhere to tap to dismiss it. On a
                wide screen the drawer sits BESIDE the document and a backdrop
                would block the very blocks its rows point at. */}
            <button
              type="button"
              aria-label={t("doc.review.close")}
              // `touch-none` because `overscroll-contain` only stops a drag
              // that STARTS inside the panel from chaining out, and a drag that
              // starts on the backdrop is not in the panel -- the exact pairing
              // `AppLayout` already documents having paid for once, where the
              // document scrolled behind a stationary sheet.
              className="fixed inset-0 top-14 z-[39] touch-none bg-black/40 lg:hidden"
              onClick={() => closeReview()}
            />
            <aside
              // MODAL BELOW `lg`, BESIDE THE DOCUMENT FROM `lg`. Under the
              // breakpoint the drawer and its backdrop both cover the z-30 tab
              // bar and the paper, which is what makes the close button, the
              // dismissable backdrop and the Escape key load-bearing; at `lg`
              // and above it sits beside the document, nothing is trapped, and
              // announcing it as a modal would be a lie to a screen reader.
              // `overscroll-contain` on the aside itself and not only on the
              // scroller, because the header row is outside the scroller and a
              // drag starting there would otherwise chain to the page.
              ref={drawerRef}
              tabIndex={-1}
              className="animate-drawer-in fixed top-14 bottom-0 end-0 z-40 flex w-full max-w-[380px] flex-col overscroll-contain border-s border-line bg-panel shadow-2xl outline-none"
              aria-label={pane === "changes" ? t("doc.changes.title") : t("doc.review.title")}
              role="dialog"
              aria-modal={!isWide}
            >
              <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
                {changes ? (
                  // Two panes, one drawer: a switch in its own header, so the
                  // changes and the review of the same draft are one tap apart.
                  <div
                    role="group"
                    aria-label={t("doc.changes.panes")}
                    className="flex min-w-0 rounded-lg border border-line bg-panel-2/40 p-0.5"
                  >
                    {(["changes", "review"] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        aria-pressed={pane === p}
                        onClick={() => setPane(p)}
                        className={cn(
                          "min-h-8 truncate rounded-md px-2.5 text-xs font-semibold transition-colors",
                          pane === p ? "bg-panel text-ink shadow-sm" : "text-ink-muted hover:text-ink",
                        )}
                      >
                        {p === "changes" ? t("doc.changes.title") : t("doc.review.title")}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm font-semibold text-ink">{t("doc.review.title")}</p>
                )}
                <button
                  type="button"
                  aria-label={t("doc.review.close")}
                  onClick={() => closeReview()}
                  // h-8 like the row's own controls. Below `lg` this drawer is modal and
                  // this X is the primary way out of it, so it may not be the
                  // smallest target in the panel it dismisses -- measured at
                  // 28x28 against 32x32 rows in a real 390px pass.
                  className="grid h-8 w-8 place-items-center rounded-lg border border-line text-ink-muted"
                >
                  <X size={14} />
                </button>
              </div>
              {/* The SCROLLER is here, not on the panel: the drawer owns its
                  own height and the list inside it is what overflows. */}
              {/* `pb` carries the safe-area inset: this is the only
                  bottom-anchored fixed element in the app without one, and on a
                  gesture-bar phone the last row sits under the bar. */}
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
                {pane === "changes" && changes ? (
                  changes.content
                ) : (
                  <ReviewPanel
                    resume={resume}
                    data={review ?? null}
                    stale={!!reviewStale}
                    failed={!!reviewFailed}
                    // BELOW `lg` THE JUMP CLOSES THE DRAWER, because the
                    // drawer is what the jump would land behind. `jumpToBlock`
                    // switches the view, spotlights the block and scrolls to it --
                    // all three under an opaque full-bleed panel on a phone, with
                    // a 2200 ms spotlight the user cannot see start. The inline
                    // card this replaced sat ABOVE the document and never had the
                    // problem; the drawer reintroduced it. Evaluated at click
                    // time so a rotation is handled.
                    onJump={(path) => {
                      onJumpToBlock(path);
                      if (!window.matchMedia("(min-width: 1024px)").matches) closeReview();
                    }}
                    // Hover marks the paper; the tap still scrolls and spotlights.
                    onHover={(paths) => setHoverPaths(paths ? new Set(paths) : null)}
                    onUseRewrite={onUseRewrite}
                    rewrites={rewrites ?? undefined}
                    rewritesDropped={rewritesDropped}
                    rewritesBusy={rewritesBusy}
                    rewritesError={rewritesError}
                    onSuggestRewrites={suggestRewrites}
                  />
                )}
              </div>
            </aside>
          </>,
          document.body,
        )}

        {/* Always mounted — it carries the block anchors the review panel jumps to. */}
        <div ref={screenRef} className={cn(view !== "screen" && "hidden")}>
          <ResumeView
            resume={resume}
            surface="sheet"
            // The whole point of the picker beside the paper. `template` was in
            // scope here and went to the PDF preview, the x-ray and both
            // downloads but not to the document itself, so picking Executive
            // gave you a serif, cream, centred-name PDF while the page you edit
            // on stayed sans, white and left-aligned. Every other surface
            // honoured the choice; the one the user works on did not.
            template={template}
            marks={marks}
            // A SECOND Map, never merged into `marks` — one holds who last
            // spoke on a line, the other holds what a check found on it, and a
            // single Map would silently keep whichever was written last.
            flags={flags}
            hoverPaths={hoverPaths ?? undefined}
            activeBlock={activeBlock}
            activeNonce={activeNonce}
            onSelectBlock={onSelectBlock}
            onEditBlock={onEditBlock}
            onInlineCommit={onInlineCommit}
            onAddSkill={onAddSkill}
            onAdd={onAdd}
            onAddNamed={onAddNamed}
            onAddBullet={onAddBullet}
            footNote={footNote}
          />
          {/* What the page above deliberately does NOT reproduce, said out loud
              — the same shape as the download's own docxFallback note. The
              screen draws the template's palette, heading grammar, header band,
              entry grammar, bullet glyph and column count; it cannot load Lato
              or Spectral (both are PDF-EMBEDDED, and fonts.css ships only the
              Inter/Heebo subsets), and it does not guess a sidebar, because
              which sections land in the rail is a reportlab MEASUREMENT with a
              demote pass — a DOM guess would show sections in the rail that the
              real file moved out, which is a new lie in the same class as the
              one this note exists beneath.
              A plain conditional <p>, never a reveal: it must not acquire a
              motion wrapper, and nothing here animates a height. */}
          <p className="mt-3 text-xs leading-relaxed text-ink-faint">
            {t("doc.screen.note")}
            {/* Each sentence appears only where it is TRUE of this template.
                Six of the eleven draw no contact marks at all, and a note that
                admits to a difference that is not there is the same defect as
                one that hides a difference that is — just pointing the other
                way. */}
            {(spec.contactIcons || spec.dateIcon) && ` ${t("doc.screen.icons")}`}
            {/* The page footer is the ONE place the PDF and the DOCX genuinely
                disagree, because it carries TEXT — it is not one of the ornament
                carve-outs, and it is said out loud here for that reason. This
                surface has no page boundaries to foot either. Gated like the
                sentence above it: eleven templates draw none. */}
            {spec.footerName && ` ${t("doc.screen.footer")}`}
            {PDF_ONLY(template) && ` ${t("doc.screen.twoColumn")}`}
          </p>
        </div>

        {view === "file" && (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-ink-faint">{t("doc.file.note")}</p>
            {framesPdf ? (
              pdf.failed && !pdf.url ? (
                <p className="text-sm text-danger">{t("doc.file.failed")}</p>
              ) : !pdf.url ? (
                <Skeleton className="h-[70vh] w-full" />
              ) : (
                // An <iframe>, not <embed>: <embed> has no accessible name.
                // dir="ltr" because an RTL horizontal scroller starts at the
                // wrong end.
                <iframe
                  title={t("doc.views.file")}
                  dir="ltr"
                  src={`${pdf.url}#toolbar=0&navpanes=0&view=FitH`}
                  className={cn("h-[70vh] w-full rounded-lg border border-line bg-white", pdf.loading && "opacity-60")}
                />
              )
            ) : pics.failed && !pics.data ? (
              <p className="text-sm text-danger">{t("doc.file.failed")}</p>
            ) : !pics.data ? (
              <Skeleton className="aspect-[1/1.414] w-full" />
            ) : (
              // PICTURES OF THE FILE, on a phone (PLAN 31.2/4). A phone browser
              // does not draw a `blob:` PDF inside a page, so this view said so
              // and offered Open and Download: the one view whose job is "this
              // is really your file" showed nothing of it. These are drawn by
              // PDFium from the same bytes the download sends.
              <div className={cn("space-y-3", pics.loading && "opacity-60")}>
                {pics.data.pages.map((png, i) => (
                  <img
                    key={i}
                    src={`data:image/png;base64,${png}`}
                    alt={t("doc.file.pageAlt", { n: i + 1, total: pics.data!.total })}
                    className="w-full rounded-lg border border-line bg-white shadow-sm"
                  />
                ))}
                {pics.data.total > pics.data.pages.length && (
                  <p className="text-xs text-ink-muted">
                    {t("doc.file.morePages", { count: pics.data.total - pics.data.pages.length })}
                  </p>
                )}
              </div>
            )}
            <Button
              variant="ghost"
              icon={<Download size={15} />}
              onClick={() => downloadResume(resume, "pdf", resumeFilename(resume.contact?.name ?? "", company), template)}
            >
              {t("doc.file.download")}
            </Button>
          </div>
        )}

        {view === "ats" && (
          <>
            {xray.failed && !xray.result ? (
              <p className="text-sm text-danger">{t("doc.ats.failed")}</p>
            ) : !xray.result ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <div className={cn(xray.loading && "opacity-60")}>
                <p className="mb-3 text-xs leading-relaxed text-ink-faint">{t("doc.ats.note")}</p>
                <XrayResult result={xray.result} template={template} surface="plain" showLegend={false} />
              </div>
            )}
          </>
        )}
      </div>

      {/* The rail. `top-32` clears the app header (3.5rem) and the document
          toolbar stuck under it. Room check before committing to `lg`, measured
          at the breakpoint itself: a 1024px viewport leaves a 709px content box
          once the 240px desktop nav, the scrollbar and `lg:px-8` are out, so the
          40px squares plus the 12px gap put the sheet at 657px — it narrows
          rather than overflowing (nothing scrolls sideways), and it reaches its
          full 736px from ~1100px up. */}
      <div
        role="group"
        aria-label={t("doc.toolsLabel")}
        className="sticky top-32 hidden shrink-0 flex-col gap-1.5 lg:flex"
      >
        {tools.map((tool) => (
          <ToolButton key={tool.key} tool={tool} />
        ))}
      </div>
    </div>
  );
});

export default DocumentPanel;
