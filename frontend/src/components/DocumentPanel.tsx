import { forwardRef } from "react";
import type { InsertKind } from "../lib/resumeBlocks";
import { useTranslation } from "react-i18next";
import { Download, ExternalLink, FileText, Monitor, ScanEye } from "lucide-react";
import ResumeView, { type BlockMark } from "./ResumeView";
import XrayResult from "./XrayResult";
import { usePdfPreview, useXray } from "../hooks/useFilePreview";
import { downloadResume, resumeFilename, type ResumeTemplate } from "../api/client";
import { Button, Skeleton } from "./ui";
import { cn } from "../lib/cn";
import type { ResumeModel } from "../types";

export type DocView = "screen" | "file" | "ats";
const VIEWS: DocView[] = ["screen", "file", "ats"];

const ICON = { screen: Monitor, file: FileText, ats: ScanEye } as const;

interface Props {
  resume: ResumeModel;
  template: ResumeTemplate;
  view: DocView;
  onView: (v: DocView) => void;
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
 * across six shipped dialogs, including the tracker's détail modal.
 *
 * The screen view stays MOUNTED (hidden) when another tab is active, because it
 * owns the block anchors the review panel jumps to — `scrollIntoView` on a
 * `display:none` node is a no-op.
 */
const DocumentPanel = forwardRef<HTMLDivElement, Props>(function DocumentPanel(
  { resume, template, view, onView, company = "", marks, activeBlock, activeNonce, onSelectBlock, onEditBlock, onInlineCommit, onAdd, onAddBullet },
  screenRef,
) {
  const { t } = useTranslation("tailor");
  const pdf = usePdfPreview(resume, template, view === "file");
  const xray = useXray(resume, template, view === "ats");

  return (
    <div className="space-y-3">
      {/* Scrolls itself: below 1024px the body is `overflow-x: clip`, so a row
          that can exceed the width has to own its own scroller. */}
      <div
        role="tablist"
        aria-label={t("doc.viewsLabel")}
        className="-mx-1 flex snap-x gap-1.5 overflow-x-auto px-1 pb-1"
      >
        {VIEWS.map((v) => {
          const Icon = ICON[v];
          const active = view === v;
          return (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onView(v)}
              className={cn(
                "inline-flex shrink-0 snap-start items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                active
                  ? "border-accent bg-accent text-white"
                  : "border-line bg-panel text-ink-muted hover:border-accent/40 hover:text-ink",
              )}
            >
              <Icon size={13} /> {t(`doc.views.${v}`)}
            </button>
          );
        })}
      </div>

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
  );
});

export default DocumentPanel;
