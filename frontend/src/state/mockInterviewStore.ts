// Module-level store for the mock-interview session (PLAN 11.3) so an
// in-progress interview survives route changes — same pattern as
// jobSearchStore. The backend is stateless; this store owns the transcript
// and sends it whole with every turn.
import { interviewChat, interviewScorecard } from "../api/client";
import { apiErrorMessage } from "../lib/apiError";
import type { ChatTurn, InterviewScorecardResult, ResumeModel } from "../types";

export type MockInterviewState = {
  started: boolean;
  turns: ChatTurn[];
  sending: boolean; // waiting for the interviewer's next message
  ending: boolean; // waiting for the scorecard
  done: boolean; // the interviewer closed its arc — nudge toward the scorecard
  scorecard: InterviewScorecardResult | null;
  error: string;
};

const initial: MockInterviewState = {
  started: false,
  turns: [],
  sending: false,
  ending: false,
  done: false,
  scorecard: null,
  error: "",
};

let state: MockInterviewState = { ...initial };
// The résumé/JD are captured at session start so every later turn and the
// scorecard are judged against the same context, even if the page's JD box
// changes mid-session.
let sessionResume: ResumeModel | null = null;
let sessionJd = "";

const listeners = new Set<() => void>();

function set(patch: Partial<MockInterviewState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getMockInterviewState(): MockInterviewState {
  return state;
}

export function subscribeMockInterview(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let seq = 0; // a restarted session must not be overwritten by a stale response

export function resetMockInterview(): void {
  seq++;
  sessionResume = null;
  sessionJd = "";
  state = { ...initial };
  listeners.forEach((l) => l());
}

async function fetchNextTurn(id: number): Promise<void> {
  if (!sessionResume) return;
  try {
    const r = await interviewChat(sessionResume, sessionJd, state.turns);
    if (id !== seq) return;
    set({
      sending: false,
      done: r.done,
      turns: r.message ? [...state.turns, { role: "interviewer", text: r.message }] : state.turns,
    });
  } catch (e: unknown) {
    if (id !== seq) return;
    set({ sending: false, error: apiErrorMessage(e, "Something went wrong.") });
  }
}

export function startMockInterview(resume: ResumeModel, jdText: string): void {
  const id = ++seq;
  sessionResume = resume;
  sessionJd = jdText;
  state = { ...initial, started: true, sending: true };
  listeners.forEach((l) => l());
  void fetchNextTurn(id);
}

export function sendMockAnswer(text: string): void {
  const answer = text.trim();
  if (!answer || state.sending || state.ending || !sessionResume) return;
  const id = seq;
  set({
    turns: [...state.turns, { role: "candidate", text: answer }],
    sending: true,
    error: "",
  });
  void fetchNextTurn(id);
}

export function endMockInterview(): void {
  if (state.ending || !sessionResume) return;
  if (!state.turns.some((t) => t.role === "candidate")) return;
  const id = seq;
  set({ ending: true, error: "" });
  interviewScorecard(sessionResume, sessionJd, state.turns)
    .then((card) => {
      if (id === seq) set({ ending: false, scorecard: card });
    })
    .catch((e: unknown) => {
      if (id === seq) set({ ending: false, error: apiErrorMessage(e, "Something went wrong.") });
    });
}
