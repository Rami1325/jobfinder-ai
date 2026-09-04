import { useTranslation } from "react-i18next";
import { Crosshair, Sparkles } from "lucide-react";
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
 *
 * The alternative — gating on `findings.length > 0` — is the thing to avoid. A
 * document whose only findings are structural (a missing date, a placeholder
 * institution) has nothing a rewording can repair, so that button would spend a
 * capped model call to learn nothing, which is the failure `overlay.cached`
 * exists to prevent one surface over.
 */
const REWRITABLE = new Set(["weak-opener", "no-outcome", "bullet-long"]);

/** `bad` first, then `warn`, and STABLE inside each group.
 *
 * A stable partition, never a sort: the backend emits its findings in
 * `CHECK_IDS` order — contact, then the summary, then dates, then bullets,
 * i.e. roughly top-to-bottom down the page — and that order is information.
 * `Array.prototype.sort` is not required to be stable across engines for a
 * comparator that returns 0, and this repo has already paid once for reordering
 * a list somebody else had ranked (`skills_shortlist.order_skills` is a
 * partition for the same reason).
 */
function badFirst(findings: ReviewFinding[]): { bad: ReviewFinding[]; warn: ReviewFinding[] } {
  const bad: ReviewFinding[] = [];
  const warn: ReviewFinding[] = [];
  for (const f of findings) (f.severity === "bad" ? bad : warn).push(f);
  return { bad, warn };
}

/** One finding. A `<button>` when its block is really on the page, a plain row
 * when it is not — a document-level finding (`path === ""`) has nothing to
 * point at, and an anchored one whose path no longer resolves is listed and
 * left unmarked rather than given a tap that does nothing. `readBlock` is the
 * one resolver, so this cannot disagree with the paper about what exists.
 *
 * Module level, not nested in the panel: a component declared inside a render
 * is a new type on every render, so React unmounts and remounts its whole
 * subtree — which on this panel would tear down every row on each keystroke of
 * the 400 ms review debounce.
 */
function Row({
  f,
  resume,
  onJump,
}: {
  f: ReviewFinding;
  resume: ResumeModel;
  onJump: (path: string) => void;
}) {
  const { t } = useTranslation("tailor");
  const anchored = !!f.path && !!readBlock(resume, f.path);
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-ink">
          {t(`doc.review.checks.${f.id}.label`)}
        </span>
        {anchored && <Crosshair size={12} aria-hidden className="shrink-0 text-ink-faint" />}
      </div>
      {/* The offending text, VERBATIM. `<bdi>` and not a bare span: one list
          can hold a Hebrew bullet and a Latin skill, and without the isolate
          the first strong character of one row reorders the punctuation of the
          next. `dir="auto"` is right HERE — this is a quoted fragment whose own
          direction is the only one that describes it, which is the opposite of
          the paper, where the document's own language decides. */}
      {f.raw && (
        <p className="mt-0.5 truncate text-xs text-ink-muted">
          <bdi dir="auto">{f.raw}</bdi>
        </p>
      )}
      <p className="mt-1 text-xs leading-relaxed text-ink-faint">
        {t(`doc.review.checks.${f.id}.how`, f.args)}
      </p>
    </>
  );
  const shell = cn(
    "rounded-lg border p-2.5",
    f.severity === "bad" ? "border-danger/35 bg-danger/[0.06]" : "border-line bg-panel-2/40",
  );
  return anchored ? (
    <button
      type="button"
      onClick={() => onJump(f.path)}
      className={cn(
        shell,
        "block w-full text-start transition hover:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
      )}
    >
      {body}
    </button>
  ) : (
    <div className={shell}>{body}</div>
  );
}

interface Props {
  /** The document the findings were computed on — the SHOWN one (master, or the
   * tailored draft with its overrides), so a rewrite is asked for against the
   * same text the rows describe. */
  resume: ResumeModel;
  data: ReviewResult | null;
  /** A newer request is in flight. The last good findings stay on screen and
   * dim, because an emptied panel reads as "you fixed everything" — a lie told
   * mid-request. */
  stale: boolean;
  failed: boolean;
  /** Point the document at a block. Given the finding's own `path`; never
   * called with `""`. The implementation lives on the page (it has to switch
   * `docView` to "screen" first — `scrollIntoView` on a `display:none` node is
   * a silent no-op) and is threaded down rather than reached into. */
  onJump: (path: string) => void;
  /**
   * Commit a rewrite. ABSENT = the rewrites UI is not rendered at all.
   *
   * The page passes its OWN inline-commit function here, the same one the paper
   * commits a caret edit through, so "Use this" is not a second writer: it
   * routes to `applyBlockEdit` on the master and to `setBlockOverride` on a
   * tailored draft, by the one rule that already knows the difference. A
   * private write path here would be the 23.7 defect on purpose — a keystroke
   * through `applyBlockEdit` while a result is up nulls `result`,
   * `tailoredFrom` and `rejectedEdits` and destroys the whole review.
   */
  onUseRewrite?: (path: string, text: string) => void;
  /**
   * The suggestions, and their state, OWNED BY THE CALLER — because a spent
   * credit must survive a tap on the tool button.
   *
   * This panel is rendered conditionally (an inline Card, never a height
   * tween), so it unmounts every time the review is closed. Holding the
   * rewrites in local state meant closing the panel silently threw away a
   * result the user had just PAID for, and reopening it offered to spend a
   * second credit for the same three sentences. Panel-lifetime state belongs to
   * whoever outlives the panel.
   */
  rewrites: ReviewRewrite[] | null;
  rewritesDropped: number;
  rewritesBusy: boolean;
  rewritesFailed: boolean;
  onSuggestRewrites: () => void;
}

/**
 * What is wrong with the document on screen, and where.
 *
 * Every row points at a block. That is the whole design: the competitor
 * reference folder's own lesson is that a review which lists problems without
 * naming their location is a report, and a report gets read once. Tapping a row
 * lights the block up on the paper above.
 *
 * NO SCORE, and that is deliberate rather than an omission. A number invites
 * the user to optimise it, and these checks are advice about a document, not a
 * measurement of one — the two honest numbers on this surface (keyword
 * coverage, the measured page count) are already elsewhere and already say what
 * clock they are on.
 *
 * THREE LISTS, and the third is the point. `passed` ran and found nothing;
 * `skipped` COULD NOT run — no JD attached, fewer than two dated spans — and it
 * is printed as "couldn't check", never folded into the clean count. Unknown is
 * never clean, the same rule the tracker's nullable `voice_score` and the alert
 * bar's `last_above_min` follow.
 */
export default function ReviewPanel({
  resume,
  data,
  stale,
  failed,
  onJump,
  onUseRewrite,
  rewrites,
  rewritesDropped,
  rewritesBusy,
  rewritesFailed,
  onSuggestRewrites,
}: Props) {
  const { t } = useTranslation("tailor");

  if (failed && !data) return <p className="text-sm text-danger">{t("doc.review.failed")}</p>;
  // Nothing to paint yet. No skeleton: the panel is opened by a tap on a button
  // that already carries the count, so the numbers are known before the panel
  // is; a skeleton here would flash under a badge that is already correct.
  if (!data) return null;

  const { bad, warn } = badFirst(data.findings);
  const rewritable = !!onUseRewrite && data.findings.some((f) => REWRITABLE.has(f.id));

  /**
   * ONLY the suggestions whose `before` is STILL the bullet at that path.
   *
   * A block path is not a stable coordinate — this is the 23.7 lesson, and here
   * it has teeth in two directions at once. On a tailored draft a declined
   * removal splices an entry back and shifts every later index, so `@exp.1.b.0`
   * is one sentence before the toggle and a different one after it; on the
   * master, deleting an earlier bullet does the same thing. Either way a
   * suggestion drawn against the old document would write the model's sentence
   * onto a line the model never read, and "Use this" is a WRITE into the file
   * the user sends.
   *
   * The check is the one it should be: does the bullet at that path still say
   * exactly what the backend copied into `before`? The backend has already
   * proved `before` was verbatim at request time (a rewrite whose `before`
   * matches no bullet is dropped server-side), so a mismatch here means the
   * document moved underneath it. Refuse, rather than write the wrong line.
   *
   * It is also what retires a card once it has been used — the bullet then
   * reads `after` — and what discards every suggestion when the master résumé
   * is REPLACED under the panel. All three are the same question, so they get
   * one answer rather than three mechanisms that can disagree.
   *
   * `inlineField` and not a private lookup: it is derived from `readBlock`, the
   * one reader and writer of a block, so this cannot come to a different
   * conclusion from the caret that edits the same line.
   */
  const usable = (rewrites ?? []).filter(
    (r) => inlineField(resume, r.path)?.value.trim() === r.before.trim(),
  );

  return (
    // `stale` dims, never empties — see the Props note.
    <div className={cn("space-y-3", stale && "opacity-60")}>
      <p className="text-xs text-ink-muted">
        {t("doc.review.counts", {
          fix: bad.length,
          consider: warn.length,
          clean: data.passed.length,
        })}
      </p>

      {/* "every check ran clean" may only be said when every check RAN. With a
          skipped id in the result the sentence would be false, so the counts
          line plus the "couldn't check" line below stand on their own. */}
      {data.findings.length === 0 && data.skipped.length === 0 && (
        <p className="text-sm text-mint">{t("doc.review.empty")}</p>
      )}

      {bad.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-danger">
            {t("doc.review.groupBad")}
          </p>
          {bad.map((f, i) => (
            <Row key={`${f.id}-${f.path}-${i}`} f={f} resume={resume} onJump={onJump} />
          ))}
        </div>
      )}

      {warn.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            {t("doc.review.groupWarn")}
          </p>
          {warn.map((f, i) => (
            <Row key={`${f.id}-${f.path}-${i}`} f={f} resume={resume} onJump={onJump} />
          ))}
        </div>
      )}

      {/* THE ONE PART OF THIS PANEL THAT SPENDS. Everything above is
          deterministic Python on an uncapped route and re-runs on every
          keystroke; this is `Depends(llm_user)` and is therefore a button with
          its cost stated before it is pressed, in the shape the tailor
          overlay's own `overlay.cost` line uses. */}
      {rewritable && (
        <div className="space-y-2 rounded-lg border border-line p-2.5">
          <p className="text-xs leading-relaxed text-ink-faint">
            {t("doc.review.rewritesCost", {
              defaultValue:
                "Suggesting rewrites uses one AI credit. Everything else on this panel is measured on your device's request and costs nothing.",
            })}
          </p>
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

          {rewritesFailed && <p className="text-sm text-danger">{t("doc.review.failed")}</p>}

          {/* REPORTED, never swallowed. A guard that fires silently is the 21.7
              failure mode, and "we asked for five and are showing you two" is a
              fact the user can act on. */}
          {rewritesDropped > 0 && (
            <p className="text-xs text-warn">
              {t("doc.review.rewriteDropped", { n: rewritesDropped })}
            </p>
          )}

          {usable.map((r, i) => (
            // Index in the key as well as the path: nothing stops the backend
            // returning two suggestions for one bullet, and a duplicate React
            // key drops one of them silently.
            <div key={`${r.path}-${i}`} className="space-y-1 rounded-lg border border-line bg-panel-2/40 p-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                {t("doc.review.rewriteBefore")}
              </p>
              <p className="text-xs text-ink-muted">
                <bdi dir="auto">{r.before}</bdi>
              </p>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-accent-soft">
                {t("doc.review.rewriteAfter")}
              </p>
              <p className="text-xs text-ink">
                <bdi dir="auto">{r.after}</bdi>
              </p>
              <Button
                size="sm"
                variant="ghost"
                // ONE write path, the page's own — see the Props note. The card
                // retires itself: the commit changes the document, `usable`
                // re-filters against it, and this suggestion's `before` is no
                // longer what that bullet says.
                onClick={() => onUseRewrite?.(r.path, r.after)}
              >
                {t("doc.review.useThis")}
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* `passed` is ONE line, never a list of green rows: a check that found
          nothing is not news, and twenty of them would bury the rows that are.
          The count is what makes the panel's silence readable. */}
      {data.passed.length > 0 && (
        <p className="text-xs text-mint">{t("doc.review.passed", { n: data.passed.length })}</p>
      )}

      {/* SKIPPED IS NOT CLEAN. Named one by one, because "we could not check
          your dates" and "we could not check this against a job" are different
          facts and only one of them is fixable by attaching a posting. The
          note underneath says out loud that these are not counted as clean —
          without it the reader folds them into the passed count themselves. */}
      {data.skipped.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-xs text-warn">
            {t("doc.review.skipped", {
              list: data.skipped.map((id) => t(`doc.review.checks.${id}.label`)).join(", "),
            })}
          </p>
          <p className="text-[11px] text-ink-faint">{t("doc.review.skippedNote")}</p>
        </div>
      )}
    </div>
  );
}

/** The count the TOOL BUTTON carries — the number of things to FIX.
 *
 * Exported from here rather than recomputed at the button, so the badge and the
 * "To fix" group can never disagree about the same document. `bad` only: a
 * badge that counted every finding would put "17" on a control whose panel
 * opens on three actual problems, and a count nobody believes is a count
 * nobody reads.
 */
export function badCount(data: ReviewResult | null): number {
  return data ? data.findings.filter((f) => f.severity === "bad").length : 0;
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
