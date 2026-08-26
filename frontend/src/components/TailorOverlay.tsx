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
}: Props) {
  const { t } = useTranslation("tailor");
  const [draft, setDraft] = useState(jdText);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Reseed on open only — reseeding on every render would fight typing.
  useEffect(() => {
    if (!open) return;
    setDraft(jdText);
    setErr("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = draft.trim().length > 30;
  // Already read this exact posting: the result on screen is about this text,
  // so re-checking would spend a credit to learn nothing.
  const cached = !!fit && checkedFor !== null && checkedFor === draft.trim();

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

  return (
    <Modal
      open={open}
      // Guarded: Modal fires onClose on Escape and on backdrop click
      // unconditionally, and losing a half-pasted posting mid-request is the
      // one thing this dialog must not do.
      onClose={() => !busy && !tailoring && onClose()}
      title={t("overlay.title")}
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
                  {t("fit.coverageSub", { covered: fit.covered, total: fit.total })}
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
          </div>
        )}

        {err && <p className="text-sm text-danger">{err}</p>}

        {/* The cost, stated. Checking spends one credit; tailoring afterwards
            reuses the posting it already read, so it does not spend again. */}
        <p className="text-xs leading-relaxed text-ink-faint">
          {cached ? t("overlay.cached") : t("overlay.cost")}
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy || tailoring}>
            {t("overlay.close")}
          </Button>
          {!cached && (
            <Button loading={busy} disabled={!ready} icon={<Sparkles size={16} />} onClick={run}>
              {busy ? t("overlay.checking") : t("overlay.checkFit")}
            </Button>
          )}
          <Button
            loading={tailoring}
            disabled={!ready || busy}
            icon={<Wand2 size={16} />}
            onClick={() => onTailor(draft.trim())}
          >
            {t("overlay.tailor")}
          </Button>
        </div>
        {!ready && <p className="text-end text-xs text-ink-muted">{t("overlay.needsJd")}</p>}
      </div>
    </Modal>
  );
}
