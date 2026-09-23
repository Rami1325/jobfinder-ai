import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";

/** One entry in a "⋯" menu (PLAN 31.2/3, /5): an action with no slot of its
 * own in a compact row. `href` makes it a link that opens in a new tab (a job
 * board, a share), and `disabled` keeps it listed but not pressable, the way a
 * counted action with no uses left stays visible and says so elsewhere. */
export interface MoreItem {
  key: string;
  label: string;
  Icon: LucideIcon;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
}

/** An entry is ~40 px; the list's own padding and border add ~14. */
const ITEM_PX = 40;
const LIST_PAD_PX = 14;
/** What the list must clear at the bottom of a phone screen: the tab bar. */
const BOTTOM_CLEAR_PX = 64;

/** The "⋯" at the end of a compact row, and the short list it opens. A list of
 * buttons and links that says so, not `role="menu"`: the account menu's reason
 * (the menu pattern owes arrow keys and a roving tabindex, which a short list
 * does not need). `label` names the button: "More actions", never bare "More",
 * which the tab bar's own button is already called.
 *
 * THE LIST IS PORTALLED to `document.body` and placed from the button's rect.
 * Inside the row it opened BEHIND the next job card (measured at 390 px): each
 * card's entry animation makes it a stacking context, so no z-index inside one
 * card can rise over the next, and a horizontal scroller would clip it as well.
 * It lines up with the button's inline-END edge (right in English, left in
 * Hebrew), opens upward when the space below would put it under the tab bar,
 * and closes on scroll rather than drifting away from its button. Escape and a
 * tap outside close it, and a choice closes it before it runs. */
export default function MoreMenu({ items, label, className }: { items: MoreItem[]; label: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Placed before paint, so the list never flashes at the wrong spot.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const b = buttonRef.current.getBoundingClientRect();
    const rtl = getComputedStyle(buttonRef.current).direction === "rtl";
    const height = items.length * ITEM_PX + LIST_PAD_PX;
    const up = b.bottom + 6 + height > window.innerHeight - BOTTOM_CLEAR_PX && b.top - 6 - height > 0;
    setPlace({
      ...(up ? { bottom: window.innerHeight - b.top + 6 } : { top: b.bottom + 6 }),
      ...(rtl ? { left: b.left } : { right: window.innerWidth - b.right }),
    });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    // Capture, so a scroll inside any scroller closes it too.
    window.addEventListener("scroll", close, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  if (items.length === 0) return null;
  const row =
    "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-start text-sm font-medium text-ink-muted transition-colors hover:bg-panel-2/60 hover:text-ink";
  return (
    <div ref={ref} className={cn("relative shrink-0", className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "grid min-h-8 w-9 place-items-center rounded-lg border transition",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
          open
            ? "border-accent bg-accent text-white"
            : "border-line bg-panel text-ink-muted hover:border-accent/40 hover:text-ink",
        )}
      >
        <MoreHorizontal size={15} aria-hidden />
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={listRef}
            style={place}
            // The page's direction, which the portal would otherwise lose to <body>.
            dir={getComputedStyle(buttonRef.current ?? document.body).direction}
            className="animate-fade-up fixed z-[44] w-60 rounded-xl border border-line bg-bg-soft p-1.5 shadow-panel"
          >
            {items.map((item) =>
              item.href ? (
                <a
                  key={item.key}
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  // A link can still have something to say that it was opened:
                  // "Open the posting" on a draft is what makes Mark applied
                  // the next step (PLAN 31.3/3).
                  onClick={() => {
                    setOpen(false);
                    item.onClick?.();
                  }}
                  className={row}
                >
                  <item.Icon size={15} className="shrink-0" aria-hidden />
                  {item.label}
                </a>
              ) : (
                <button
                  key={item.key}
                  type="button"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onClick?.();
                  }}
                  className={cn(row, "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent")}
                >
                  <item.Icon size={15} className="shrink-0" aria-hidden />
                  {item.label}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
