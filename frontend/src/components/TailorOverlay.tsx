import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Wand2 } from "lucide-react";
import JDPaste from "./JDPaste";
import UsesNote from "./UsesNote";
import { checkFit } from "../api/client";
import { apiErrorMessage } from "../lib/apiError";
import { useUses } from "../lib/usesStore";
import { Badge, Button, Modal, ProgressRing } from "./ui";
import type { FitCheckResult, ResumeModel } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  resume: ResumeModel;
  /** The JD text already in the store, so re-opening shows what was checked. */
  jdText: string;
  /** The posting this fit reading belongs to. With it on screen the dialog
   * offers no second check, which would spend a use to learn nothing. */
  checkedFor: string | null;
  fit: FitCheckResult | null;
  onChecked: (jdText: string, fit: FitCheckResult) => void;
  /** Tailor for this text. `reading` is a fit check taken in this dialog while
   * a draft was up, which the page adopts as the posting's reading first, so
   * the tailor claims the ride it opened (PLAN 31.3/1). */
  onTailor: (jdText: string, reading: HeldReading | null) => void;
  tailoring: boolean;
  /**
   * A tailor result is on screen; this dialog is now for aiming at a DIFFERENT
   * posting, not for re-reading this one. It re-labels the dialog and — the
   * part that matters — makes the cached fit panel unreachable: that reading
   * was taken against the MASTER, while the page below is
   * showing the TAILORED document's, and two unlabelled recruiter-fit rings
   * with different numbers for different documents is precisely what "two
   * numbers on two clocks, never a blended one" forbids.
   */
  hasResult: boolean;
  /**
   * How many blocks of the document on the page below the user typed themselves.
   *
   * The Tailor button here calls `startTailor`, which resets `tailorOverrides`
   * to `{}`. Since PLAN 31.3/4 the draft those lines are in is saved with its
   * job, so they are LOST only two ways: tailoring the same posting again, whose
   * new draft replaces the one on that job's row, or lines that never reached
   * the row (a failed save). Then the button arms first and the note names the
   * count at rest; a second tailor comes back as different text at
   * `temperature=0.3`, so nothing brings them back. Tailoring ANOTHER posting
   * leaves them on the previous job's row, and the note says so instead.
   */
  overrideCount?: number;
  /** The posting the job's row was saved for, and whether the draft on the page
   * has reached it (PLAN 31.3/4). They decide which of the cases above this is. */
  savedFor?: string | null;
  draftSaved?: boolean;
}

const TOP_MISSING = 8;

/** A fit check taken while a tailored draft is up (PLAN 31.3/1). HELD HERE, not
 * written to the store, until Tailor: the page's `jdText`, `jd` and `fit`
 * describe the draft on screen and its posting, and writing another posting's
 * reading into them would leave that draft beside a job it was not tailored
 * for. `at` is the reading's own minute, for the stamp the page keeps. */
export type HeldReading = { text: string; fit: FitCheckResult; at: number };

/**
 * Tailor for a job, in one place: paste the posting or drop its link, see how
 * you match it, then tailor.
 *
 * CHECK FIT IS NOT FREE, and the note under the buttons says so rather than
 * hiding it. Coverage needs the posting's keywords, and the only thing that
 * produces those is a model call, so there is no version of this that costs
 * nothing: it uses 1 of the month's uses, on the JD_FIT task, which returns the
 * analysed posting AND the fit reading together. That use also covers tailoring
 * the same job within 24 hours (Phase 30 / B4.4): the server keys that tailor by
 * the analysed JD the fit check returned, and `startTailor` sends exactly that
 * JD. So "check fit, then tailor" is 1 use in all, the same as tailoring
 * straight away, and the Tailor note says so for as long as
 * `tailor_included_until` holds.
 *
 * TAILORING STRAIGHT FROM HERE SPENDS ITS OWN USE, and with no fit reading on
 * screen BOTH buttons are live -- so the line under them prices either one. It
 * priced Check fit alone, which is the cheaper-looking half of the choice: at
 * one use left, tapping Tailor spent that last use under a warning-ink
 * sentence about a button the user had not pressed.
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
  savedFor = null,
  draftSaved = false,
}: Props) {
  const { t } = useTranslation("tailor");
  // The uses copy lives in common.json, through its own named binding.
  const { t: tCommon } = useTranslation();
  const [draft, setDraft] = useState(jdText);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Tailoring would throw away hand-edits, so the button asks once first.
  const [armed, setArmed] = useState(false);
  const [held, setHeld] = useState<HeldReading | null>(null);
  // A held reading goes with the draft it was taken beside. Once the page has
  // adopted it (Tailor) the store holds it; once the draft is gone (back to the
  // master) the page's own reading is the one to show.
  useEffect(() => {
    if (!hasResult) setHeld(null);
  }, [hasResult]);
  // The same posting as the job's row: its new draft replaces the saved one.
  const samePosting = !!savedFor && draft.trim() === savedFor;
  const guarded = hasResult && overrideCount > 0 && (!draftSaved || samePosting);

  // Reseed on open only — reseeding on every render would fight typing.
  //
  // With a result up the box opens EMPTY: "tailor for a different job" prefilled
  // with the previous job's text is a contradiction, and the blank draft is also
  // what makes the stale fit panel below structurally unreachable.
  useEffect(() => {
    if (!open) return;
    // A reading held from an earlier open comes back with its text, so a use
    // spent on it is never spent again for the same answer.
    setDraft(hasResult ? (held?.text ?? "") : jdText);
    setErr("");
    // Re-opening is a fresh decision. A dialog that opens already armed puts a
    // red "discard my edits" button under the user's thumb before they have
    // read anything.
    setArmed(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = draft.trim().length > 30;
  // Already read this exact posting: the result on screen is about this text,
  // so re-checking would spend a use to learn nothing.
  //
  // `!hasResult` is belt as well as braces. `checkedFor` is never "" (a check
  // only fires when `ready`, i.e. over 30 characters), so the empty draft above
  // already makes this false — but the panel it gates paints a reading taken
  // against the MASTER while the page below describes the TAILORED
  // document's, and that contradiction is worth being able to SEE in one
  // expression rather than deducing from two files. check-mirrors 15 reads it.
  const cached = !hasResult && !!fit && checkedFor !== null && checkedFor === draft.trim();
  // The reading this dialog shows: the page's (no draft up) or one held here
  // (a draft up), and only for exactly the text in the box. Never the page's
  // reading while a draft is up: that one is the MASTER against the draft's own
  // posting, the two-rings contradiction check-mirrors 15 exists for.
  const heldHere = hasResult && held !== null && held.text === draft.trim();
  const reading = cached ? fit : heldHere ? held.fit : null;

  // What each step spends (Phase 30 / C3, C4). The fit check's included tailor
  // counts only while this dialog shows that reading: another text is another
  // posting. `out` is the one thing that disables a counted button, and it is
  // false for a covered call, so at 0 uses left an included Tailor stays enabled.
  const fitUses = useUses("fit_check");
  const includedUntil = reading ? reading.tailor_included_until : undefined;
  const tailorUses = useUses("tailor", includedUntil);

  async function run() {
    if (!ready || busy) return;
    setBusy(true);
    setErr("");
    const text = draft.trim();
    try {
      const r = await checkFit(resume, text);
      if (hasResult) setHeld({ text, fit: r, at: Date.now() });
      else onChecked(text, r);
    } catch (e: unknown) {
      setErr(apiErrorMessage(e, t("overlay.failed")));
    } finally {
      setBusy(false);
    }
  }

  const missing = (reading?.gaps ?? []).filter((g) => g.status === "missing").slice(0, TOP_MISSING);
  // Partials were hidden here, which is backwards: a partial is the cheapest
  // thing on the list to fix. The posting wants its own wording and the
  // candidate already has the experience, so it costs one edit and no use --
  // and it is half a point of coverage each, which is exactly why the ring
  // disagreed with the "N of M" line beneath it.
  const partial = (reading?.gaps ?? []).filter((g) => g.status === "partial").slice(0, TOP_MISSING);

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
        {/* Folded once the fit reading on screen belongs to this very text
            (PLAN 31.2/9): the reading rendered under a 240 px box and needed a
            scroll inside the dialog. */}
        <JDPaste
          value={draft}
          onChange={setDraft}
          folded={reading ? { title: reading.jd.job_title, company: reading.jd.company } : null}
        />

        {reading && (
          <div className="space-y-3 rounded-xl border border-line bg-bg-soft/60 p-4">
            <div className="flex flex-wrap items-center justify-around gap-4">
              <div className="flex flex-col items-center gap-1.5">
                <ProgressRing value={reading.keyword_coverage} size={84} tone="accent" delay={0.1} />
                <span className="text-xs font-semibold text-ink">{t("fit.coverage")}</span>
                <span className="text-[11px] tabular-nums text-ink-muted">
                  {t("fit.coverageSub", { covered: reading.covered, total: reading.total, partial: reading.partial })}
                </span>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <ProgressRing value={reading.fit_score} size={84} tone="mint" delay={0.1} />
                <span className="text-xs font-semibold text-ink">{t("fit.recruiter")}</span>
              </div>
            </div>
            {reading.rationale && <p className="text-sm leading-relaxed text-ink-muted">{reading.rationale}</p>}
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

        {/* The thing the app never said out loud: a second tailor starts again
            from the MASTER, and what it replaces is the review on screen — not
            the saved resume. Plain static markup, no reveal and no `animate`
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
            {/* Four truths since PLAN 31.3/4: typed lines replaced with the
                job's saved draft, typed lines that never reached the tracker,
                a draft that stays saved with its job, or no draft saved yet. */}
            {guarded
              ? draftSaved
                ? t("overlay.replacesSaved", { count: overrideCount })
                : t("overlay.replacesEdited", { count: overrideCount })
              : draftSaved && !samePosting
                ? t("overlay.replacesKept")
                : t("overlay.replaces")}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy || tailoring}>
            {t("overlay.close")}
          </Button>
          {/* ONE WAY IN, one step at a time (PLAN 31.3/1). It offered Check fit
              OR Tailor, a choice the user could not make yet: both spend a use,
              and the only difference was whether they saw the match first.
              Now the fit check is step one and the tailor step two, and that is
              still one use in all, because the check includes the tailor of the
              posting it read (Phase 30 / B4.4). */}
          {!reading ? (
            <Button loading={busy} disabled={!ready || fitUses.out} icon={<Sparkles size={16} />} onClick={run}>
              {busy ? t("overlay.checking") : t("overlay.checkFit")}
            </Button>
          ) : /* ARM, THEN CONFIRM — the Settings danger-zone shape, because above
              zero this button is destructive and was one tap. The consequence is
              already stated at rest in the note above (it names the count
              whether or not anything is armed), so arming reveals no new fact;
              it only separates the intent from the act. */
          guarded && !armed ? (
            <Button
              disabled={!ready || busy || tailorUses.out}
              icon={<Wand2 size={16} />}
              onClick={() => setArmed(true)}
            >
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
                disabled={!ready || busy || tailorUses.out}
                icon={<Wand2 size={16} />}
                onClick={() => onTailor(draft.trim(), heldHere ? held : null)}
              >
                {guarded
                  ? t("overlay.retailorDiscard", { count: overrideCount })
                  : tailorUses.covered
                    ? t("overlay.tailorIncluded")
                    : hasResult
                      ? t("overlay.retailor")
                      : t("overlay.tailor")}
              </Button>
            </>
          )}
        </div>
        {/* The cost, stated under the one button that spends it. Before a
            reading that is the fit check, and the line says what it buys: the
            tailor that follows is included. With the reading up, Tailor is the
            counted control, and that reading includes it while it lasts.
            Nothing at all for an account with no monthly limit or an unknown
            count. */}
        {reading ? (
          <UsesNote feature="tailor" includedUntil={includedUntil} className="text-end" />
        ) : (
          <UsesNote feature="fit_check" className="text-end">
            {tCommon("uses.fitThenTailor", { count: fitUses.remaining ?? 0 })}
          </UsesNote>
        )}
        {!ready && <p className="text-end text-xs text-ink-muted">{t("overlay.needsJd")}</p>}
      </div>
    </Modal>
  );
}
