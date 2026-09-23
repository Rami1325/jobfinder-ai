import { AnimatePresence, motion } from "framer-motion";
import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { useTheme } from "../hooks/useTheme";

/** Sun/moon theme switch used in both the app and marketing headers. Its name
 * is the action, in the reader's language: it read "Switch to dark theme" in
 * English under the Hebrew UI (found in the PLAN 31.2 shell pass). */
export default function ThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { theme, toggle } = useTheme();
  const label = t(theme === "dark" ? "theme.toLight" : "theme.toDark");
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-lg border border-line text-ink-muted",
        "transition-colors hover:bg-panel-2/60 hover:text-ink",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        className,
      )}
    >
      {/* Crossfade morph: outgoing icon rotates away and shrinks to nothing
          while the incoming one rotates in from the other side. Both icons
          overlap in the same grid cell, so the 8×8 button never shifts. */}
      <AnimatePresence initial={false}>
        <motion.span
          key={theme}
          initial={{ rotate: -90, scale: 0, opacity: 0 }}
          animate={{ rotate: 0, scale: 1, opacity: 1 }}
          exit={{ rotate: 90, scale: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="col-start-1 row-start-1 grid place-items-center"
        >
          {theme === "dark" ? <Moon size={15} /> : <Sun size={15} />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
