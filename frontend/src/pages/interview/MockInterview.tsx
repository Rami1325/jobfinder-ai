// Multi-turn mock interview (PLAN 11.3): live chat with an interviewer
// grounded in the resume + JD, then a session scorecard. The session lives in
// mockInterviewStore, so it survives navigating away mid-interview.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { ClipboardCheck, Mic, RotateCcw, Send } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  endMockInterview,
  getMockInterviewState,
  resetMockInterview,
  sendMockAnswer,
  startMockInterview,
  subscribeMockInterview,
  takeReturnedAnswer,
} from "../../state/mockInterviewStore";
import { Button, Card, CardTitle, ProgressRing } from "../../components/ui";
import UsesNote from "../../components/UsesNote";
import { useUses } from "../../lib/usesStore";
import type { ResumeModel } from "../../types";

export default function MockInterview({
  resume,
  jdText,
}: {
  resume: ResumeModel;
  jdText: string;
}) {
  const { t } = useTranslation("interview");
  const { started, turns, sending, ending, done, scorecard, error, returned, full } = useSyncExternalStore(
    subscribeMockInterview,
    getMockInterviewState,
  );
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  // A whole practice session is 1 use (Phase 30 / B5). Only Start can be out of
  // uses: Send and End ride the session it opened and are never disabled for
  // uses, and a refusal on either lands in `error` below. Send IS disabled once
  // the session is full (P30-PASS-SIZE): the server refused the transcript as too
  // long, so any further answer would be refused again.
  const uses = useUses("interview");

  // An answer the server refused comes back into the text box, so it can be
  // shortened and sent again instead of being lost (P30-PASS-SIZE). Write only
  // what was taken: StrictMode runs a mounting page's effects twice with the same
  // `returned`, and the second take is "" (check-mirrors 34).
  useEffect(() => {
    const text = takeReturnedAnswer();
    if (text) setDraft(text);
  }, [returned]);

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [turns.length, sending, scorecard]);

  const answered = turns.some((x) => x.role === "candidate");

  function submit() {
    if (!draft.trim() || sending || ending || full || scorecard) return;
    sendMockAnswer(draft);
    setDraft("");
  }

  if (!started) {
    return (
      <Card>
        <CardTitle className="flex items-center gap-2">
          <Mic size={16} className="text-accent-soft" /> {t("mock.title")}
        </CardTitle>
        <p className="mt-2 text-sm text-ink-muted">{t("mock.intro")}</p>
        <Button
          className="mt-4"
          icon={<Mic size={16} />}
          disabled={uses.out}
          onClick={() => startMockInterview(resume, jdText)}
        >
          {t("mock.start")}
        </Button>
        <UsesNote feature="interview" className="mt-2" />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="max-h-[26rem] space-y-3 overflow-y-auto pe-1">
          {turns.map((turn, i) => (
            <motion.div
              key={`${i}-${turn.role}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className={cn("flex", turn.role === "candidate" ? "justify-end" : "justify-start")}
            >
              <p
                dir="auto"
                className={cn(
                  "max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                  turn.role === "candidate"
                    ? "rounded-ee-md bg-accent/15 text-ink"
                    : "rounded-ss-md border border-line bg-panel-2/60 text-ink",
                )}
              >
                {turn.text}
              </p>
            </motion.div>
          ))}
          {(sending || ending) && (
            <p className="text-xs text-ink-faint" aria-live="polite">
              {ending ? t("mock.scoring") : t("mock.thinking")}
            </p>
          )}
          <div ref={endRef} />
        </div>

        {!scorecard && (
          <>
            {done && <p className="mt-3 text-xs text-mint">{t("mock.doneNote")}</p>}
            <div className="mt-3 flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder={t("mock.placeholder")}
                dir="auto"
                rows={2}
                disabled={sending || ending}
                className="min-h-[3rem] flex-1 resize-y rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none disabled:opacity-50"
              />
              <Button
                size="sm"
                icon={<Send size={14} />}
                disabled={!draft.trim() || sending || ending || full}
                onClick={submit}
              >
                {t("mock.send")}
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant="secondary"
                icon={<ClipboardCheck size={14} />}
                loading={ending}
                disabled={!answered || sending}
                onClick={endMockInterview}
              >
                {t("mock.end")}
              </Button>
              <button
                onClick={resetMockInterview}
                className="inline-flex items-center gap-1.5 text-xs text-ink-faint transition-colors hover:text-ink"
              >
                <RotateCcw size={12} /> {t("mock.restart")}
              </button>
              {error && <span className="text-sm text-danger">{error}</span>}
            </div>
            <UsesNote feature="interview" inSession className="mt-2" />
          </>
        )}
      </Card>

      {scorecard && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          <Card>
            <CardTitle className="flex items-center gap-2">
              <ClipboardCheck size={16} className="text-accent-soft" /> {t("mock.scorecard")}
            </CardTitle>
            <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
              <ProgressRing value={scorecard.overall} size={92} stroke={8} label={t("mock.overall")} />
              <p className="text-sm leading-relaxed text-ink" dir="auto">
                {scorecard.summary}
              </p>
            </div>
          </Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardTitle>{t("mock.strengths")}</CardTitle>
              <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-ink">
                {scorecard.strengths.map((s, i) => (
                  <li key={i} dir="auto">{s}</li>
                ))}
              </ul>
            </Card>
            <Card>
              <CardTitle>{t("mock.improvements")}</CardTitle>
              <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-ink">
                {scorecard.improvements.map((s, i) => (
                  <li key={i} dir="auto">{s}</li>
                ))}
              </ul>
            </Card>
          </div>
          {scorecard.question_feedback.length > 0 && (
            <Card>
              <CardTitle>{t("mock.perQuestion")}</CardTitle>
              <div className="mt-2 space-y-3">
                {scorecard.question_feedback.map((q, i) => (
                  <div key={i}>
                    <p className="text-sm font-medium text-ink" dir="auto">{q.question}</p>
                    <p className="mt-0.5 text-sm text-ink-muted" dir="auto">{q.feedback}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}
          <Button size="sm" variant="secondary" icon={<RotateCcw size={14} />} onClick={resetMockInterview}>
            {t("mock.restart")}
          </Button>
        </motion.div>
      )}
    </div>
  );
}
