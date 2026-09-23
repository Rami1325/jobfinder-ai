import { useMemo, useState } from "react";
import { Check, Minus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GapItem } from "../types";
import { Card, CardTitle, CountUp, SectionLabel } from "./ui";
import { cn } from "../lib/cn";
import { countOccurrences, keywordRegex } from "../lib/keywords";

interface Props {
  gaps: GapItem[];
  jdText: string;
  /** Without the card and its title (PLAN 31.3/3): the tailored draft's drawer
   * gives the keyword list a section heading of its own. */
  bare?: boolean;
}

const groupMeta = {
  missing: { icon: <X size={12} />, labelKey: "report.missing" },
  partial: { icon: <Minus size={12} />, labelKey: "report.partial" },
  covered: { icon: <Check size={12} />, labelKey: "report.matched" },
} as const;

const chipTone: Record<string, string> = {
  covered: "border-mint/50 bg-mint/15 text-mint",
  partial: "border-warn/50 bg-warn/15 text-warn",
  missing: "border-danger/50 bg-danger/12 text-danger",
};

/** Split text into plain/<mark> nodes around every occurrence of the keyword. */
function highlightNodes(text: string, keyword: string): (string | JSX.Element)[] {
  const re = keywordRegex(keyword);
  if (!re) return [text];
  const nodes: (string | JSX.Element)[] = [];
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(
      <mark key={i++} className="rounded bg-accent/30 px-0.5 font-semibold text-ink">
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  nodes.push(text.slice(last));
  return nodes;
}

/**
 * Keyword report: matched / partial / missing chips, each with how often the
 * POSTING mentions the term; clicking a chip highlights it inside the job
 * description text.
 *
 * There is deliberately no resume-side count. The chip's status is the
 * backend's answer, and `_keyword_present` tries the verbatim phrase first —
 * so a second count computed here could disagree with the word printed beside
 * it, which is exactly how a chip in the green "Matched" group came to read
 * "משרה 2 · אתם 0". The JD count survives because it is about the posting the
 * user is looking at and can click to verify; a count about the resume is a
 * claim, and claims about the resume are the server's to make.
 */
export default function MatchReport({ gaps, jdText, bare = false }: Props) {
  const { t } = useTranslation("tailor");
  const [selected, setSelected] = useState<string | null>(null);

  const rows = useMemo(
    () => gaps.map((g) => ({ ...g, jdCount: countOccurrences(g.keyword, jdText) })),
    [gaps, jdText],
  );

  if (!gaps.length) return null;
  const missing = gaps.filter((g) => g.status === "missing").length;
  const selectedRow = rows.find((r) => r.keyword === selected) ?? null;

  // Numbers are alive (A5): count the summary metrics up when the report
  // lands. Sentinels are interpolated into the translated string and swapped
  // for CountUps, so translations keep full control of the word order.
  const summaryParts = t("report.summary", { missing: "@@missing@@", total: "@@total@@" }).split(
    /(@@missing@@|@@total@@)/,
  );

  const Shell = bare ? "div" : Card;
  return (
    <Shell>
      {!bare && <CardTitle>{t("report.title")}</CardTitle>}
      <p className={bare ? "text-sm text-ink-muted" : "mt-1 text-sm text-ink-muted"}>
        {summaryParts.map((part, i) =>
          part === "@@missing@@" ? (
            <CountUp key={i} to={missing} duration={0.8} className="tabular-nums" />
          ) : part === "@@total@@" ? (
            <CountUp key={i} to={gaps.length} duration={0.8} className="tabular-nums" />
          ) : (
            part
          ),
        )}
      </p>
      <p className="mt-1 text-xs text-ink-faint">{t("report.clickHint")}</p>

      <div className="mt-4 space-y-4">
        {(Object.keys(groupMeta) as (keyof typeof groupMeta)[]).map((status) => {
          const group = rows.filter((r) => r.status === status);
          if (!group.length) return null;
          return (
            <div key={status}>
              <SectionLabel className="mb-2">
                {t(groupMeta[status].labelKey, { count: group.length })}
              </SectionLabel>
              <div className="flex flex-wrap gap-2">
                {group.map((r) => {
                  const isSelected = selected === r.keyword;
                  return (
                    <button
                      key={r.keyword}
                      type="button"
                      aria-pressed={isSelected}
                      title={r.suggestion || undefined}
                      onClick={() => setSelected(isSelected ? null : r.keyword)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition",
                        chipTone[r.status],
                        isSelected ? "ring-2 ring-accent/60" : "hover:brightness-110",
                      )}
                    >
                      {groupMeta[status].icon}
                      <span>{r.keyword}</span>
                      <span className="border-s border-current ps-1.5 font-normal tabular-nums opacity-70">
                        {t("report.counts", { jd: r.jdCount })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <>
        {selectedRow && (
          <div key={selectedRow.keyword} className="animate-fade-up">
            <div className="mt-4 rounded-lg border border-line bg-bg-soft">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2">
                <span className="text-sm font-semibold text-ink">
                  {t("report.inJd", { keyword: selectedRow.keyword })}
                </span>
                <span className="text-xs text-ink-muted">
                  {selectedRow.jdCount > 0
                    ? t("report.mentions", { count: selectedRow.jdCount })
                    : t("report.notInJdText")}
                </span>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="ms-auto text-xs text-accent-soft hover:underline"
                >
                  {t("report.close")}
                </button>
              </div>
              <div dir="auto" className="max-h-72 overflow-y-auto whitespace-pre-wrap px-3 py-2 text-sm leading-relaxed text-ink-muted">
                {highlightNodes(jdText, selectedRow.keyword)}
              </div>
            </div>
          </div>
        )}
      </>
    </Shell>
  );
}
