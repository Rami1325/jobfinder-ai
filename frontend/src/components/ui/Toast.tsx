import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CheckCircle2, AlertTriangle, Info } from "lucide-react";
import SparkBurst from "./ClickSpark";

type ToastKind = "success" | "error" | "info";
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const ToastCtx = createContext<(kind: ToastKind, message: string) => void>(() => {});

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

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3600);
  }, []);

  // The stack sits at the inline-end edge, so toasts spring in from that side.
  // Re-evaluated on every push (each push re-renders), so language switches
  // are picked up. Under reduced motion framer drops the transform entirely.
  const fromEnd =
    typeof document !== "undefined" && document.documentElement.dir === "rtl" ? -56 : 56;

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-5 end-5 z-[60] flex flex-col gap-2">
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
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
