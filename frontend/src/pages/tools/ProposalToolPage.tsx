import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Handshake, Sparkles } from "lucide-react";
import { writeProposal } from "../../api/client";
import CoverLetter, { PROPOSAL_RATE_MAX, type ProposalFound } from "../../components/CoverLetter";
import GigLinks from "../../components/GigLinks";
import ResumeGate from "../../components/ResumeGate";
import ToolShell from "../../components/ToolShell";
import UsesNote from "../../components/UsesNote";
import { useMasterResume } from "../../hooks/useMasterResume";
import { apiErrorMessage } from "../../lib/apiError";
import { readProposalStash, writeProposalStash } from "../../lib/proposalStash";
import { useUses } from "../../lib/usesStore";
import { getJobSearchState, subscribeJobSearch } from "../../state/jobSearchStore";
import { Button, Card, Skeleton } from "../../components/ui";
import type { JDModel } from "../../types";

/** The gig as it was read, and the proposal written for it. */
type Written = { gig: string; rate: string; jd: JDModel; text: string; found: ProposalFound };

// Kept for this tab's life, so leaving to paste the proposal somewhere and
// coming back finds it, with its pass, which the card reads back when it mounts.
// Module state, and since the phone polish pass (2026-09-28) also this tab's
// sessionStorage under the signed-in account (lib/proposalStash): a reload used
// to lose the server's reading of the gig, the pass's key, so the next write read
// it again and charged a second use for a posting whose pass was still open.
let lastGig = "";
let lastRate = "";
let lastWritten: Written | null = null;
// The navigation that last handed a posting over (its location key): a search
// row's state survives a reload under the same key, so the posting is pasted in
// once per tap and a reload never pastes it over what was typed since.
let lastHanded = "";
let restored = false;

/** Once per document: what this tab kept before a reload, for this account. */
function restoreOnce(): void {
  if (restored) return;
  restored = true;
  const kept = readProposalStash<Written>();
  if (!kept) return;
  lastGig = kept.gig;
  lastRate = kept.rate;
  lastWritten = kept.written;
  lastHanded = kept.handed;
}

function stash(): void {
  writeProposalStash<Written>({ gig: lastGig, rate: lastRate, written: lastWritten, handed: lastHanded });
}

/**
 * "Proposal for a gig" (2026-09-28, freelance, the small version): the user
 * pastes a gig from a place JobFinder cannot read (XPlace, Upwork, LinkedIn, a
 * Facebook or WhatsApp group; never Fiverr, where a seller waits for buyers and
 * there is no gig to find) and gets a short bid grounded in their resume.
 *
 * ONE path: paste, (a rate if they want it in), Write. The first proposal reads
 * the gig on the server (a daily count, never a use) and opens the posting's
 * cover-letter pass (one use, said under the button before the tap); after it
 * the proposal is the letter card itself, in proposal mode, so a change rides
 * that pass by the card's own tested rules. Editing the gig makes it a new gig.
 */
export default function ProposalToolPage() {
  const { t } = useTranslation("tools");
  const { t: tCommon } = useTranslation();
  const { master, loading } = useMasterResume();
  // A freelance search's "Write a proposal" (2026-09-28) hands over the
  // posting's text as the gig. It replaces what the box held, once, when the
  // page opens: the same posting again finds its proposal (its pass) kept.
  const location = useLocation();
  const handed = (location.state as { gigText?: unknown } | null)?.gigText;
  const [gig, setGig] = useState(() => {
    restoreOnce();
    if (typeof handed === "string" && handed.trim() && location.key !== lastHanded) {
      lastHanded = location.key;
      lastGig = handed;
      stash();
    }
    return lastGig;
  });
  const [rate, setRate] = useState(lastRate);
  const [written, setWritten] = useState<Written | null>(lastWritten);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState("");
  const result = useRef<HTMLDivElement>(null);
  // Set by a write that just came back: the proposal is brought into view once,
  // after it has rendered (a frame scheduled from the write ran before React
  // committed it, and scrolled to nothing about half the time).
  const reveal = useRef(false);
  // A new gig opens a new pass: 1 use, said before the tap.
  const uses = useUses("cover_letter");
  const current = written && written.gig === gig ? written : null;
  // Where to look for a gig (`GigLinks`, plain links): with the title of this
  // tab's last job search (a freelance search's "Paste a gig" lands here), and
  // with none, each platform's general page. The tool itself has no title box.
  const lastTitle = useSyncExternalStore(subscribeJobSearch, getJobSearchState).result?.context.job_title ?? "";

  useEffect(() => {
    if (!reveal.current || !current) return;
    reveal.current = false;
    result.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [current]);

  function keep(next: Written | null) {
    lastWritten = next;
    stash();
    setWritten(next);
  }

  async function write() {
    if (!master?.resume || !gig.trim()) return;
    setWriting(true);
    setError("");
    // The keyboard goes down, so the proposal is not written under it.
    (document.activeElement as HTMLElement | null)?.blur?.();
    try {
      const res = await writeProposal({ resume: master.resume, jd: null, gig_text: gig, rate, tone: "" });
      reveal.current = true;
      keep({ gig, rate, jd: res.jd, text: res.proposal, found: res });
    } catch (e) {
      setError(apiErrorMessage(e, t("proposal.error")));
    } finally {
      setWriting(false);
    }
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!master?.resume) return <ResumeGate feature={t("proposal.gateFeature")} />;

  return (
    <ToolShell
      title={t("cards.proposal.title")}
      subtitle={t("proposal.subtitle")}
      icon={<Handshake className="text-accent-soft" />}
    >
      <Card>
        <label htmlFor="gig-text" className="mb-1 block text-xs text-ink-muted">
          {t("proposal.gigLabel")}
        </label>
        {/* The user's own paste: never cut (no maxLength), refused whole by the
            server if it is too long. 16 px on a phone, so iOS does not zoom. */}
        <textarea
          id="gig-text"
          dir="auto"
          value={gig}
          onChange={(e) => {
            lastGig = e.target.value;
            stash();
            setGig(e.target.value);
          }}
          // The keyboard takes half a phone's height: once it is up, the box is
          // brought to the top of what is left (under the 56 px header), so the
          // text being pasted or typed is not under the keyboard (measured at
          // 390 x 340: the box began 281 px down, 59 px of it in view).
          onFocus={(e) => {
            const el = e.currentTarget;
            window.setTimeout(() => el.scrollIntoView({ block: "start", behavior: "smooth" }), 300);
          }}
          placeholder={t("proposal.gigPlaceholder")}
          rows={6}
          className="min-h-[9rem] w-full scroll-mt-20 resize-y rounded-lg border border-line bg-bg-soft p-3 text-base text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none sm:text-sm"
        />
        {!current && (
          <>
            <label htmlFor="gig-rate" className="mb-1 mt-3 block text-xs text-ink-muted">
              {t("proposal.rateLabel")}
            </label>
            <input
              id="gig-rate"
              dir="auto"
              value={rate}
              maxLength={PROPOSAL_RATE_MAX}
              onChange={(e) => {
                lastRate = e.target.value;
                stash();
                setRate(e.target.value);
              }}
              placeholder={t("proposal.ratePlaceholder")}
              className="h-11 w-full rounded-lg border border-line bg-bg-soft px-3 text-base text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none sm:max-w-xs sm:text-sm"
            />
            <Button
              className="mt-4 min-h-11"
              loading={writing}
              disabled={!gig.trim() || uses.out}
              icon={<Sparkles size={16} />}
              onClick={() => void write()}
            >
              {t("proposal.write")}
            </Button>
            <UsesNote feature="cover_letter" className="mt-2">
              {tCommon("uses.proposal", { count: uses.remaining ?? 0 })}
            </UsesNote>
            {error && <p className="mt-2 text-sm text-danger">{error}</p>}
          </>
        )}
      </Card>

      {current && (
        <div ref={result} className="scroll-mt-20">
          <CoverLetter
            resume={master.resume}
            jd={current.jd}
            initialText={current.text}
            initialRate={current.rate}
            initialFound={current.found}
            postingText={current.gig}
            kinds={["proposal"]}
            onGenerated={(text) => keep({ ...current, text })}
            onEdited={(text) => keep({ ...current, text })}
          />
        </div>
      )}

      {/* Last on the page, so the proposal arriving above it moves nothing the
          person is reading. */}
      <GigLinks title={lastTitle} bleed="-mx-4 px-4 lg:mx-0 lg:px-0" />
    </ToolShell>
  );
}
