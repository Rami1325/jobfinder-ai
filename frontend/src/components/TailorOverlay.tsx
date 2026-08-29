import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Wand2 } from "lucide-react";
import JDPaste from "./JDPaste";
import { checkFit } from "../api/client";
import { apiErrorMessage } from "../lib/apiError";
import { Badge, Button, Modal, ProgressRing } from "./ui";
import type { FitCheckResult, ResumeModel } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  resume: ResumeModel;
  /** The JD text already in the store, so re-opening shows what was checked. */
  jdText: string;
  /** The posting this fit reading belongs to — re-checking it costs nothing. */
  checkedFor: string | null;
  fit: FitCheckResult | null;
  onChecked: (jdText: string, fit: FitCheckResult) => void;
  onTailor: (jdText: string) => void;
  tailoring: boolean;
  /**
   * A tailor result is on screen; this dialog is now for aiming at a DIFFERENT
   * posting, not for re-reading this one. It re-labels the dialog and — the
   * part that matters — makes the cached fit panel unreachable: that reading
   * was taken against the MASTER, while `ScoreCard` on the page below is
   * showing the TAILORED document's, and two unlabelled recruiter-fit rings
   * with different numbers for different documents is precisely what "two
   * numbers on two clocks, never a blended one" forbids.
   */
  hasResult: boolean;
  /**
   * How many blocks of the document on the page below the user typed themselves.
   *
   * The Tailor button here calls `startTailor`, which resets `tailorOverrides`
   * to `{}` — so above zero this dialog's primary action DELETES the user's own
   * sentences, and there is nothing to recover them from: they are mirrored
   * nowhere, and a second tailor of the same posting comes back as different
   * text at `temperature=0.3`. Above zero the button arms first and the note
   * names the count at rest.
   */
  overrideCount?: number;
}

const TOP_MISSING = 8;

/**
 * Tailor for a job, in one place: paste the posting or drop its link, see how
 * you match it, then tailor.
 *
 * CHECK FIT IS NOT FREE, and the copy says so rather than hiding it. Coverage
 * needs the posting's keywords, and the only thing that produces those is a
 * model call — so there is no version of this that costs nothing. Since it costs
 * a credit either way, it spends that credit on the JD_FIT task, which returns
 * the analysed posting AND the fit reading together; `analyze_jd` alone would
 * cost the same and return half as much. The analysed JD then rides into the
 * tailor, so checking first adds no calls at all — which is the honest headline
 * and is exactly what the cost line says.
 *
 * The draft is local. The page writes `jdText` into a module-level store on
 * every keystroke, and inside a modal that would make Cancel do nothing.
 */
export default function TailorOverlay({
  open,
  onClose,
  resume,
  jdText,
  checkedFor,
  fit,
  onChecked,
  onTailor,
  tailoring,
  hasResult,
  overrideCount = 0,
}: Props) {
  const { t } = useTranslation("tailor");
  const [draft, setDraft] = useState(jdText);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Tailoring would throw away hand-edits, so the button asks once first.
  const [armed, setArmed] = useState(false);
  const guarded = hasResult && overrideCount > 0;

  // Reseed on open only — reseeding on every render would fight typing.
  //
  // With a result up the box opens EMPTY: "tailor for a different job" prefilled
  // with the previous job's text is a contradiction, and the blank draft is also
  // what makes the stale fit panel below structurally unreachable.
  useEffect(() => {
    if (!open) return;
    setDraft(hasResult ? "" : jdText);
    setErr("");
    // Re-opening is a fresh decision. A dialog that opens already armed puts a
    // red "discard my edits" button under the user's thumb before they have
    // read anything.
    setArmed(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = draft.trim().length > 30;
  // Already read this exact posting: the result on screen is about this text,
  // so re-checking would spend a credit to learn nothing.
  //
  // `!hasResult` is belt as well as braces. `checkedFor` is never "" (a check
  // only fires when `ready`, i.e. over 30 characters), so the empty draft above
  // already makes this false — but the panel it gates paints a reading taken
  // against the MASTER while ScoreCard on the page paints the TAILORED
  // document's, and that contradiction is worth being able to SEE in one
  // expression rather than deducing from two files. check-mirrors 15 reads it.
  const cached = !hasResult && !!fit && checkedFor !== null && checkedFor === draft.trim();

  async function run() {
    if (!ready || busy) return;
    setBusy(true);
    setErr("");
    try {
      onChecked(draft.trim(), await checkFit(resume, draft.trim()));
    } catch (e: unknown) {
      setErr(apiErrorMessage(e, t("overlay.failed")));
    } finally {
      setBusy(false);
    }
  }

  const missing = (fit?.gaps ?? []).filter((g) => g.status === "missing").slice(0, TOP_MISSING);
  // Partials were hidden here, which is backwards: a partial is the cheapest
  // thing on the list to fix. The posting wants its own wording and the
  // candidate already has the experience, so it costs one edit and no tailor
  // credit -- and it is half a point of coverage each, which is exactly why
  // the ring disagreed with the "N of M" line beneath it.
  const partial = (fit?.gaps ?? []).filter((g) => g.status === "partial").slice(0, TOP_MISSING);

  return (
    <Modal
      open={open}
      // Guarded: Modal fires onClose on Escape and on backdrop click
      // unconditionally, and losing a half-pasted posting mid-request is the
      // one thing this dialog must not do.
      onClose={() => !busy && !tailoring && onClose()}
      // The dialog's heading echoes the control that opened it, word for word.
      title={hasResult ? t("overlay.openDifferent") : t("overlay.title")}
      maxWidth="max-w-2xl"
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">{t("overlay.hint")}</p>
        <JDPaste value={draft} onChange={setDraft} />

        {cached && fit && (
          <div className="space-y-3 rounded-xl border border-line bg-bg-soft/60 p-4">
            <div className="flex flex-wrap items-center justify-around gap-4">
              <div className="flex flex-col items-center gap-1.5">
                <ProgressRing value={fit.keyword_coverage} size={84} tone="accent" delay={0.1} />
                <span className="text-xs font-semibold text-ink">{t("fit.coverage")}</span>
                <span className="text-[11px] tabular-nums text-ink-muted">
                  {t("fit.coverageSub", { covered: fit.covered, total: fit.total, partial: fit.partial })}
                </span>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <ProgressRing value={fit.fit_score} size={84} tone="mint" delay={0.1} />
                <span className="text-xs font-semibold text-ink">{t("fit.recruiter")}</span>
              </div>
            </div>
            {fit.rationale && <p className="text-sm leading-relaxed text-ink-muted">{fit.rationale}</p>}
            {missing.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-semibold text-ink">{t("overlay.topMissing")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {missing.map((g) => (
                    <Badge key={g.keyword} tone="missing">
                      {g.keyword}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {partial.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-semibold text-ink">{t("overlay.topPartial")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {partial.map((g) => (
                    <Badge key={g.keyword} tone="partial">
                      {g.keyword}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {err && <p className="text-sm text-danger">{err}</p>}

        {/* The cost, stated. Checking spends one credit; tailoring afterwards
            reuses the posting it already read, so it does not spend again. */}
        <p className="text-xs leading-relaxed text-ink-faint">
          {cached ? t("overlay.cached") : t("overlay.cost")}
        </p>

        {/* The thing the app never said out loud: a second tailor starts again
            from the MASTER, and what it replaces is the review on screen — not
            the saved résumé. Plain static markup, no reveal and no `animate`
            prop: a height tween here is check 11's defect in its eighth
            costume.
            IT REASSURED ABOUT THE WRONG THING while hand-edits existed. "Your
            saved master is not changed" is true and beside the point: what this
            button actually deletes is the sentences the user typed onto the CV
            on the page below, and the note said nothing about them. The counted
            variant names them, and is keyed so the sentence cannot appear at
            zero. */}
        {hasResult && (
          <p
            className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
              armed ? "border-danger/40 bg-danger/10 text-danger" : "border-line bg-bg-soft text-ink-muted"
            }`}
          >
            {guarded ? t("overlay.replacesEdited", { count: overrideCount }) : t("overlay.replaces")}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy || tailoring}>
            {t("overlay.close")}
          </Button>
          {!cached && (
            <Button loading={busy} disabled={!ready} icon={<Sparkles size={16} />} onClick={run}>
              {busy ? t("overlay.checking") : t("overlay.checkFit")}
            </Button>
          )}
          {/* ARM, THEN CONFIRM — the Settings danger-zone shape, because above
              zero this button is destructive and was one tap. The consequence is
              already stated at rest in the note above (it names the count
              whether or not anything is armed), so arming reveals no new fact;
              it only separates the intent from the act. */}
          {guarded && !armed ? (
            <Button disabled={!ready || busy} icon={<Wand2 size={16} />} onClick={() => setArmed(true)}>
              {t("overlay.retailor")}
            </Button>
          ) : (
            <>
              {guarded && (
                <Button variant="secondary" onClick={() => setArmed(false)} disabled={tailoring}>
                  {t("overlay.keepEdits")}
                </Button>
              )}
              <Button
                variant={guarded ? "danger" : "primary"}
                loading={tailoring}
                disabled={!ready || busy}
                icon={<Wand2 size={16} />}
                onClick={() => onTailor(draft.trim())}
              >
                {guarded
                  ? t("overlay.retailorDiscard", { count: overrideCount })
                  : hasResult
                    ? t("overlay.retailor")
                    : t("overlay.tailor")}
              </Button>
            </>
          )}
        </div>
        {!ready && <p className="text-end text-xs text-ink-muted">{t("overlay.needsJd")}</p>}
      </div>
    </Modal>
  );
}
