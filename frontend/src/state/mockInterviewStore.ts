// Module-level store for the mock-interview session (PLAN 11.3) so an
// in-progress interview survives route changes — same pattern as
// jobSearchStore. The backend is stateless; this store owns the transcript
// and sends it whole with every turn.
import { interviewChat, interviewScorecard } from "../api/client";
import { apiErrorMessage, sizeLimitKind } from "../lib/apiError";
import type { ChatTurn, InterviewScorecardResult, ResumeModel } from "../types";

export type MockInterviewState = {
  started: boolean;
  turns: ChatTurn[];
  sending: boolean; // waiting for the interviewer's next message
  ending: boolean; // waiting for the scorecard
  done: boolean; // the interviewer closed its arc — nudge toward the scorecard
  scorecard: InterviewScorecardResult | null;
  error: string;
  // An answer the server refused, handed back for the draft (P30-PASS-SIZE).
  // The page moves it into its text box with takeReturnedAnswer().
  returned: string;
  // The server refused the transcript as too long (a 413 of kind "transcript"):
  // no further answer can be sent, and End still scores what was accepted.
  full: boolean;
};

const initial: MockInterviewState = {
  started: false,
  turns: [],
  sending: false,
  ending: false,
  done: false,
  scorecard: null,
  error: "",
  returned: "",
  full: false,
};

let state: MockInterviewState = { ...initial };
// The resume/JD are captured at session start so every later turn and the
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

/** `answer` is the candidate turn this call appended, if any (the opener has none).
 *
 * On ANY failure that turn comes back OUT of the transcript and is handed to the
 * draft (P30-PASS-SIZE). It used to stay in `turns`, so the interviewer never
 * answered it while every later call re-sent it — a retry after a size refusal
 * was refused again and spent another of the pass's calls each time. A 413 of
 * kind "transcript" also marks the session full: the next answer would be
 * refused the same way, so Send stops offering it and End scores the rest. */
async function fetchNextTurn(id: number, answer?: ChatTurn): Promise<void> {
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
    const last = state.turns[state.turns.length - 1];
    const handBack = answer !== undefined && last === answer;
    set({
      sending: false,
      error: apiErrorMessage(e, "Something went wrong."),
      ...(handBack ? { turns: state.turns.slice(0, -1), returned: answer.text } : {}),
      ...(sizeLimitKind(e) === "transcript" ? { full: true } : {}),
    });
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
  if (!answer || state.sending || state.ending || state.full || !sessionResume) return;
  const id = seq;
  const turn: ChatTurn = { role: "candidate", text: answer };
  set({
    turns: [...state.turns, turn],
    sending: true,
    error: "",
    returned: "",
  });
  void fetchNextTurn(id, turn);
}

/** The answer the server refused, once: the page puts it back into its text
 * box, and the store forgets it so a later render cannot restore it twice. */
export function takeReturnedAnswer(): string {
  const text = state.returned;
  if (text) set({ returned: "" });
  return text;
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
