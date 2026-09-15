import { useMemo, useState } from "react";
import { apiErrorMessage, isMonthlyLimit } from "../lib/apiError";
import { Copy, RefreshCw, Wand2, Scissors } from "lucide-react";
import { useTranslation } from "react-i18next";
import { coverLetter } from "../api/client";
import { formatUsesTime, useUses } from "../lib/usesStore";
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

/** This posting's cover-letter pass as the last response described it (Phase 30
 * / B5, OD-2 b): the first letter uses 1, and changes within 24 hours ride it,
 * up to 10 calls in all. Kept here and nowhere else, so a reload forgets it and
 * the note says the next letter uses 1, which errs toward stating a cost. */
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
  const toast = useToast();
  // The server keys the pass by the analysed JD, so "the posting is unchanged"
  // means the same JD. A tone is not part of it: any tone rides the pass.
  const posting = useMemo(() => JSON.stringify(jd), [jd]);
  const live = pass !== null && pass.posting === posting && pass.left > 0 ? pass : null;
  const uses = useUses("cover_letter", live?.until);

  async function generate(extra?: string) {
    setError("");
    setLoading(true);
    try {
      const res = await coverLetter(resume, jd, extra ? `${tone}, ${extra}` : tone);
      setText(res.cover_letter);
      setPass(res.included_until ? { until: res.included_until, left: res.changes_left ?? 0, posting } : null);
      onGenerated?.(res.cover_letter);
    } catch (e: any) {
      // A monthly-limit refusal proves no pass covered this call. Any other
      // failure on a pass still used its slot on the server (a failed change
      // keeps its slot), so the count here goes down with it.
      if (isMonthlyLimit(e)) setPass(null);
      else setPass((p) => (p ? { ...p, left: Math.max(0, p.left - 1) } : p));
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
        {/* The one control here that may be disabled for want of a use, and
            never while this posting's pass still covers a change. */}
        <Button
          variant="secondary"
          size="sm"
          loading={loading}
          disabled={uses.out}
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
        {tCommon("uses.coverLetter", { count: uses.limit ?? 0 })}
      </UsesNote>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {text && (
        <div className="mt-3 whitespace-pre-wrap break-words rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink">
          {text}
        </div>
      )}
    </Card>
  );
}
