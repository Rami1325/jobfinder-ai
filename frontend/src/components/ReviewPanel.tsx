import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Crosshair, Info, Sparkles } from "lucide-react";
import { inlineField, readBlock } from "../lib/resumeBlocks";
import { Button } from "./ui";
import { cn } from "../lib/cn";
import type { ResumeModel, ReviewFinding, ReviewResult, ReviewRewrite } from "../types";

/**
 * THE THREE IDS `POST /tools/review/rewrites` WILL ACT ON — a MIRROR of
 * `resume_review.REWRITABLE`, and it exists for exactly one job: deciding
 * whether the "Suggest rewrites" button is on screen at all.
 *
 * It deliberately does NOT decide WHICH bullets are sent. The request goes out
 * with `paths: []`, which the contract defines as "pick the rewritable findings
 * server-side", so the selection has one author and this list cannot make the
 * app ask for a bullet the backend would then refuse. Drift is therefore
 * cosmetic in both directions and can never corrupt a document: a list that is
 * too narrow hides a button the backend would have served, and one that is too
 * wide offers a button that comes back with `rewrites: []`.
 */
const REWRITABLE = new Set(["weak-opener", "no-outcome", "bullet-long"]);

/** One CHECK, with every finding it produced folded into it.
 *
 * The row is per CHECK rather than per FINDING, and that is the whole reason
 * this panel is readable. A first-draft CV produces five "no measured result"
 * findings and five identical rows saying the same sentence five times; the
 * check is also the unit that actually CLEARS — fixing one of five bullets
 * leaves the check failing — so a per-finding row implies a progress the
 * document has not made.
 */
export interface CheckRow {
  id: string;
  severity: "bad" | "warn";
  paths: string[]; // every block this check flagged, in document order
  raw: string; // the FIRST offending snippet, as the row's collapsed evidence
  /** EVERY finding this row stands for, not just the first.
   *
   * The row collapses N findings into one line, but five of the how-texts
   * interpolate a value that belongs to ONE of them — `dates-format` names the
   * rewrite (`{{suggested}}`), `gap` the month count, `repeated-verb` the verb,
   * `acronym` the pair. Carrying only the first finding's `args` made the
   * explanation state a fact about one occurrence as though it covered all of
   * them: on the owner's own CV the `acronym` row reads "×3" and its how-text
   * named only `machine learning (ML)`, silently dropping CI/CD.
   *
   * So the row keeps them all and the explanation renders the DISTINCT
   * sentences. Identical ones collapse — five "no measured result" findings
   * produce one line, not five. */
  items: { path: string; args: Record<string, string | number> }[];
  count: number;
}

/** `bad` first, then `warn`, and STABLE inside each group.
 *
 * A stable partition, never a sort: the backend emits its findings in
 * `CHECK_IDS` order — contact, then the summary, then dates, then bullets, i.e.
 * roughly top-to-bottom down the page — and that order is information.
 * `Array.prototype.sort` is not required to be stable across engines for a
 * comparator that returns 0, and this repo has already paid once for reordering
 * a list somebody else had ranked.
 */
export function groupChecks(findings: ReviewFinding[]): CheckRow[] {
  const by = new Map<string, CheckRow>();
  for (const f of findings) {
    const row = by.get(f.id);
    if (!row) {
      by.set(f.id, {
        id: f.id,
        severity: f.severity === "bad" ? "bad" : "warn",
        paths: f.path ? [f.path] : [],
        raw: f.raw,
        items: [{ path: f.path, args: f.args }],
        count: 1,
      });
      continue;
    }
    row.count += 1;
    if (f.path) row.paths.push(f.path);
    row.items.push({ path: f.path, args: f.args });
    // `bad` outranks `warn` if one check ever emits both, so the row describes
    // the worst thing it found rather than whichever finding happened to land
    // first.
    if (f.severity === "bad") row.severity = "bad";
  }
  const rows = [...by.values()];
  return [...rows.filter((r) => r.severity === "bad"), ...rows.filter((r) => r.severity !== "bad")];
}

/**
 * How much of this résumé is clean, as a share of the checks that RAN.
 *
 * **This repo spent Phase 28 refusing to put a number here, and the number is
 * back because the owner asked for one.** The old rule — "no scores, counts and
 * evidence", because a count is checkable and a band is not — is honoured in
 * the only way that survives: this percentage is ARITHMETIC over deterministic
 * checks, not a graded opinion. `clean / ran`, where every term is a count the
 * panel also shows. Nothing here is modelled, weighted or tuned, so the reader
 * can verify it by counting the rows.
 *
 * `skipped` is EXCLUDED from the denominator, which is the honest half. A check
 * that could not run is unknown, and folding unknowns into the denominator
 * would let a résumé's score fall for a reason it cannot act on (no job
 * attached), while folding them into the numerator would report unknown as
 * clean — the defect `ReviewResult` exists to avoid.
 *
 * The "after" figure is deliberately NOT a prediction. Clearing every listed
 * check leaves every check that ran passing, so it is 100 by construction, and
 * it is labelled as a ceiling ("up to") rather than a promise: fixing one thing
 * can introduce another — measured, a lengthened bullet trips `bullet-long` —
 * and this panel must not claim otherwise.
 */
export function reviewScore(data: ReviewResult | null): {
  clean: number;
  ran: number;
  pct: number;
  each: number;
} {
  const failed = new Set((data?.findings ?? []).map((f) => f.id)).size;
  const clean = data?.passed.length ?? 0;
  const ran = clean + failed;
  return {
    clean,
    ran,
    pct: ran > 0 ? Math.round((clean / ran) * 100) : 0,
    // What clearing ONE check is worth, for the per-row badge. Rounded for
    // display only; the row badges are a guide to which fix buys the most, and
    // are never summed against the headline.
    each: ran > 0 ? Math.round(100 / ran) : 0,
  };
}

/** One check. A `<button>` when at least one of its blocks is really on the
 * page, a plain row when none is — a document-level finding (`path === ""`) has
 * nothing to point at, and an anchored one whose path no longer resolves is
 * listed and left unmarked rather than given a tap that does nothing.
 * `readBlock` is the one resolver, so this cannot disagree with the paper.
 *
 * Module level, not nested in the panel: a component declared inside a render
 * is a new type on every render, so React unmounts and remounts its whole
 * subtree — which on this panel would tear down every row on each keystroke of
 * the 400 ms review debounce, and would drop the open `!` explanation with it.
 */
function Row({
  row,
  resume,
  each,
  onJump,
  onHover,
}: {
  row: CheckRow;
  resume: ResumeModel;
  each: number;
  onJump?: (path: string) => void;
  onHover?: (paths: string[] | null) => void;
}) {
  const { t } = useTranslation("tailor");
  const [why, setWhy] = useState(false);
  const live = row.paths.filter((p) => !!readBlock(resume, p));
  const anchored = live.length > 0;

  return (
    <li
      className={cn(
        "rounded-lg border px-2.5 py-2",
        row.severity === "bad" ? "border-danger/30 bg-danger/[0.05]" : "border-line bg-panel-2/30",
      )}
      // HOVER HIGHLIGHTS, IT DOES NOT MOVE ANYTHING. The sheet rule stands:
      // nothing on the paper animates on hover — the highlight is a flat tint
      // with no transition, no scale and no scroll, so the document is marked
      // without the artefact behaving like a toy. A tap still scrolls and
      // spotlights, which is the only path a phone has.
      onMouseEnter={() => anchored && onHover?.(live)}
      onMouseLeave={() => onHover?.(null)}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            row.severity === "bad" ? "bg-danger" : "bg-warn",
          )}
        />
        {/* The LABEL alone. The how-text used to sit under every row and it is
            what made this panel a wall of prose — it moved behind the `!`. */}
        <span className="min-w-0 flex-1 truncate text-sm text-ink">
          {t(`doc.review.checks.${row.id}.label`)}
        </span>
        {row.count > 1 && (
          <span className="shrink-0 text-xs tabular-nums text-ink-faint">×{row.count}</span>
        )}
        <span className="shrink-0 text-xs tabular-nums text-mint">+{each}%</span>
        <button
          type="button"
          aria-expanded={why}
          aria-label={t("doc.review.why")}
          onClick={() => setWhy((w) => !w)}
          className={cn(
            "grid h-5 w-5 shrink-0 place-items-center rounded-full border text-ink-faint",
            why ? "border-accent/50 text-accent-soft" : "border-line",
          )}
        >
          <Info size={11} />
        </button>
        {anchored && (
          <button
            type="button"
            aria-label={t("doc.review.showInDoc")}
            onClick={() => onJump?.(live[0])}
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-line text-ink-faint"
          >
            <Crosshair size={11} />
          </button>
        )}
      </div>

      {/* The evidence, one line, clipped. `<bdi dir="auto">` because one list
          can hold a Hebrew bullet and a Latin skill, and a bare span lets the
          first strong character of one row reorder the punctuation of the next. */}
      {row.raw && (
        <p className="mt-1 truncate text-xs text-ink-muted">
          <bdi dir="auto">{row.raw}</bdi>
        </p>
      )}

      {/* Opened only on demand — this is the text the owner asked to stop
          taking up space. ONE LINE PER DISTINCT SENTENCE, not per finding: the
          how-text carries the finding's own `args`, so a row standing for three
          unpaired acronyms has three different sentences to give, while five
          bullets with no measured result all produce the same one and it is
          said once. */}
      {why && (
        <div className="mt-1.5 space-y-1">
          {[
            ...new Map(
              row.items.map((it) => [
                t(`doc.review.checks.${row.id}.how`, it.args),
                it,
              ]),
            ).keys(),
          ].map((line) => (
            <p key={line} className="text-xs leading-relaxed text-ink-faint">
              {line}
            </p>
          ))}
        </div>
      )}
    </li>
  );
}

interface Props {
  resume: ResumeModel;
  data: ReviewResult | null;
  stale: boolean;
  failed: boolean;
  onJump?: (path: string) => void;
  onHover?: (paths: string[] | null) => void;
  onUseRewrite?: (path: string, after: string) => void;
  rewrites?: ReviewRewrite[];
  rewritesDropped?: number;
  rewritesBusy?: boolean;
  rewritesFailed?: boolean;
  onSuggestRewrites?: () => void;
}

export default function ReviewPanel({
  resume,
  data,
  stale,
  failed,
  onJump,
  onHover,
  onUseRewrite,
  rewrites,
  rewritesDropped = 0,
  rewritesBusy,
  rewritesFailed,
  onSuggestRewrites,
}: Props) {
  const { t } = useTranslation("tailor");

  if (failed && !data) return <p className="text-sm text-danger">{t("doc.review.failed")}</p>;
  if (!data) return null;

  const rows = groupChecks(data.findings);
  const score = reviewScore(data);
  const bad = rows.filter((r) => r.severity === "bad").length;
  const warn = rows.length - bad;
  const rewritable = !!onUseRewrite && data.findings.some((f) => REWRITABLE.has(f.id));

  /**
   * ONLY the suggestions whose `before` is STILL the bullet at that path.
   *
   * A block path is not a stable coordinate — the 23.7 lesson, with teeth in
   * two directions: on a tailored draft a declined removal splices an entry
   * back and shifts every later index, and on the master, deleting an earlier
   * bullet does the same. Either way a suggestion drawn against the old
   * document would write the model's sentence onto a line the model never read,
   * and "Use this" is a WRITE into the file the user sends.
   */
  const usable = (rewrites ?? []).filter(
    (r) => inlineField(resume, r.path)?.value.trim() === r.before.trim(),
  );

  return (
    // `stale` dims, never empties: an emptied panel reads as "you fixed
    // everything", which is a lie told mid-request.
    <div className={cn("space-y-3", stale && "opacity-60")}>
      {/* THE HEADLINE NUMBER. `now → up to`, with the counts underneath that
          make it checkable — the reader can add the rows up. */}
      {/* NO PERCENTAGE WHEN NOTHING RAN. On a document where every check is
          skipped the arithmetic gives 0, and "0%" over a résumé reads as a
          verdict on it — when what actually happened is that we could not look.
          Unknown is never clean, and it is never zero either: the panel says
          what it could not check and shows no number at all. */}
      <div className="space-y-1.5">
        <div className="flex items-baseline gap-2">
          {score.ran === 0 ? (
            <span className="text-sm text-ink-muted">{t("doc.review.nothingRan")}</span>
          ) : (
            <span className="text-2xl font-semibold tabular-nums text-ink">{score.pct}%</span>
          )}
          {rows.length > 0 && score.ran > 0 && (
            <>
              <span aria-hidden className="text-ink-faint">
                →
              </span>
              <span className="text-sm tabular-nums text-mint">
                {t("doc.review.upTo", { pct: 100 })}
              </span>
            </>
          )}
        </div>
        {/* A bar, not a ring: it is a share of a whole, and it must not animate
            its own width on every keystroke of the debounce. */}
        {score.ran > 0 && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-line">
          <div
            className={cn("h-full rounded-full", bad > 0 ? "bg-danger/70" : "bg-mint/70")}
            style={{ inlineSize: `${score.pct}%` }}
          />
        </div>
        )}
        <p className="text-xs text-ink-muted">
          {t("doc.review.counts", { fix: bad, consider: warn, clean: score.clean })}
        </p>
      </div>

      {data.findings.length === 0 && data.skipped.length === 0 && (
        <p className="text-sm text-mint">{t("doc.review.empty")}</p>
      )}

      {rows.length > 0 && (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <Row
              key={r.id}
              row={r}
              resume={resume}
              each={score.each}
              onJump={onJump}
              onHover={onHover}
            />
          ))}
        </ul>
      )}

      {/* THE ONE PART OF THIS PANEL THAT SPENDS. Everything above is
          deterministic Python on an uncapped route and re-runs on every
          keystroke; this is `Depends(llm_user)` and is therefore a button with
          its cost stated before it is pressed. */}
      {rewritable && (
        <div className="space-y-2 rounded-lg border border-line p-2.5">
          <Button
            size="sm"
            variant="secondary"
            icon={<Sparkles size={14} />}
            loading={rewritesBusy}
            disabled={rewritesBusy}
            onClick={onSuggestRewrites}
          >
            {t("doc.review.rewrites")}
          </Button>
          <p className="text-[11px] leading-relaxed text-ink-faint">
            {t("doc.review.rewritesCost")}
          </p>

          {rewritesFailed && <p className="text-sm text-danger">{t("doc.review.failed")}</p>}

          {/* REPORTED, never swallowed. A guard that fires silently is the 21.7
              failure mode. */}
          {rewritesDropped > 0 && (
            <p className="text-xs text-warn">
              {t("doc.review.rewriteDropped", { n: rewritesDropped })}
            </p>
          )}

          {usable.map((r, i) => (
            <div
              key={`${r.path}-${i}`}
              className="space-y-1 rounded-lg border border-line bg-panel-2/40 p-2"
            >
              <p className="text-xs text-ink-muted line-through decoration-ink-faint/50">
                <bdi dir="auto">{r.before}</bdi>
              </p>
              <p className="text-xs text-ink">
                <bdi dir="auto">{r.after}</bdi>
              </p>
              <Button size="sm" variant="ghost" onClick={() => onUseRewrite?.(r.path, r.after)}>
                {t("doc.review.useThis")}
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* SKIPPED IS NOT CLEAN, and it is the one thing here that still needs a
          sentence: "we could not check your dates" and "we could not check this
          against a job" are different facts and only one is fixable by
          attaching a posting. */}
      {data.skipped.length > 0 && (
        <p className="text-[11px] leading-relaxed text-ink-faint">
          {t("doc.review.skipped", {
            list: data.skipped.map((id) => t(`doc.review.checks.${id}.label`)).join(", "),
          })}
        </p>
      )}
    </div>
  );
}

/** The count the TOOL BUTTON carries — the number of things to FIX.
 *
 * Exported from here rather than recomputed at the button, so the badge and the
 * "To fix" rows can never disagree about the same document. It counts CHECKS,
 * not findings, matching the rows the panel now draws: a badge reading "17"
 * over a panel showing three rows is a count nobody believes.
 */
export function badCount(data: ReviewResult | null): number {
  if (!data) return 0;
  return new Set(data.findings.filter((f) => f.severity === "bad").map((f) => f.id)).size;
}

/** Block path → severity, for the dots on the paper.
 *
 * A Map holds ONE value per path and a block can carry two findings, so `bad`
 * outranks `warn` — the dot has to describe the worst thing on that line, or a
 * missing date hides behind a long bullet. Findings with no path (or a path the
 * document does not resolve) simply never match a rendered `data-block`, which
 * is the "listed, unmarked" behaviour the contract asks for, with no second
 * resolver to keep in step.
 *
 * SEPARATE from `ResumeView`'s `marks` on purpose: that Map is the tailor's
 * changed/restored/yours vocabulary, and one Map cannot hold both answers for
 * one path without one of them silently winning.
 */
export function flagsOf(data: ReviewResult | null): Map<string, "bad" | "warn"> {
  const out = new Map<string, "bad" | "warn">();
  for (const f of data?.findings ?? []) {
    if (!f.path) continue;
    if (f.severity === "bad") out.set(f.path, "bad");
    else if (!out.has(f.path)) out.set(f.path, "warn");
  }
  return out;
}
