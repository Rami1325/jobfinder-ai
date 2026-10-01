import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { ArrowLeft, MessageSquareText, Sparkles, Lightbulb, ClipboardCheck, Mic, Wallet, Building2 } from "lucide-react";
import {
  analyzeJD,
  interviewAnswer,
  interviewFeedback,
  interviewQuestions,
  recruiterScreen,
} from "../api/client";
import { DictateButton, DictationNote, ListeningBadge } from "../components/Dictation";
import JDPaste from "../components/JDPaste";
import ResumeGate from "../components/ResumeGate";
import UsesNote from "../components/UsesNote";
import MockInterview from "./interview/MockInterview";
import { useDictation } from "../hooks/useDictation";
import { useJobContext } from "../hooks/useJobContext";
import { useMasterResume } from "../hooks/useMasterResume";
import { apiErrorMessage } from "../lib/apiError";
import { cn } from "../lib/cn";
import { useUses } from "../lib/usesStore";
import { Badge, Button, Card, CardTitle, CountUp, Skeleton } from "../components/ui";
import TypeText from "../components/ui/TypeText";
import type {
  InterviewFeedbackResult,
  InterviewQuestion,
  JDModel,
  RecruiterScreenResult,
  ResumeModel,
} from "../types";

type Mode = "questions" | "recruiter" | "mock";

const catTone: Record<string, "accent" | "mint" | "partial" | "neutral"> = {
  behavioral: "accent",
  technical: "mint",
  "role-specific": "partial",
  culture: "neutral",
};

function QuestionCard({
  q,
  resume,
  jd,
  typeDelay = 0,
}: {
  q: InterviewQuestion;
  resume: ResumeModel;
  jd: JDModel;
  /** Stagger offset (ms) for the question's typewriter reveal. */
  typeDelay?: number;
}) {
  const { t } = useTranslation("interview");
  const [answer, setAnswer] = useState("");
  const [tips, setTips] = useState<string[]>([]);
  const [loadingA, setLoadingA] = useState(false);
  const [errorA, setErrorA] = useState("");
  const [practice, setPractice] = useState("");
  const [feedback, setFeedback] = useState<InterviewFeedbackResult | null>(null);
  const [loadingF, setLoadingF] = useState(false);
  const [errorF, setErrorF] = useState("");
  // The practice answer can be spoken (docs/handbook/interview.md): the browser's
  // own speech recognition writes it into the box, after what was typed, in the
  // question's language. Get feedback stays the only thing that sends it.
  const dictation = useDictation({ value: practice, onChange: setPractice, question: q.question });

  // Both ride the practice session the questions opened (Phase 30 / B5): never
  // disabled mid-session, and a refusal, the monthly limit included, is said
  // under the button that got it. With no catch at all it said nothing.
  async function getAnswer() {
    setLoadingA(true);
    setErrorA("");
    try {
      const r = await interviewAnswer(resume, jd, q.question);
      setAnswer(r.answer);
      setTips(r.tips);
    } catch (e) {
      setErrorA(apiErrorMessage(e, t("genericError")));
    } finally {
      setLoadingA(false);
    }
  }

  async function getFeedback() {
    if (practice.trim().length < 10) return;
    // What is graded is what the box shows: no word may land after the send.
    dictation.cancel();
    setLoadingF(true);
    setErrorF("");
    try {
      setFeedback(await interviewFeedback(resume, q.question, practice));
    } catch (e) {
      setErrorF(apiErrorMessage(e, t("genericError")));
    } finally {
      setLoadingF(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium text-ink" dir="auto">
          <TypeText text={q.question} delay={typeDelay} />
        </p>
        {q.category && (
          <Badge tone={catTone[q.category] ?? "neutral"}>
            {t(`categories.${q.category}`, { defaultValue: q.category })}
          </Badge>
        )}
      </div>
      {q.rationale && (
        <p className="mt-1 text-xs text-ink-muted" dir="auto">
          {q.rationale}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" loading={loadingA} icon={<Lightbulb size={14} />} onClick={getAnswer} className="tap-44">
          {answer ? t("regenerateAnswer") : t("modelAnswer")}
        </Button>
      </div>
      <UsesNote feature="interview" inSession className="mt-1.5" />
      {errorA && <p className="mt-2 text-sm text-danger">{errorA}</p>}

      {answer && (
        <div className="mt-3 rounded-lg border border-line bg-bg-soft p-3 text-sm leading-relaxed text-ink">
          {answer}
          {tips.length > 0 && (
            <ul className="mt-2 list-disc ps-5 text-xs text-ink-muted">
              {tips.map((tip, i) => (
                <li key={i}>{tip}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-4">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
          {t("practice.label")}
        </p>
        <div className="relative">
          <textarea
            value={practice}
            onChange={(e) => setPractice(e.target.value)}
            readOnly={dictation.listening}
            placeholder={t("practice.placeholder")}
            dir="auto"
            className="block min-h-[90px] w-full resize-y rounded-lg border border-line bg-bg-soft p-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
          />
          <ListeningBadge dictation={dictation} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <DictateButton dictation={dictation} />
          <Button
            size="sm"
            loading={loadingF}
            disabled={practice.trim().length < 10}
            icon={<ClipboardCheck size={14} />}
            onClick={getFeedback}
            className="tap-44"
          >
            {t("practice.cta")}
          </Button>
        </div>
        <DictationNote dictation={dictation} className="mt-1.5" />
        <UsesNote feature="interview" inSession className="mt-1.5" />
        {errorF && <p className="mt-2 text-sm text-danger">{errorF}</p>}
      </div>

      {feedback && (
        <div className="mt-3 space-y-2 rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
          <div className="flex items-center gap-2">
            <CountUp
              to={Math.round(feedback.score)}
              duration={0.8}
              className="text-2xl font-bold tabular-nums text-ink"
            />
            <span className="text-xs text-ink-muted">{t("feedback.outOf")}</span>
          </div>
          {feedback.strengths.length > 0 && (
            <div>
              <span className="text-xs font-semibold text-mint">{t("feedback.strengths")}</span>
              <ul className="list-disc ps-5 text-ink-muted">
                {feedback.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {feedback.improvements.length > 0 && (
            <div>
              <span className="text-xs font-semibold text-warn">{t("feedback.improve")}</span>
              <ul className="list-disc ps-5 text-ink-muted">
                {feedback.improvements.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {feedback.revised_answer && (
            <div>
              <span className="text-xs font-semibold text-accent-soft">{t("feedback.revised")}</span>
              <p className="text-ink">{feedback.revised_answer}</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

const MODES: readonly Mode[] = ["questions", "recruiter", "mock"];

export default function InterviewPage() {
  const { t } = useTranslation("interview");
  const { t: tTools } = useTranslation("tools");
  const nav = useNavigate();
  const { master, loading } = useMasterResume();
  // Opened from a job's page (PLAN 31.4/3): `?app=` names the job, whose posting
  // fills the box, and `?mode=` the tab it asked for (Mock interview has its own
  // link there). Both survive a reload; Back returns to the job.
  const ctx = useJobContext();
  const job = ctx?.job ?? null;
  const [params] = useSearchParams();
  const asked = params.get("mode");
  const [mode, setMode] = useState<Mode>(MODES.find((m) => m === asked) ?? "questions");
  const [jdText, setJdText] = useState("");
  useEffect(() => {
    if (job?.jd_text) setJdText((cur) => cur || job.jd_text);
  }, [job]);
  const [jd, setJd] = useState<JDModel | null>(null);
  // The text the questions on screen were written for. The posting folds to one
  // line only while the box still holds exactly that (PLAN 31.2/9).
  const [analyzedFor, setAnalyzedFor] = useState("");
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [recruiter, setRecruiter] = useState<RecruiterScreenResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  // Questions and the recruiter screen each open a practice session, 1 use for
  // up to 3 hours (Phase 30 / B5); while one is open this button stays enabled.
  const uses = useUses("interview");

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
      setAnalyzedFor(jdText);
    } catch (e: any) {
      setError(apiErrorMessage(e, t("genericError")));
    } finally {
      setRunning(false);
    }
  }

  async function buildRecruiter() {
    if (!master?.resume || jdText.trim().length < 30) return;
    setError("");
    setRunning(true);
    setRecruiter(null);
    try {
      setRecruiter(await recruiterScreen(master.resume, jdText));
    } catch (e: any) {
      setError(apiErrorMessage(e, t("genericError")));
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!master?.resume) return <ResumeGate feature={t("gateFeature")} />;

  return (
    <div className="space-y-6">
      <div>
        {ctx && (
          <Link
            to={ctx.backTo}
            className="tap-44 mb-3 inline-flex min-h-9 items-center gap-1 text-xs text-ink-muted hover:text-ink"
          >
            <ArrowLeft size={13} className="rtl:-scale-x-100" /> {tTools("backToJob")}
          </Link>
        )}
        <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
          <MessageSquareText className="text-accent-soft" /> {t("title")}
        </h1>
        <p className="mt-1 hidden text-sm text-ink-muted sm:block">{t("sub")}</p>
      </div>

      {/* The modes and Company brief wear `tap-44` at their 34 px (the third
          tap-target pass): 5 px of layer, and wrapped rows 10 px apart. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
        {(["questions", "recruiter", "mock"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              "tap-44 rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors",
              mode === m
                ? "border-accent/60 bg-accent/10 text-ink"
                : "border-line text-ink-muted hover:text-ink",
            )}
          >
            {t(`mode.${m}`)}
          </button>
        ))}
        <button
          onClick={() =>
            // Still about the same job: `?app=` goes along, so the brief can
            // return to the job's page as this one does.
            nav(ctx ? `/tools/company-brief?app=${ctx.id}` : "/tools/company-brief", {
              state: {
                jdText,
                company: jd?.company || job?.company,
                jobTitle: jd?.job_title || job?.job_title,
              },
            })
          }
          className="tap-44 ms-auto inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-semibold text-ink-muted transition-colors hover:border-accent/50 hover:text-accent-soft"
        >
          <Building2 size={14} /> {t("companyBrief")}
        </button>
      </div>

      <Card>
        <CardTitle>{t("jdTitle")}</CardTitle>
        <div className="mt-3">
          <JDPaste
            value={jdText}
            onChange={setJdText}
            folded={
              mode === "questions" && jd && questions.length > 0 && analyzedFor === jdText
                ? { title: jd.job_title, company: jd.company }
                : null
            }
          />
        </div>
        {mode === "mock" ? (
          <p className="mt-3 text-xs text-ink-faint">{t("mock.jdOptional")}</p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                loading={running}
                icon={<Sparkles size={16} />}
                disabled={jdText.trim().length < 30 || uses.out}
                onClick={mode === "questions" ? generate : buildRecruiter}
              >
                {mode === "questions" ? t("generate") : t("recruiter.build")}
              </Button>
              {error && <span className="text-sm text-danger">{error}</span>}
            </div>
            <UsesNote feature="interview" className="mt-2" />
          </>
        )}
      </Card>

      {mode === "mock" && <MockInterview resume={master.resume} jdText={jdText} />}

      {running && (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}

      {mode === "questions" && (
        <AnimatePresence>
          {questions.length > 0 && jd && !running && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
              {questions.map((q, i) => (
                <QuestionCard key={i} q={q} resume={master.resume} jd={jd} typeDelay={i * 150} />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      )}

      {mode === "recruiter" && recruiter && !running && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          {recruiter.pitch && (
            <Card>
              <CardTitle className="flex items-center gap-2">
                <Mic size={16} className="text-accent-soft" /> {t("recruiter.pitch")}
              </CardTitle>
              <p className="mt-2 text-sm leading-relaxed text-ink" dir="auto">
                {recruiter.pitch}
              </p>
            </Card>
          )}
          {recruiter.items.map((it, i) => (
            <Card key={i}>
              <p className="font-medium text-ink" dir="auto">
                <TypeText text={it.question} delay={i * 150} />
              </p>
              <p className="mt-1 text-sm text-ink-muted" dir="auto">
                {it.talking_point}
              </p>
            </Card>
          ))}
          {recruiter.salary_note && (
            <Card className="border-warn/30 bg-warn/5">
              <CardTitle className="flex items-center gap-2">
                <Wallet size={16} className="text-warn" /> {t("recruiter.salary")}
              </CardTitle>
              <p className="mt-2 text-sm leading-relaxed text-ink" dir="auto">
                {recruiter.salary_note}
              </p>
              <p className="mt-2 text-xs text-ink-faint">{t("recruiter.salaryCaveat")}</p>
            </Card>
          )}
        </motion.div>
      )}
    </div>
  );
}
