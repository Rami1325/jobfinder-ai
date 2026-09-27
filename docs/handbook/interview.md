# The interview page — practice boxes, the mock chat, and answering out loud

> **Handbook file**, started 2026-09-27 with Phase 32's *Answer out loud*. Every bullet records a decision or a
> measurement: edit it the way you would edit code, and add new findings about the interview page here.
>
> **Read before touching** `pages/InterviewPage.tsx`, `pages/interview/**`, `state/mockInterviewStore.ts`,
> `lib/dictation.ts`, `hooks/useDictation.ts` or `components/Dictation.tsx`. What a practice session costs (one use
> for a pass of 3 hours and 60 calls) is in `cost-and-quota.md`; the size caps on a question, an answer and the
> transcript, the refused answer handed back to the draft and the `full` session are in `llm-boundary.md`
> (*Every builder parameter is measured or named*).

### Answer out loud (Phase 32, 2026-09-27)

Google Interview Warmup, loved for spoken, ungraded practice, was retired in April 2026 (PLAN.md Phase 31, *Beyond
this phase*; the owner approved building it on 2026-09-27).

- **Where the mic is: every box where the user types an interview answer, and there are two.** The practice box
  under each question (Get feedback) and the mock interview chat (Send). The model answer and the recruiter screen
  have no box the user types into; the Screening tool's box is a QUESTION the model answers, not the user's answer.
  check-mirrors 89 reads every `<textarea>` on `InterviewPage.tsx` and under `pages/interview/`, so a third answer box
  fails the build until it carries the mic.
- **It adds nothing on the server.** The browser's own speech recognition (`SpeechRecognition`, or Chrome's and
  Safari's `webkitSpeechRecognition`) hears the audio; the browser sends it to its own speech service (Google's in
  Chrome, Apple's in Safari, Microsoft's in Edge) and hands back words. No route, no model call, no audio through
  JobFinder, so what a practice session costs is unchanged: the words go to the model only when the person presses
  Send or Get feedback, as typed words always did. check-mirrors 89 forbids `fetch`, XHR, WebSockets, `sendBeacon`,
  axios, a dynamic import and raw audio capture (`getUserMedia`, `MediaRecorder`, `AudioContext`) in the three mic
  files, holds their imports to a short list, and fails an API client path that mentions speech. The privacy page
  says where the voice goes (`privacy.ai.voice`, both locales, in *AI processing*), and 89 holds the sentence to
  "the browser's own speech recognition … never to JobFinder … only when you send them".
- **The words go AFTER what was typed, never over it.** The box's text when the mic opened is the base, and every
  write is `base + " " + heard` (no space after a box that ends in whitespace), so the typed text is a prefix of
  every value the mic writes. The guessed words (interim results) show as they come and settle in place; a session's
  words are rebuilt from the recognizer's whole result list on every event, which is how Chrome and Safari both
  report them.
- **The box is read-only while the mic writes, and the mic writes only into the text it last wrote.** Typing while
  the mic was on would have to be merged with words still arriving (a guessed phrase the person edited, then
  settled, would be written twice), so the box takes no typing until the mic is tapped off; it is editable at once
  after. The second guard covers the moments readOnly cannot: `onresult` first compares the box with what it last
  wrote, and when the page changed it (an answer sent, a line typed in the instant after the tap-off), the session is
  let go and nothing is written. **Send and Get feedback cancel the mic before they send**, so what is sent is what
  the box showed, and a word arriving after the send is dropped (check-mirrors 89 pins the cancel in the function
  that sends; 90 executes the guard).
- **Tap off lets the last words land; cancel drops them.** `stop()` (a tap, or the page going to the background)
  asks the recognizer to finish, and its final words still write; `cancel()` (a send, `pagehide`, the box going away
  or being disabled while a message is on its way) aborts it and lets every later word go.
- **A long answer is not cut off by the browser.** Chrome ends a continuous session by itself after a pause or its
  own limit. While the person still wants the mic and the session heard words, the next session opens from the box
  as it stands, reading the language again; a session that heard nothing stops and says "The mic stopped. Tap it to
  go on." (`stopped`). A tap-off never reopens it.
- **The language is the question's, else the interface's** (`dictationLang`): `he-IL` or `en-US`. The question is
  read by the resume's share-of-words rule (`lib/lang.ts` `proseLanguage`: Hebrew when at least one word in five is),
  never by `textLanguage`'s any-Hebrew-letter rule, which would listen for Hebrew on "Tell me about your time at רפאל".
  The practice box follows its question; the mock chat follows the interviewer's last turn. `proseLanguage` is
  client-only: nothing on the server reads a question's language.
- **The cap is the server's.** `MAX_ANSWER_KB` (16) mirrors `max_answer_kb` in `backend/app/config.py`, the cap that
  measures a practice answer and each candidate turn of the mock chat, and check-mirrors 89 holds the two equal (and
  that `prompts.py` still caps both with it). It is measured the server's way, in UTF-8 bytes, so a Hebrew answer
  meets it at about half the letters. A word that would take the box past it is not written; the mic stops and says
  "this answer is at its length limit" (`cap`); a box already at it does not open the mic. 16 KB is about 2,700
  English words, far past a spoken answer, so this is a guard rail: dictation alone never draws the 413 of kind
  `answer`. The deployed `MAX_ANSWER_KB` could differ from the default; the frontend does not read the live value,
  and the server still refuses as before.
- **What the person is told when it stops** (`dictate.note.*`, both locales): the microphone blocked, with where to
  allow it (the icon beside the address); speech input off or unavailable in this browser (`service-not-allowed`,
  what Safari answers with Dictation turned off); nothing heard; the speech service unreachable (Chrome's recognizer
  needs the network, and Brave ships the API without Google's service, so it lands here too); no microphone; the
  length limit; stopped by itself; anything else. `aborted` is our own cancel and says nothing.
- **Browser support is feature detection plus a graceful error, never a user-agent list.**
  - No recognizer (Firefox, where it is behind a flag): nothing is drawn, not the button, the badge or the note, and
    the box is exactly as before (measured: 0 mic buttons).
  - **iOS Safari gets the mic.** `webkitSpeechRecognition` exists from iOS 14.5; it needs Siri and Dictation turned
    on, and without them it refuses with `service-not-allowed`, which gets its own sentence. It is known to be
    flaky: a session may end early, which the reopen covers, and a reopen outside a tap may be refused, which ends as
    a note. An app's embedded browser and an installed home-screen app may expose the API and refuse it: the same
    path.
  - Chrome on Android repeats earlier words as extra final results with a confidence of 0; on Android (the
    `isAndroid` test `lib/inAppBrowser.ts` already had) those are skipped. That is the published workaround, not a
    measurement: **no real phone or microphone was used** (headless Chromium has none), so each of these is a
    reading of the browsers' documented behaviour, to be tried on a phone.
- **Accessibility and layout.** A real `<button type="button">` with `aria-pressed`, named "Speak your answer" /
  "ענו בקול" in both states, as a toggle's name should be (the visible state carries the change); a screen reader
  hears "Listening. Tap the mic again to stop." once, from a polite live region. The listening state is not colour
  alone: the mic becomes a stop square, a ring surrounds it, and a "Listening" / "מקשיבים" badge sits on the box's top
  edge. The badge is absolutely placed inside the box's own `relative` wrapper, right after the box (check-mirrors
  89), and the button is the same size in both states, so nothing moves when the mic starts or stops. 44 × 44 below
  `lg`, 36 × 36 from `lg`. No colour transition: the state flips on the tap (a 150 ms tween left the pressed state
  trailing it). The ring and the badge's dot pulse under `motion-safe:` only, so under reduced motion they are drawn
  and still. Both boxes are `dir="auto"`, and so is a question's rationale line, because the answer and the rationale
  are in the question's language, whichever the interface is.
- **Measured** with Playwright on an iPhone 13 (390 × 664) and at 360 × 664, English and Hebrew, with the recognizer
  replaced by a scripted one, and at 1440 × 900: the practice box, the mic, Get feedback and the card move 0 px (page
  coordinates) when the mic starts and stops, and the chat box, the mic and Send 0 px; `scrollWidth <= clientWidth`
  in every state (idle, listening, a note showing, the chat listening) and on `/privacy`; "I led" became "I led a team
  of five and we shipped it"; Get feedback and Send each aborted the recognizer and a later word was not written; a
  Hebrew question listened in `he-IL` under the English interface, the stub's English questions in `en-US` under the
  Hebrew one; with both constructors deleted, 0 mic buttons and 0 badges.
- **Pinned** by check-mirrors 89 (every answer box's wiring, the send's cancel, no network, the keys and a sentence
  for every note, the cap against `config.py`, the privacy sentence) and 90 (the controller EXECUTED against a
  scripted recognizer, with eight planted twins); both probed red with 13 plants in the real files. See `testing.md`.
- **Known open.** Not tried with a real microphone on a real phone (Android's repeat heuristic, iOS's reopen). The
  job-posting box above the questions (`components/JDPaste.tsx`, shared with the tailor dialog) has no `dir="auto"`,
  so an English posting under the Hebrew interface prints its full stops at the wrong end; it was seen during this
  pass and left alone, since it is not an answer box.
