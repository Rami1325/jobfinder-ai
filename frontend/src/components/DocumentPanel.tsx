import { forwardRef, useState } from "react";
import type { InsertKind } from "../lib/resumeBlocks";
import { useTranslation } from "react-i18next";
import {
  Download,
  ExternalLink,
  FileText,
  LayoutTemplate,
  Monitor,
  ScanEye,
  type LucideIcon,
} from "lucide-react";
import ResumeView, { type BlockMark } from "./ResumeView";
import TemplatePicker from "./TemplatePicker";
import XrayResult from "./XrayResult";
import { usePdfPreview, useXray } from "../hooks/useFilePreview";
import { downloadResume, resumeFilename, type ResumeTemplate } from "../api/client";
import { Button, Card, Skeleton } from "./ui";
import { cn } from "../lib/cn";
import type { ResumeModel } from "../types";

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
  return (
    <button
      type="button"
      title={tool.label}
      aria-label={labelled ? undefined : tool.label}
      aria-pressed={tool.active}
      onClick={tool.onClick}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        labelled ? "snap-start px-3 py-1.5" : "h-10 w-10",
        tool.active
          ? "border-accent bg-accent text-white"
          : "border-line bg-panel text-ink-muted hover:border-accent/40 hover:text-ink",
      )}
    >
      <Icon size={labelled ? 13 : 16} aria-hidden />
      {labelled && tool.label}
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
  activeBlock?: string | null;
  /** Passed straight through to ResumeView — see its own doc comment. */
  activeNonce?: number;
  onSelectBlock?: (path: string) => void;
  /** Tap a block to edit it. Passed only when the document is the MASTER —
   * a tailored draft is a review surface, not an editing one. */
  onEditBlock?: (path: string) => void;
  onInlineCommit?: (path: string, text: string) => void;
  onAddSkill?: (groupLabel: string, text: string) => void;
  onAdd?: (kind: InsertKind) => void;
  onAddBullet?: (entryPath: string) => void;
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
  { resume, template, view, onView, onTemplate, company = "", marks, activeBlock, activeNonce, onSelectBlock, onEditBlock, onInlineCommit, onAddSkill, onAdd, onAddBullet },
  screenRef,
) {
  const { t } = useTranslation("tailor");
  const pdf = usePdfPreview(resume, template, view === "file");
  const xray = useXray(resume, template, view === "ats");
  const [tplOpen, setTplOpen] = useState(false);

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
    {
      key: "download",
      Icon: Download,
      label: t("download.pdf"),
      onClick: () =>
        downloadResume(resume, "pdf", resumeFilename(resume.contact?.name ?? "", company), template),
    },
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

        {/* Always mounted — it carries the block anchors the review panel jumps to. */}
        <div ref={screenRef} className={cn(view !== "screen" && "hidden")}>
          <ResumeView
            resume={resume}
            surface="sheet"
            marks={marks}
            activeBlock={activeBlock}
            activeNonce={activeNonce}
            onSelectBlock={onSelectBlock}
            onEditBlock={onEditBlock}
            onInlineCommit={onInlineCommit}
            onAddSkill={onAddSkill}
            onAdd={onAdd}
            onAddBullet={onAddBullet}
          />
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
