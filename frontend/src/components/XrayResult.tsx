import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, WrapText, FileWarning } from "lucide-react";
import { isPdfOnlyTemplate } from "./TemplatePicker";
import type { ResumeTemplate } from "../api/client";
import { Badge, Card, CardTitle } from "./ui";
import { cn } from "../lib/cn";
import type { ATSXrayFact, ATSXrayResult } from "../types";

/** Statuses in the order a reader cares about them: problems first. */
const ORDER: ATSXrayFact["status"][] = ["missing", "polluted", "split", "clean"];

const STATUS = {
  clean: { icon: CheckCircle2, cls: "text-mint", tone: "covered" },
  split: { icon: WrapText, cls: "text-ink-muted", tone: "partial" },
  polluted: { icon: AlertTriangle, cls: "text-warn", tone: "partial" },
  missing: { icon: FileWarning, cls: "text-danger", tone: "missing" },
} as const;

interface Props {
  result: ATSXrayResult;
  /** The template the file was rendered from. Needed separately because the
   * payload's own `docx_fallback` is only set on a DOCX x-ray, so the "your
   * Word file is a different document" sentence has to come from the caller. */
  template: ResumeTemplate;
  /** `card` on the standalone tool page; `plain` inside the tailor panel, where
   * a Card inside a Card reads as panel-on-panel. */
  surface?: "card" | "plain";
  showLegend?: boolean;
  className?: string;
}

/**
 * What the parser recovered from the rendered file.
 *
 * Shared by the standalone tool page and the tailor document panel ON PURPOSE:
 * every honesty correction below has to land in both, and two surfaces
 * describing the same payload differently is the failure mode this component
 * exists to make impossible.
 *
 * Deliberately NO score, ring or percentage. A flawless single-column résumé
 * reports a fifth of its facts `split` — that is what line wrapping IS — so any
 * ratio would read as damage on a perfect document. And `facts` is not a count
 * of distinct facts: two roles with the same title produce two entries pointing
 * at one line.
 */
export default function XrayResult({
  result,
  template,
  surface = "card",
  showLegend = true,
  className,
}: Props) {
  const { t } = useTranslation("tools");
  const problems = result.facts.filter((f) => f.status === "polluted" || f.status === "missing");
  const Box = surface === "card" ? Card : PlainBox;
  const empty = result.facts.length === 0;

  return (
    <div className={cn("space-y-4", className)}>
      <Box>
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
          {(["clean", "split", "polluted", "missing"] as const).map((k) => (
            <span key={k} className="flex items-baseline gap-1.5">
              <span
                className={cn(
                  "text-2xl font-bold tabular-nums",
                  k === "missing" && result.missing > 0 && "text-danger",
                  k === "polluted" && result.polluted > 0 && "text-warn",
                  k === "clean" && "text-mint",
                )}
              >
                {result[k]}
              </span>
              <span className="text-sm text-ink-muted">{t(`xray.count.${k}`)}</span>
            </span>
          ))}
        </div>

        <div className="mt-3 space-y-1.5 text-sm text-ink-muted">
          {empty ? (
            <p>{t("xray.empty")}</p>
          ) : (
            <>
              <p>
                {result.docx_fallback
                  ? t("xray.verdict.fallback", { template: result.docx_fallback })
                  : result.polluted > 0
                    ? t("xray.verdict.polluted")
                    : t("xray.verdict.clean")}
              </p>
              {/* Wrapping is not damage, and a count with no explanation reads
                  as one. Said before the problem list, not after. */}
              {result.split > 0 && <p>{t("xray.splitNormal", { count: result.split })}</p>}
              {result.two_column ? (
                result.missing > 0 && <p className="text-warn">{t("xray.verdict.shredded")}</p>
              ) : (
                <p>{t("xray.verdict.single")}</p>
              )}
              <p>{t("xray.pagesNote", { count: result.pages })}</p>
              {/* The lie by omission this view would otherwise tell: for a
                  two-column template the .docx is a different document, and we
                  x-rayed the PDF. */}
              {result.fmt === "pdf" && isPdfOnlyTemplate(template) && (
                <p className="text-warn">
                  {t("xray.docxDiffers", {
                    name: t(`download.templates.${template}.name`, { ns: "tailor", defaultValue: template }),
                  })}
                </p>
              )}
            </>
          )}
        </div>
      </Box>

      {problems.length > 0 && (
        <Box>
          <CardTitle>{t("xray.problemsTitle")}</CardTitle>
          <ul className="mt-3 space-y-3">
            {problems.map((f, i) => {
              const S = STATUS[f.status];
              return (
                <li key={i} className="flex items-start gap-2.5 text-sm">
                  <S.icon size={16} className={cn("mt-0.5 shrink-0", S.cls)} />
                  <div className="min-w-0">
                    <p className="text-ink">
                      <span className="font-semibold">{t(`xray.kind.${f.kind}`, { defaultValue: f.kind })}</span>
                      <span className="text-ink-muted"> — “{f.value}”</span>
                    </p>
                    {f.status === "polluted" && (
                      <p className="mt-0.5 text-xs text-warn">{t("xray.collided", { value: f.collided_with })}</p>
                    )}
                    {f.line && (
                      <p
                        className="mt-1 truncate rounded bg-bg-soft px-2 py-1 font-mono text-xs text-ink-muted"
                        dir="auto"
                      >
                        {f.line}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Box>
      )}

      <Box>
        <CardTitle>{t("xray.textTitle")}</CardTitle>
        <p className="mt-1 text-sm text-ink-muted">{t("xray.textHint")}</p>
        {/* Verbatim, monospaced, and horizontally scrollable in its own box —
            this is evidence, so it is never reflowed or prettified. */}
        <pre
          dir="auto"
          className="mt-3 max-h-[26rem] overflow-auto rounded-xl border border-line bg-bg-soft p-3 font-mono text-xs leading-relaxed text-ink-muted"
        >
          {result.text}
        </pre>
        {/* What this does and does not prove, printed rather than assumed. */}
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">{t("xray.limits")}</p>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">{t("xray.scope")}</p>
      </Box>

      {showLegend && (
        <Box>
          <CardTitle>{t("xray.legendTitle")}</CardTitle>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {ORDER.map((k) => {
              const S = STATUS[k];
              return (
                <p key={k} className="flex items-start gap-2 text-sm text-ink-muted">
                  <S.icon size={15} className={cn("mt-0.5 shrink-0", S.cls)} />
                  <span>
                    <Badge tone={S.tone as "covered" | "partial" | "missing"}>{t(`xray.count.${k}`)}</Badge>{" "}
                    {t(`xray.legend.${k}`)}
                  </span>
                </p>
              );
            })}
          </div>
        </Box>
      )}
    </div>
  );
}

/** A Card's content without a Card's chrome — for hosts that are already a panel. */
function PlainBox({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-line bg-bg-soft/50 p-4">{children}</div>;
}
