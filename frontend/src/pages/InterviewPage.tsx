import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MessageSquareText, Sparkles, Lightbulb, ClipboardCheck } from "lucide-react";
import { analyzeJD, interviewAnswer, interviewFeedback, interviewQuestions } from "../api/client";
import JDPaste from "../components/JDPaste";
import ResumeGate from "../components/ResumeGate";
import { useMasterResume } from "../hooks/useMasterResume";
import { Badge, Button, Card, CardTitle, Skeleton } from "../components/ui";
import type {
  InterviewFeedbackResult,
  InterviewQuestion,
  JDModel,
  ResumeModel,
} from "../types";

const catTone: Record<string, "accent" | "mint" | "partial" | "neutral"> = {
  behavioral: "accent",
  technical: "mint",
  "role-specific": "partial",
  culture: "neutral",
};

function QuestionCard({ q, resume, jd }: { q: InterviewQuestion; resume: ResumeModel; jd: JDModel }) {
  const [answer, setAnswer] = useState("");
  const [tips, setTips] = useState<string[]>([]);
  const [loadingA, setLoadingA] = useState(false);
  const [practice, setPractice] = useState("");
  const [feedback, setFeedback] = useState<InterviewFeedbackResult | null>(null);
  const [loadingF, setLoadingF] = useState(false);

  async function getAnswer() {
    setLoadingA(true);
    try {
      const r = await interviewAnswer(resume, jd, q.question);
      setAnswer(r.answer);
      setTips(r.tips);
    } finally {
      setLoadingA(false);
    }
  }

  async function getFeedback() {
    if (practice.trim().length < 10) return;
    setLoadingF(true);
    try {
      setFeedback(await interviewFeedback(resume, q.question, practice));
    } finally {
      setLoadingF(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium text-ink">{q.question}</p>
        {q.category && <Badge tone={catTone[q.category] ?? "neutral"}>{q.category}</Badge>}
      </div>
      {q.rationale && <p className="mt-1 text-xs text-ink-muted">{q.rationale}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" loading={loadingA} icon={<Lightbulb size={14} />} onClick={getAnswer}>
          {answer ? "Regenerate answer" : "Model answer"}
        </Button>
      </div>

      {answer && (
        <div className="mt-3 rounded-lg border border-line bg-bg-soft p-3 text-sm leading-relaxed text-ink">
          {answer}
          {tips.length > 0 && (
            <ul className="mt-2 list-disc ps-5 text-xs text-ink-muted">
              {tips.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-4">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">Practice your answer</p>
        <textarea
          value={practice}
          onChange={(e) => setPractice(e.target.value)}
          placeholder="Type your answer, then get feedback…"
          className="min-h-[90px] w-full resize-y rounded-lg border border-line bg-bg-soft p-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
        />
        <Button
          size="sm"
          className="mt-2"
          loading={loadingF}
          disabled={practice.trim().length < 10}
          icon={<ClipboardCheck size={14} />}
          onClick={getFeedback}
        >
          Get feedback
        </Button>
      </div>

      {feedback && (
        <div className="mt-3 space-y-2 rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold tabular-nums text-ink">{Math.round(feedback.score)}</span>
            <span className="text-xs text-ink-muted">/ 100</span>
          </div>
          {feedback.strengths.length > 0 && (
            <div>
              <span className="text-xs font-semibold text-mint">Strengths</span>
              <ul className="list-disc ps-5 text-ink-muted">
                {feedback.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {feedback.improvements.length > 0 && (
            <div>
              <span className="text-xs font-semibold text-warn">Improve</span>
              <ul className="list-disc ps-5 text-ink-muted">
                {feedback.improvements.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {feedback.revised_answer && (
            <div>
              <span className="text-xs font-semibold text-accent-soft">Revised</span>
              <p className="text-ink">{feedback.revised_answer}</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export default function InterviewPage() {
  const { master, loading } = useMasterResume();
  const [jdText, setJdText] = useState("");
  const [jd, setJd] = useState<JDModel | null>(null);
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  async function generate() {
    if (!master?.resume || jdText.trim().length < 30) return;
    setError("");
    setRunning(true);
    setQuestions([]);
    try {
      const analyzed = await analyzeJD(jdText);
      setJd(analyzed);
      const r = await interviewQuestions(master.resume, analyzed);
      setQuestions(r.questions);
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Something went wrong.");
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!master?.resume) return <ResumeGate feature="interview prep" />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
          <MessageSquareText className="text-accent-soft" /> Interview prep
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Likely questions, model answers grounded in your real experience, and feedback on your practice.
        </p>
      </div>

      <Card>
        <CardTitle>Target job description</CardTitle>
        <div className="mt-3">
          <JDPaste value={jdText} onChange={setJdText} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button loading={running} icon={<Sparkles size={16} />} disabled={jdText.trim().length < 30} onClick={generate}>
            Generate questions
          </Button>
          {error && <span className="text-sm text-danger">{error}</span>}
        </div>
      </Card>

      {running && (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}

      <AnimatePresence>
        {questions.length > 0 && jd && !running && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            {questions.map((q, i) => (
              <QuestionCard key={i} q={q} resume={master.resume} jd={jd} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
