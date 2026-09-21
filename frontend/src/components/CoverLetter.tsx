import { useEffect, useMemo, useRef, useState } from "react";
import { apiErrorMessage, isMonthlyLimit, isServerFailure } from "../lib/apiError";
import { Copy, RefreshCw, Wand2, Scissors } from "lucide-react";
import { useTranslation } from "react-i18next";
import { coverLetter, coverLetterPass } from "../api/client";
import { formatUsesTime, inclusionFrom, useUses } from "../lib/usesStore";
import type { JDModel, ResumeModel } from "../types";
import UsesNote from "./UsesNote";
import { Button, Card, CardTitle, useToast } from "./ui";

interface Props {
  resume: ResumeModel;
  jd: JDModel;
  onGenerated?: (text: string) => void;
  /** Restores a previously generated letter when the page is revisited. */
  initialText?: string;
}

// Tone ids are sent to the API as-is (English); labels are translated.
const TONES = ["professional", "enthusiastic", "concise", "warm"];

/** This posting's cover-letter pass (Phase 30 / B5, OD-2 b): the first letter
 * uses 1, and changes within 24 hours ride it, up to 10 calls in all. The server
 * lists it nowhere a remount could read (it belongs to one posting), so the card
 * asks POST /cover-letter/pass when it mounts and keeps what the latest answer
 * said (P30-RELOAD-PASS). `until` is a deadline taken on ARRIVAL from the
 * server's relative seconds, never its absolute instant, so a phone whose clock
 * runs ahead cannot end the pass early. */
type LetterPass = { until: string; left: number; posting: string };

export default function CoverLetter({ resume, jd, onGenerated, initialText }: Props) {
  const { t } = useTranslation("tailor");
  const { t: tCommon } = useTranslation();
  const { i18n } = useTranslation();
  const [text, setText] = useState(initialText ?? "");
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
  const toast = useToast();
  // The server keys the pass by the analysed JD, so "the posting is unchanged"
  // means the same JD. A tone is not part of it: any tone rides the pass.
  const posting = useMemo(() => JSON.stringify(jd), [jd]);
  const live = pass !== null && pass.posting === posting && pass.left > 0 ? pass : null;
  const uses = useUses("cover_letter", live?.until);
  const limited = uses.limited;

  useEffect(() => {
    // With no monthly limit known (the admin, plan unlimited, an unknown count)
    // nothing here is noted or disabled, so there is nothing to ask.
    if (!limited) return;
    let alive = true;
    const at = ++seq.current;
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
  }, [posting, limited]);

  async function generate(extra?: string) {
    setError("");
    setLoading(true);
    seq.current++;
    try {
      const res = await coverLetter(resume, jd, extra ? `${tone}, ${extra}` : tone);
      setText(res.cover_letter);
      // The relative seconds, never `included_until`: see LetterPass.
      const inc = inclusionFrom({ calls_left: res.changes_left, expires_in_s: res.expires_in_s });
      setPass(inc ? { ...inc, posting } : null);
      setKnown(true);
      onGenerated?.(res.cover_letter);
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
      setError(apiErrorMessage(e, t("cover.error")));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardTitle>{t("cover.title")}</CardTitle>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={tone}
          onChange={(e) => setTone(e.target.value)}
          className="rounded-lg border border-line bg-bg-soft px-2.5 py-2 text-sm text-ink focus:border-accent/60 focus:outline-none"
        >
          {TONES.map((toneId) => (
            <option key={toneId} value={toneId}>
              {t(`cover.tones.${toneId}`)}
            </option>
          ))}
        </select>
        {/* The one control here that may be disabled for want of a use: never
            while this posting's pass still covers a change, and never before
            the card knows whether it does. */}
        <Button
          variant="secondary"
          size="sm"
          loading={loading}
          disabled={known && uses.out}
          icon={<Wand2 size={15} />}
          onClick={() => generate()}
        >
          {text ? t("cover.regenerate") : t("cover.generate")}
        </Button>
        {text && (
          <>
            {/* Never disabled: a refusal renders inline below. */}
            <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => generate("make it more specific to this role")}>
              {t("cover.moreSpecific")}
            </Button>
            <Button variant="ghost" size="sm" icon={<Scissors size={14} />} onClick={() => generate("make it noticeably shorter")}>
              {t("cover.shorter")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
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
          {tCommon("uses.coverLetter", { count: uses.remaining ?? 0 })}
        </UsesNote>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {text && (
        <div className="mt-3 whitespace-pre-wrap break-words rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink">
          {text}
        </div>
      )}
    </Card>
  );
}
