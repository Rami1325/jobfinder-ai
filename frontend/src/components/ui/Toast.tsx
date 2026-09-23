import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CheckCircle2, AlertTriangle, Info } from "lucide-react";
import SparkBurst from "./ClickSpark";

type ToastKind = "success" | "error" | "info";
/** An action offered inside the toast, such as Undo (PLAN 31.1/6). Pressing it
 * runs `onClick` and closes the toast. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}
export interface ToastOptions {
  action?: ToastAction;
  /** How long the toast stays up; defaults to 3600 ms. A toast carrying an
   * action should stay for the whole window the action is good for. */
  durationMs?: number;
}
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

const ToastCtx = createContext<(kind: ToastKind, message: string, options?: ToastOptions) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

const icons = {
  success: <CheckCircle2 size={16} className="text-mint" />,
  error: <AlertTriangle size={16} className="text-danger" />,
  info: <Info size={16} className="text-accent-soft" />,
};

/** One-shot celebration on success toasts: a single spark burst centered on
 *  the icon, unmounted once the ~400 ms burst animation has finished. */
function SuccessSpark() {
  const [live, setLive] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setLive(false), 450);
    return () => window.clearTimeout(id);
  }, []);
  return live ? <SparkBurst x={8} y={8} color="rgb(var(--mint))" /> : null;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const reduce = useReducedMotion();

  const push = useCallback((kind: ToastKind, message: string, options?: ToastOptions) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, kind, message, action: options?.action }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), options?.durationMs ?? 3600);
  }, []);
  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((t) => t.id !== id)), []);

  // Below lg the stack spans the width ABOVE the tab bar (PLAN 31.2/10): at
  // bottom-5 it sat on the tab bar, covering the tabs, with a long Hebrew
  // sentence wrapping in a corner. From lg it sits at the inline-end corner.
  // Toasts spring in from the inline-end side either way.
  // Re-evaluated on every push (each push re-renders), so language switches
  // are picked up. Under reduced motion framer drops the transform entirely.
  const fromEnd =
    typeof document !== "undefined" && document.documentElement.dir === "rtl" ? -56 : 56;

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] end-4 start-4 z-[60] flex flex-col gap-2 lg:bottom-5 lg:end-5 lg:start-auto lg:items-end">
        <AnimatePresence>
          {items.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, x: fromEnd }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: fromEnd / 2, transition: { duration: 0.15, ease: [0.22, 1, 0.36, 1] } }}
              transition={{ type: "spring", stiffness: 550, damping: 34, mass: 0.9 }}
              className="pointer-events-auto flex items-center gap-2 rounded-lg border border-line bg-panel px-4 py-3 text-sm text-ink shadow-panel"
            >
              <span className="relative grid shrink-0 place-items-center">
                {icons[t.kind]}
                {t.kind === "success" && !reduce && <SuccessSpark />}
              </span>
              <span className="min-w-0 flex-1">{t.message}</span>
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    t.action?.onClick();
                    dismiss(t.id);
                  }}
                  className="ms-2 min-h-8 shrink-0 rounded-md px-2 text-sm font-semibold text-accent transition-colors hover:bg-accent/10"
                >
                  {t.action.label}
                </button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
