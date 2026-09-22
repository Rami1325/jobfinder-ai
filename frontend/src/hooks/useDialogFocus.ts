import { type RefObject, useEffect } from "react";

/** What Tab can reach inside an overlay, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"], [contenteditable="plaintext-only"]';

/** Where Tab (or Shift+Tab) should land to stay inside the overlay, or null
 * when the browser's own move already stays inside. Pure, so check-mirrors 42
 * executes it: `items` are the overlay's focusable elements in order,
 * `active` is what holds focus now, `inside` says whether that is in the
 * overlay. Focus that has left the overlay (a click on the page behind it)
 * comes back to the first item, or the last on Shift+Tab. */
export function trapTarget<T>(items: readonly T[], active: T | null, inside: boolean, shift: boolean): T | "none" | null {
  if (items.length === 0) return "none";
  const first = items[0];
  const last = items[items.length - 1];
  if (!inside) return shift ? last : first;
  if (shift && (active === first || !items.includes(active as T))) return last;
  if (!shift && (active === last || !items.includes(active as T))) return first;
  return null;
}

// The overlays open right now, newest last. Only the newest one handles Tab:
// a modal opened over the drawer would otherwise have the drawer pull focus
// back out of it on every key press.
const stack: RefObject<HTMLElement | null>[] = [];

/** Keyboard focus for an overlay that is MODAL while `active` is true.
 *
 * When it opens, focus moves into it (onto the container, which needs
 * `tabIndex={-1}`, unless something inside, such as an `autoFocus` field,
 * already took it); while it is open, Tab and Shift+Tab stay inside it; when
 * it closes, focus goes back to whatever held it before, normally the control
 * that opened it, as long as focus is not already somewhere the user put it.
 *
 * Found in the 2026-09-21 390 px pass: the review drawer is `aria-modal` below
 * `lg`, yet after it opened `document.activeElement` stayed on the "Check my
 * CV" pill OUTSIDE it, and `Modal` had neither a trap nor a way back. */
export function useDialogFocus(active: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    if (node && !node.contains(document.activeElement)) node.focus({ preventScroll: true });
    stack.push(ref);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || stack[stack.length - 1] !== ref) return;
      const box = ref.current;
      if (!box) return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      const now = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const target = trapTarget(items, now, !!now && box.contains(now), e.shiftKey);
      if (target === null) return;
      e.preventDefault();
      (target === "none" ? box : target).focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      const at = stack.lastIndexOf(ref);
      if (at !== -1) stack.splice(at, 1);
      // Only take focus back when it is still in the overlay or was dropped
      // with it (an unmounted node hands focus to <body>). Focus the user moved
      // somewhere else on purpose stays where they put it.
      const now = document.activeElement;
      const lost = !now || now === document.body || (!!node && node.contains(now));
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true });
    };
    // `ref` is stable for the overlay's life; re-running on it would move focus again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
