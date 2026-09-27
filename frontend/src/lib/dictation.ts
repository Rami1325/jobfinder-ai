// Answering out loud (PLAN Phase 32, "Answer out loud", 2026-09-27): a mic on
// every box where the user types an interview answer, through the browser's OWN
// speech recognition (the Web Speech API: `SpeechRecognition`, or Chrome's and
// Safari's `webkitSpeechRecognition`).
//
// What this adds on the server: nothing. No model call, no route, no audio. The
// browser sends the sound to its own speech service (Google's in Chrome, Apple's
// in Safari) and hands back words, which this module writes into the box. It
// SENDS nothing: the page's Send and Get feedback stay the only way an answer
// leaves the browser, and each cancels the mic first, so what goes is exactly
// what the box showed.
//
// Framework-free on purpose: check-mirrors 90 EXECUTES `createDictation` against
// a scripted recognizer, and check-mirrors 89 forbids any network call in this
// file, `hooks/useDictation.ts` and `components/Dictation.tsx`. The record is
// docs/handbook/interview.md.

import { proseLanguage } from "./lang";

/** The cap the backend enforces on one answer, in KB of UTF-8 (1024 bytes):
 * `max_answer_kb` in backend/app/config.py, which measures a practice answer and
 * each candidate turn of the mock interview (`prompts._MEASURED`). The mic stops
 * before the box passes it, so dictation alone can never draw the 413 of kind
 * `answer`. check-mirrors 89 holds this number to the backend's default. */
export const MAX_ANSWER_KB = 16;

/** Why the mic stopped, when the person should be told. Each has its sentence at
 * `dictate.note.<kind>` in both interview.json files (check-mirrors 89). */
export type DictationNote = "denied" | "service" | "noSpeech" | "network" | "noMic" | "cap" | "stopped" | "failed";

export type DictationLang = "he-IL" | "en-US";

// The part of the Web Speech API this uses. TypeScript's DOM library carries no
// SpeechRecognition types (Chrome still ships it prefixed), so they live here.
export interface SpeechAlternative {
  transcript: string;
  confidence: number;
}
export interface SpeechResult {
  readonly length: number;
  readonly isFinal: boolean;
  readonly [index: number]: SpeechAlternative;
}
export interface SpeechResultList {
  readonly length: number;
  readonly [index: number]: SpeechResult;
}
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { resultIndex: number; results: SpeechResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type RecognitionCtor = new () => Recognition;

/** The recognizer this browser has, or null (Firefox, and any browser without
 * one): the mic is then not drawn at all. Feature detection only, never the user
 * agent: a list of browsers would be wrong about the next one, and a browser
 * that has the API but cannot use it here (Safari with Dictation off, an app's
 * embedded browser) answers `start()` with an error the page puts in words. */
export function recognitionCtor(win: unknown): RecognitionCtor | null {
  if (!win || typeof win !== "object") return null;
  const w = win as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as RecognitionCtor) : null;
}

/** The language to listen for: the question's, when it has words to read, and
 * otherwise the interface's. An answer is spoken in the language it was asked
 * in, whichever way round that is from the interface. */
export function dictationLang(uiLanguage: string | undefined, question?: string | null): DictationLang {
  const asked = question ? proseLanguage(question) : null;
  const ui = (uiLanguage || "en").toLowerCase().startsWith("he") ? "he" : "en";
  return (asked ?? ui) === "he" ? "he-IL" : "en-US";
}

/** A recognizer's error, as what the person is told. `aborted` is our own
 * cancel, so it says nothing. */
export function noteFor(error: string): DictationNote | null {
  switch (error) {
    case "aborted":
      return null;
    case "not-allowed":
      return "denied";
    case "service-not-allowed":
      return "service";
    case "no-speech":
      return "noSpeech";
    case "network":
      return "network";
    case "audio-capture":
      return "noMic";
    default:
      return "failed";
  }
}

/** Measured the way the server measures it, in UTF-8 bytes, so a Hebrew answer
 * (about two bytes a letter) meets the cap where the server's 413 would. A cap
 * of 0 or less is off, as it is on the server. */
export function fitsAnswerCap(text: string, capKb: number = MAX_ANSWER_KB): boolean {
  return capKb <= 0 || new TextEncoder().encode(text).length <= capKb * 1024;
}

/** Everything heard in one listening session, in order: the settled words and
 * the ones still being guessed. Rebuilt from the whole list on every event,
 * which is how Chrome and Safari both report it. Chrome on Android repeats
 * earlier words as extra final results with a confidence of 0, so there those
 * are skipped. */
export function heardText(results: SpeechResultList, android = false): string {
  const parts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const best = result?.[0];
    if (!best) continue;
    if (android && result.isFinal && best.confidence === 0) continue;
    parts.push(best.transcript);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** The box while dictating: what it held when the mic opened, then what was
 * heard, with one space between them unless the typed text already ends in
 * one. Never anything else: the typed text is a prefix of every value this
 * returns. */
export function joinDictation(base: string, heard: string): string {
  if (!heard) return base;
  if (!base || /\s$/.test(base)) return base + heard;
  return `${base} ${heard}`;
}

export interface DictationState {
  listening: boolean;
  note: DictationNote | null;
}

export interface DictationOptions {
  ctor: RecognitionCtor;
  /** The box's text now. */
  read: () => string;
  /** Put this text in the box. */
  write: (text: string) => void;
  /** The language to listen for, read at every (re)start. */
  lang: () => DictationLang;
  onState: (state: DictationState) => void;
  capKb?: number;
  android?: boolean;
}

export interface DictationController {
  /** The person tapped the mic on. */
  start(): void;
  /** The person tapped it off, or the page went to the background: the words
   * already on their way still land, and nothing more is heard. */
  stop(): void;
  /** Stop now and let every later word go: before an answer is sent, and when
   * the box goes away. What the box shows is what stays. */
  cancel(): void;
}

export function createDictation(o: DictationOptions): DictationController {
  // The session whose events count. A session let go of is never written from.
  let rec: Recognition | null = null;
  // On until the person taps it off, it is cancelled, or it fails.
  let wanted = false;
  let base = ""; // the box when this session opened
  let written = ""; // what this module last put in the box
  let heard = false; // this session heard words
  let state: DictationState = { listening: false, note: null };

  const emit = (patch: Partial<DictationState>) => {
    state = { ...state, ...patch };
    o.onState(state);
  };

  const end = (note: DictationNote | null) => {
    wanted = false;
    const r = rec;
    rec = null;
    if (r) {
      try {
        r.abort();
      } catch {
        // it had ended already
      }
    }
    emit({ listening: false, note });
  };

  const open = (): boolean => {
    let r: Recognition;
    try {
      r = new o.ctor();
      r.lang = o.lang();
      r.continuous = true;
      r.interimResults = true;
      r.maxAlternatives = 1;
    } catch {
      return false;
    }
    base = o.read();
    written = base;
    heard = false;
    r.onresult = (event) => {
      if (rec !== r) return;
      // The page changed the box (an answer sent, a line typed after the mic
      // was tapped off): it is no longer the text this session started from,
      // and writing would put words over what the person did.
      if (o.read() !== written) {
        end(null);
        return;
      }
      const words = heardText(event.results, o.android);
      if (words) heard = true;
      const next = joinDictation(base, words);
      if (next === written) return;
      if (!fitsAnswerCap(next, o.capKb)) {
        end("cap");
        return;
      }
      written = next;
      o.write(next);
    };
    r.onerror = (event) => {
      if (rec !== r) return;
      end(noteFor(event.error));
    };
    r.onend = () => {
      if (rec !== r) return;
      rec = null;
      // A browser ends a continuous session by itself (a pause, its own time
      // limit). While the person still wants the mic and this session heard
      // words, the next one opens from the box as it stands now.
      if (wanted && heard && open()) return;
      const stoppedByItself = wanted;
      wanted = false;
      emit({ listening: false, note: stoppedByItself ? "stopped" : state.note });
    };
    rec = r;
    try {
      r.start();
    } catch {
      rec = null;
      return false;
    }
    return true;
  };

  return {
    start() {
      if (state.listening) return;
      if (!fitsAnswerCap(joinDictation(o.read(), "x"), o.capKb)) {
        emit({ note: "cap" });
        return;
      }
      wanted = true;
      if (!open()) {
        wanted = false;
        emit({ listening: false, note: "failed" });
        return;
      }
      emit({ listening: true, note: null });
    },
    stop() {
      if (!state.listening) return;
      wanted = false;
      const r = rec;
      if (r) {
        try {
          r.stop();
        } catch {
          rec = null;
        }
      }
      emit({ listening: false });
    },
    cancel() {
      if (!rec && !state.listening) return;
      end(null);
    },
  };
}
