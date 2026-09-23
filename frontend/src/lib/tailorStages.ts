/**
 * The tailor pipeline's stages, in the order it reaches them (PLAN 31.3/2): a
 * mirror of `TAILOR_STAGES` in `backend/app/core/tailor.py`, which check-mirrors
 * 64 holds equal. The server sends each one as it STARTS it, over
 * `POST /tailor/stream`.
 */
export const TAILOR_STAGES = ["plan", "rewrite", "facts", "voice", "rescore"] as const;
export type TailorStage = (typeof TAILOR_STAGES)[number];

export type StageState = "done" | "active" | "pending";

/** Whether a frame's stage is one this page knows. A stage a newer server adds
 * is ignored, never shown under a raw name. */
export function isTailorStage(s: unknown): s is TailorStage {
  return typeof s === "string" && (TAILOR_STAGES as readonly string[]).includes(s);
}

/**
 * Each stage's state, from the stages the server has REPORTED and nothing else.
 *
 * "Never animate progress that is not being measured" (`document-editor.md`):
 * a stage is active only once the pipeline said it started, done only once a
 * LATER one did, and pending otherwise. Nothing here reads a clock or guesses
 * how far along a stage is, so the page cannot show the model rewriting while
 * it is still planning.
 */
export function stageStates(heard: readonly string[]): Record<TailorStage, StageState> {
  const known = heard.filter(isTailorStage);
  const last = known.length ? known[known.length - 1] : null;
  const out = {} as Record<TailorStage, StageState>;
  for (const s of TAILOR_STAGES) {
    out[s] = !known.includes(s) ? "pending" : s === last ? "active" : "done";
  }
  return out;
}
