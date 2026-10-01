import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquareText, Copy, Sparkles, Lightbulb } from "lucide-react";
import { screeningAnswer } from "../../api/client";
import ResumeGate from "../../components/ResumeGate";
import ToolShell from "../../components/ToolShell";
import UsesNote from "../../components/UsesNote";
import { useMasterResume } from "../../hooks/useMasterResume";
import { apiErrorMessage } from "../../lib/apiError";
import { useUses } from "../../lib/usesStore";
import { Button, Card, CardTitle, Skeleton, useToast } from "../../components/ui";
import type { ScreeningAnswerResult } from "../../types";

// Preset ids; the question text itself is translated (screening.presets.*).
const PRESETS = ["whyUs", "fit", "challenge", "aboutYou", "whyLeaving"] as const;

const input =
  "min-h-11 w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-base text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none sm:text-sm";

export default function ScreeningToolPage() {
  const { t } = useTranslation("tools");
  const { master, loading } = useMasterResume();
  const [jdText, setJdText] = useState("");
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<ScreeningAnswerResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  // 1 use covers up to 6 answers within 3 hours (Phase 30 / B5), so `out` stays
  // false while that pass has answers left, whatever the month's count.
  const uses = useUses("screening");

  async function run() {
    if (!master?.resume || !question.trim()) return;
    setRunning(true);
    setResult(null);
    setError("");
    try {
      setResult(await screeningAnswer({ resume: master.resume, jd_text: jdText, question }));
    } catch (e) {
      // Said under the button (Phase 30 / C4). With no catch at all a refusal,
      // the monthly limit included, cleared the page and said nothing.
      setError(apiErrorMessage(e, t("screening.error")));
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!master?.resume) return <ResumeGate feature={t("screening.gateFeature")} />;

  return (
    <ToolShell
      title={t("cards.screening.title")}
      subtitle={t("screening.subtitle")}
      icon={<MessageSquareText className="text-accent-soft" />}
    >
      <Card>
        <label className="mb-1 block text-xs text-ink-muted">{t("screening.presetLabel")}</label>
        <select
          className={input}
          value=""
          onChange={(e) => {
            if (e.target.value) setQuestion(t(`screening.presets.${e.target.value}`));
          }}
        >
          <option value="">{t("screening.presetPlaceholder")}</option>
          {PRESETS.map((p) => (
            <option key={p} value={p}>
              {t(`screening.presets.${p}`)}
            </option>
          ))}
        </select>

        <label className="mb-1 mt-3 block text-xs text-ink-muted">{t("screening.question")}</label>
        <textarea
          dir="auto"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t("screening.questionPlaceholder")}
          className="min-h-[80px] w-full resize-y rounded-lg border border-line bg-bg-soft p-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
        />

        <label className="mb-1 mt-3 block text-xs text-ink-muted">{t("screening.jdTitle")}</label>
        <textarea
          dir="auto"
          value={jdText}
          onChange={(e) => setJdText(e.target.value)}
          placeholder={t("screening.jdPlaceholder")}
          className="min-h-[80px] w-full resize-y rounded-lg border border-line bg-bg-soft p-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
        />

        <Button
          className="mt-4"
          loading={running}
          disabled={!question.trim() || uses.out}
          icon={<Sparkles size={16} />}
          onClick={run}
        >
          {t("screening.draft")}
        </Button>
        <UsesNote feature="screening" className="mt-2" />
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </Card>

      {running && <Skeleton className="h-48 w-full" />}

      {result && !running && (
        <Card>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>{t("screening.answer")}</CardTitle>
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy size={13} />}
              className="tap-44"
              onClick={() => {
                navigator.clipboard.writeText(result.answer);
                toast("success", t("screening.copied"));
              }}
            >
              {t("common:actions.copy")}
            </Button>
          </div>
          <div
            className="mt-2 whitespace-pre-wrap rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink"
            dir="auto"
          >
            {result.answer}
          </div>
          {result.tips.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {result.tips.map((tip, i) => (
                <p key={i} className="flex items-start gap-2 text-xs text-ink-muted" dir="auto">
                  <Lightbulb size={13} className="mt-0.5 shrink-0 text-warn" /> {tip}
                </p>
              ))}
            </div>
          )}
        </Card>
      )}
    </ToolShell>
  );
}
