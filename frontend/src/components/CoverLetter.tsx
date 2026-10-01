import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apiErrorMessage, isMonthlyLimit, isServerFailure } from "../lib/apiError";
import { Copy, RefreshCw, Wand2, Scissors } from "lucide-react";
import { useTranslation } from "react-i18next";
import { coverLetter, coverLetterPass, writeProposal } from "../api/client";
import { cn } from "../lib/cn";
import { formatUsesTime, inclusionFrom, useUses } from "../lib/usesStore";
import type { JDModel, ProposalResponse, ResumeModel } from "../types";
import UsesNote from "./UsesNote";
import { Button, Card, CardTitle, useToast } from "./ui";

/** What this card writes: a cover letter, or a short bid for a freelance gig
 * (2026-09-28). Both ride ONE pass per posting (the server's `cover_letter`
 * pass, keyed by the analysed JD), so switching costs nothing extra. */
export type WrittenKind = "letter" | "proposal";

/** What the floor under the proposal prompt found (`proposal_terms`), as the
 * server said it: the [brackets] left to fill, what it took out, and numbers no
 * source carries. None of it is a claim that the text is right. */
export type ProposalFound = Pick<ProposalResponse, "placeholders" | "replaced" | "unverified">;

interface Props {
  resume: ResumeModel;
  jd: JDModel;
  onGenerated?: (text: string) => void;
  /** Restores a previously generated letter when the page is revisited. */
  initialText?: string;
  /** The posting's own words, sent with a proposal so it can answer what the
   * client asked (a rate, a start date). A letter never sends it. */
  postingText?: string;
  /** The kinds this card offers, in order (default both). The Tools page's gig
   * offers the proposal alone. */
  kinds?: readonly WrittenKind[];
  /** The kind chosen on mount: a proposal for a job labelled Contract or
   * Freelance (`proposalFirst` in pages/jobs/shared.ts), else the first kind. */
  initialKind?: WrittenKind;
  /** The rate typed before the card mounted (the Tools page's first step). */
  initialRate?: string;
  /** What the floor found in the proposal the card is seeded with. */
  initialFound?: ProposalFound | null;
  /** The text as the user left it after editing it in the box (on blur). */
  onEdited?: (text: string) => void;
}

// Tone ids are sent to the API as-is (English); labels are translated.
const TONES = ["professional", "enthusiastic", "concise", "warm"];
// The typed rate's box: the schema's own bound (`ProposalRequest.rate`).
export const PROPOSAL_RATE_MAX = 100;

/** This posting's cover-letter pass (Phase 30 / B5, OD-2 b): the first letter
 * uses 1, and changes within 24 hours ride it, up to 10 calls in all. The server
 * lists it nowhere a remount could read (it belongs to one posting), so the card
 * asks POST /cover-letter/pass when it mounts and keeps what the latest answer
 * said (P30-RELOAD-PASS). `until` is a deadline taken on ARRIVAL from the
 * server's relative seconds, never its absolute instant, so a phone whose clock
 * runs ahead cannot end the pass early. */
type LetterPass = { until: string; left: number; posting: string };

export default function CoverLetter({
  resume,
  jd,
  onGenerated,
  initialText,
  postingText,
  kinds = ["letter", "proposal"],
  initialKind,
  initialRate,
  initialFound,
  onEdited,
}: Props) {
  const { t } = useTranslation("tailor");
  const { t: tCommon } = useTranslation();
  const { i18n } = useTranslation();
  const [text, setText] = useState(initialText ?? "");
  const [kind, setKind] = useState<WrittenKind>(
    initialKind && kinds.includes(initialKind) ? initialKind : kinds[0] ?? "letter",
  );
  // Which kind the text in the box is: switching kinds keeps the text, and the
  // button offers to write the other kind rather than to write "it" again.
  const [textKind, setTextKind] = useState<WrittenKind>(kind);
  const [found, setFound] = useState<ProposalFound | null>(initialFound ?? null);
  const [rate, setRate] = useState(initialRate ?? "");
  const [tone, setTone] = useState("professional");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pass, setPass] = useState<LetterPass | null>(null);
  // Whether this card knows what the posting's pass covers. Until the probe or a
  // letter answers it does not, and then it states no cost and disables nothing:
  // unknown is never zero, and the server decides the call.
  const [known, setKnown] = useState(false);
  // Bumped by every probe and every letter. A probe answer that lands after a
  // letter started describes the pass BEFORE that letter took its slot, and
  // applying it would put the slot back and hide the next letter's cost.
  const seq = useRef(0);
  // The text as last handed to a page (written or saved on blur), so a blur that
  // changed nothing saves nothing.
  const handed = useRef(initialText ?? "");
  const box = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();
  // The server keys the pass by the analysed JD, so "the posting is unchanged"
  // means the same JD. A tone is not part of it: any tone rides the pass.
  const posting = useMemo(() => JSON.stringify(jd), [jd]);
  const live = pass !== null && pass.posting === posting && pass.left > 0 ? pass : null;
  const uses = useUses("cover_letter", live?.until);
  const limited = uses.limited;
  const proposal = kind === "proposal";

  useEffect(() => {
    // With no monthly limit known (the admin, plan unlimited, an unknown count)
    // nothing here is noted or disabled, so there is nothing to ask.
    if (!limited) return;
    let alive = true;
    const at = ++seq.current;
    // A new posting starts unknown: the last posting's answer says nothing here.
    setKnown(false);
    coverLetterPass(jd)
      .then((r) => {
        if (!alive || seq.current !== at) return;
        const inc = inclusionFrom(r);
        setPass(inc ? { ...inc, posting } : null);
        setKnown(true);
      })
      .catch(() => {
        // Left unknown: no note, Generate enabled, and the server decides.
      });
    return () => {
      alive = false;
    };
    // `posting` is `jd` serialised: a new object for the same posting asks nothing.
    // `limited` re-asks once a count arrives, so a card that mounted first still learns.
  }, [posting, limited]);

  // The box grows with its text instead of scrolling inside the page (a phone
  // would then hold two scrolls). A size set, never an animated height.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);

  async function generate(extra?: string) {
    setError("");
    setLoading(true);
    seq.current++;
    try {
      const res =
        kind === "proposal"
          ? await writeProposal({ resume, jd, gig_text: postingText ?? "", rate, tone: extra ?? "" })
          : await coverLetter(resume, jd, extra ? `${tone}, ${extra}` : tone);
      const written = "proposal" in res ? res.proposal : res.cover_letter;
      setText(written);
      setTextKind(kind);
      setFound("proposal" in res ? res : null);
      // The relative seconds, never `included_until`: see LetterPass.
      const inc = inclusionFrom({ calls_left: res.changes_left, expires_in_s: res.expires_in_s });
      setPass(inc ? { ...inc, posting } : null);
      setKnown(true);
      handed.current = written;
      onGenerated?.(written);
    } catch (e: any) {
      // A monthly-limit refusal proves no pass covered this call. A 5xx is the
      // only failure raised from INSIDE the pass -- `pass_charged` runs after
      // the handler's own checks -- so it is the only one that spent a slot,
      // and the only one this count goes down with. A 400, a 422, a 401, a 403
      // or a request that never reached the server left the pass alone: taking
      // a slot for those turns `left` to 0 early, and at 0 uses left that
      // DISABLES Generate on a call the server would still have included,
      // which is the one error a local count may not make.
      if (isMonthlyLimit(e)) {
        setPass(null);
        setKnown(true);
      } else if (isServerFailure(e)) setPass((p) => (p ? { ...p, left: Math.max(0, p.left - 1) } : p));
      setError(apiErrorMessage(e, proposal ? t("proposal.error") : t("cover.error")));
    } finally {
      setLoading(false);
    }
  }

  function leaveBox() {
    if (text === handed.current) return;
    handed.current = text;
    onEdited?.(text);
  }

  // What the floor found, as far as the text in the box still shows it: a
  // bracket the user filled in, or a number they took out, is not said again.
  const shownFound = proposal && textKind === "proposal" && found ? found : null;
  const toFill = (shownFound?.placeholders ?? []).filter((p) => text.includes(p));
  const toCheck = (shownFound?.unverified ?? []).filter((n) => text.includes(n));
  const again = !!text && textKind === kind;
  // Touch targets: 44 px on a phone (the owner's floor), the kit's compact size from lg.
  const tap = "min-h-11 lg:min-h-0";

  return (
    <Card>
      <CardTitle>{proposal ? t("proposal.title") : t("cover.title")}</CardTitle>
      {kinds.length > 1 && (
        <div
          role="radiogroup"
          aria-label={t("proposal.kindLabel")}
          className="mt-3 inline-flex rounded-lg border border-line bg-bg-soft p-0.5"
        >
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                "min-h-11 rounded-md px-4 text-sm font-medium transition-colors lg:min-h-9",
                kind === k ? "bg-panel text-ink shadow-sm" : "text-ink-muted hover:text-ink",
              )}
            >
              {k === "proposal" ? t("proposal.kindProposal") : t("proposal.kindLetter")}
            </button>
          ))}
        </div>
      )}
      {proposal && (
        <div className="mt-3">
          <label htmlFor="proposal-rate" className="mb-1 block text-xs text-ink-muted">
            {t("proposal.rateLabel")}
          </label>
          {/* 16 px on a phone: iOS zooms the page into a smaller focused input. */}
          <input
            id="proposal-rate"
            dir="auto"
            value={rate}
            maxLength={PROPOSAL_RATE_MAX}
            onChange={(e) => setRate(e.target.value)}
            placeholder={t("proposal.ratePlaceholder")}
            className="h-11 w-full rounded-lg border border-line bg-bg-soft px-3 text-base text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none sm:max-w-xs sm:text-sm"
          />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!proposal && (
          <select
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            aria-label={t("proposal.toneLabel")}
            className="min-h-11 rounded-lg border border-line bg-bg-soft px-2.5 py-2 text-base text-ink focus:border-accent/60 focus:outline-none sm:text-sm lg:min-h-0"
          >
            {TONES.map((toneId) => (
              <option key={toneId} value={toneId}>
                {t(`cover.tones.${toneId}`)}
              </option>
            ))}
          </select>
        )}
        {/* The one control here that may be disabled for want of a use: never
            while this posting's pass still covers a change, and never before
            the card knows whether it does. */}
        <Button
          variant="secondary"
          size="sm"
          className={tap}
          loading={loading}
          disabled={known && uses.out}
          icon={<Wand2 size={15} />}
          onClick={() => generate()}
        >
          {proposal
            ? again
              ? t("proposal.regenerate")
              : t("proposal.generate")
            : again
              ? t("cover.regenerate")
              : t("cover.generate")}
        </Button>
        {text && (
          <>
            {/* Never disabled: a refusal renders inline below. */}
            <Button
              variant="ghost"
              size="sm"
              className={tap}
              icon={<RefreshCw size={14} />}
              onClick={() => generate(proposal ? "make it more specific to this gig" : "make it more specific to this role")}
            >
              {t("cover.moreSpecific")}
            </Button>
            <Button variant="ghost" size="sm" className={tap} icon={<Scissors size={14} />} onClick={() => generate("make it noticeably shorter")}>
              {t("cover.shorter")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={tap}
              icon={<Copy size={14} />}
              onClick={() => {
                navigator.clipboard.writeText(text);
                toast("success", t("cover.copied"));
              }}
            >
              {t("common:actions.copy")}
            </Button>
          </>
        )}
      </div>
      {/* Only once the card knows: an unknown pass read as none would print "No
          uses left" at 0 under a change the pass may include. */}
      {known && (
        <UsesNote
          feature="cover_letter"
          includedUntil={live?.until}
          covered={
            live
              ? tCommon("uses.coverIncluded", { count: live.left, time: formatUsesTime(live.until, i18n.language) })
              : undefined
          }
          className="mt-2"
        >
          {proposal
            ? tCommon("uses.proposal", { count: uses.remaining ?? 0 })
            : tCommon("uses.coverLetter", { count: uses.remaining ?? 0 })}
        </UsesNote>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {/* `dir="auto"`: the text is in its own language (a proposal in the gig's,
          a letter in the resume's), not the UI's. An English letter under the
          Hebrew UI inherited RTL, so its punctuation sat at the wrong end of
          every line (",Dear Hiring Manager"). Editable: the user sends it, so the
          user has the last word; 16 px on a phone, so iOS does not zoom. */}
      {text && (
        <textarea
          ref={box}
          dir="auto"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={leaveBox}
          aria-label={proposal ? t("proposal.textLabel") : t("proposal.letterLabel")}
          rows={6}
          className="mt-3 min-h-11 w-full resize-none overflow-hidden whitespace-pre-wrap break-words rounded-xl border border-line bg-bg-soft p-4 text-base leading-relaxed text-ink focus:border-accent/60 focus:outline-none sm:text-sm"
        />
      )}
      {proposal && toFill.length > 0 && (
        <p className="mt-2 text-sm text-warn">
          {t("proposal.fillIn")}{" "}
          <bdi dir="auto" className="font-medium">
            {toFill.join(" · ")}
          </bdi>
        </p>
      )}
      {proposal && toCheck.length > 0 && (
        <p className="mt-1 text-sm text-warn">
          {t("proposal.checkNumbers")}{" "}
          <bdi dir="auto" className="font-medium">
            {toCheck.join(", ")}
          </bdi>
        </p>
      )}
      {proposal && (shownFound?.replaced.length ?? 0) > 0 && (
        <p className="mt-1 text-xs text-ink-muted">{t("proposal.tookOut")}</p>
      )}
      {proposal && <p className="mt-2 text-xs text-ink-faint">{t("proposal.sendYourself")}</p>}
    </Card>
  );
}
