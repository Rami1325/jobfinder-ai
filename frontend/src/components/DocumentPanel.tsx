import { forwardRef, useState } from "react";
import type { EntryInsertKind, NamedInsertKind } from "../lib/resumeBlocks";
import { useTranslation } from "react-i18next";
import {
  ClipboardCheck,
  Download,
  FileUp,
  ExternalLink,
  FileText,
  LayoutTemplate,
  Monitor,
  ScanEye,
  type LucideIcon,
} from "lucide-react";
import ResumeView, { type BlockMark } from "./ResumeView";
import ReviewPanel, { badCount } from "./ReviewPanel";
import TemplatePicker from "./TemplatePicker";
import ResumeUpload from "./ResumeUpload";
import XrayResult from "./XrayResult";
import { usePdfPreview, useXray } from "../hooks/useFilePreview";
import { downloadResume, resumeFilename, reviewRewrites, type ResumeTemplate } from "../api/client";
import { PDF_ONLY, TEMPLATE_SPECS } from "../lib/templateSpecs";
import { Button, Card, CardTitle, Skeleton } from "./ui";
import { cn } from "../lib/cn";
import type { FactsLedger, ResumeModel, ReviewResult, ReviewRewrite } from "../types";

export type DocView = "screen" | "file" | "ats";
const VIEWS: DocView[] = ["screen", "file", "ats"];

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
      // only where the visible label is replaced by `aria-label`.
      aria-label={labelled ? undefined : badge ? `${tool.label} (${badge})` : tool.label}
      aria-pressed={tool.active}
      onClick={tool.onClick}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        labelled ? "snap-start px-3 py-1.5" : "h-10 w-10",
        tool.active
          ? "border-accent bg-accent text-white"
          : "border-line bg-panel text-ink-muted hover:border-accent/40 hover:text-ink",
      )}
    >
      <Icon size={labelled ? 13 : 16} aria-hidden />
      {labelled && tool.label}
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
              tool.active ? "bg-white/25 text-white" : "bg-danger/15 text-danger",
            )}
          >
            {badge}
          </span>
        ) : (
          <span
            aria-hidden
            className="absolute -top-1.5 -end-1.5 min-w-[16px] rounded-full border border-panel bg-danger px-1 text-[10px] font-semibold leading-4 tabular-nums text-white"
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
   * component or in `ReviewPanel` writes a résumé.
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
  /** Swap the master résumé for a newly uploaded file. Given only when the
   * document IS the master — replacing the file under a tailor review would be
   * replacing the thing being reviewed. Its absence hides the tool entirely,
   * the same way `onTemplate` gates the picker. */
  onReplace?: (resume: ResumeModel, ledger: FactsLedger) => void;
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
  { resume, template, view, onView, onTemplate, company = "", marks, flags, review, reviewStale, reviewFailed, onJumpToBlock, onUseRewrite, activeBlock, activeNonce, onSelectBlock, onEditBlock, onInlineCommit, onAddSkill, onAdd, onAddNamed, onAddBullet, footNote, onReplace },
  screenRef,
) {
  const { t } = useTranslation("tailor");
  const pdf = usePdfPreview(resume, template, view === "file");
  const xray = useXray(resume, template, view === "ats");
  const [tplOpen, setTplOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  /* THE SUGGESTIONS LIVE HERE, not inside ReviewPanel, and the reason is money.
     That panel is rendered conditionally — an inline Card, never a height tween
     (check 11) — so it unmounts the moment the review is closed. With the
     rewrites in its own state, closing the panel silently discarded a result
     the user had just spent an AI credit on, and reopening it offered to spend
     a second one for the same three sentences. `tplOpen` / `replaceOpen` are up
     here for the same structural reason; this one just also has a price.

     The call is made here rather than passed in because it is the panel's own
     button, not the page's: `POST /tools/review/rewrites` needs nothing the
     page owns beyond the résumé this component already renders. What the page
     DOES own is the write — `onUseRewrite` — because master-vs-tailored is its
     rule and nothing here may reimplement it. */
  const [rewrites, setRewrites] = useState<ReviewRewrite[] | null>(null);
  const [rewritesDropped, setRewritesDropped] = useState(0);
  const [rewritesBusy, setRewritesBusy] = useState(false);
  const [rewritesFailed, setRewritesFailed] = useState(false);

  async function suggestRewrites() {
    setRewritesBusy(true);
    setRewritesFailed(false);
    try {
      // `paths: []` = "pick the rewritable findings server-side". The panel's
      // own REWRITABLE list only decides whether the BUTTON is on screen, so
      // the selection has exactly one author.
      const res = await reviewRewrites(resume, []);
      setRewrites(res.rewrites);
      setRewritesDropped(res.dropped);
    } catch {
      setRewritesFailed(true);
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
            active: reviewOpen,
            // `undefined` until the first response, never 0 — see `Tool.count`.
            count: review ? badCount(review) : undefined,
            onClick: () => setReviewOpen((o) => !o),
          },
        ]
      : []),
    {
      key: "download",
      Icon: Download,
      label: t("download.pdf"),
      onClick: () =>
        downloadResume(resume, "pdf", resumeFilename(resume.contact?.name ?? "", company), template),
    },
    // Replacing the file used to be possible ONLY from the Jobs page, because
    // /app offers the dropzone in its empty state and nowhere else — so the
    // one page that IS the résumé was the one page that could not change it.
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
  ];

  return (
    // Flex + logical properties, never absolute positioning: the rail has to
    // land on the far side of the paper in RTL as well, and `gap` + source
    // order do that with no second rule. `items-start` is what gives the rail
    // a sticky range — a stretched flex child has nothing to slide inside.
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1 space-y-3">
        {/* Scrolls itself: below 1024px the body is `overflow-x: clip`, so a row
            that can exceed the width has to own its own scroller. Hidden from
            `lg`, where the same list stands up as the rail. */}
        <div
          role="group"
          aria-label={t("doc.toolsLabel")}
          className="-mx-1 flex snap-x gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden"
        >
          {tools.map((tool) => (
            <ToolButton key={tool.key} tool={tool} labelled />
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

        {/* The third inline Card, in the same shape and for the same reasons as
            the two above: rendered conditionally, `animate-fade-up` (opacity +
            transform), and NEVER a motion `height: auto` tween. check-mirrors
            11 fails the build on one and there are seven shipped defects behind
            it — including this exact panel shape twice on the Jobs page, where
            Replace froze at 80px over a 287px dropzone.
            It sits ABOVE the document rather than beside it: a row tap scrolls
            the paper, and a panel below the paper would scroll itself off
            screen doing so. */}
        {onJumpToBlock && reviewOpen && (
          <Card className="animate-fade-up">
            <CardTitle>{t("doc.review.title")}</CardTitle>
            <div className="mt-3">
              <ReviewPanel
                resume={resume}
                data={review ?? null}
                stale={!!reviewStale}
                failed={!!reviewFailed}
                // Handed straight through, with nothing added on the way. The
                // caller does the view switch, the spotlight and the scroll in
                // ONE place, so a review row and every other jump on the page
                // land identically — and the view switch has to be theirs,
                // because `view` is their state and `scrollIntoView` on a
                // `display:none` node is a silent no-op.
                onJump={onJumpToBlock}
                onUseRewrite={onUseRewrite}
                rewrites={rewrites}
                rewritesDropped={rewritesDropped}
                rewritesBusy={rewritesBusy}
                rewritesFailed={rewritesFailed}
                onSuggestRewrites={suggestRewrites}
              />
            </div>
          </Card>
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
            {PDF_ONLY(template) && ` ${t("doc.screen.twoColumn")}`}
          </p>
        </div>

        {view === "file" && (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-ink-faint">{t("doc.file.note")}</p>
            {pdf.failed && !pdf.url ? (
              <p className="text-sm text-danger">{t("doc.file.failed")}</p>
            ) : !pdf.url ? (
              <Skeleton className="h-[70vh] w-full" />
            ) : (
              <>
                {/* An <iframe>, not <embed>: <embed> has no accessible name.
                    dir="ltr" because an RTL horizontal scroller starts at the
                    wrong end. Hidden below sm — mobile browsers will not render a
                    blob: PDF inline, and a blank rectangle on the one screen whose
                    job is "this is really your file" reads as our bug. */}
                <iframe
                  title={t("doc.views.file")}
                  dir="ltr"
                  src={`${pdf.url}#toolbar=0&navpanes=0&view=FitH`}
                  className={cn("hidden h-[70vh] w-full rounded-lg border border-line bg-white sm:block", pdf.loading && "opacity-60")}
                />
                <p className="text-sm text-ink-muted sm:hidden">{t("doc.file.mobile")}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    icon={<ExternalLink size={15} />}
                    onClick={() => window.open(pdf.url!, "_blank", "noopener")}
                    className="sm:hidden"
                  >
                    {t("doc.file.open")}
                  </Button>
                  <Button
                    variant="ghost"
                    icon={<Download size={15} />}
                    onClick={() => downloadResume(resume, "pdf", resumeFilename(resume.contact?.name ?? "", company), template)}
                  >
                    {t("doc.file.download")}
                  </Button>
                </div>
              </>
            )}
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
