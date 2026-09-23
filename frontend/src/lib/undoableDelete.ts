/**
 * Delete with an undo window (PLAN 31.1/6).
 *
 * A tracker card, a kit and a History row were deleted on one tap, with no
 * confirm and no way back. The caller hides the row at once; the server delete
 * runs only when this window closes without an undo, and a failed delete hands
 * control back through `onFailed` so the caller can put the row back and say so.
 *
 * Dependency-free on purpose, so check-mirrors can bundle and EXECUTE it.
 * Closing the tab inside the window cancels the delete (the row is still there
 * next time), which errs toward keeping the user's data.
 */
export const UNDO_MS = 5000;

/** Schedule `commit` after `ms`; the returned function cancels it. `commit`
 * runs at most once, and never after a cancel. */
export function scheduleUndoable(
  commit: () => Promise<unknown>,
  onFailed: () => void,
  ms: number = UNDO_MS,
): () => void {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    commit().catch(() => onFailed());
  }, ms);
  return () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
  };
}
