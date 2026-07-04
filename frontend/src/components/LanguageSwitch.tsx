import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";

/** EN/עב language switch used in both the app and marketing headers.
 * Shows the language you'd switch TO (like the sun/moon theme toggle). */
export default function LanguageSwitch({ className }: { className?: string }) {
  const { i18n } = useTranslation();
  const isHebrew = (i18n.resolvedLanguage ?? "en").startsWith("he");
  const label = isHebrew ? "Switch to English" : "עברית";
  return (
    <button
      type="button"
      onClick={() => i18n.changeLanguage(isHebrew ? "en" : "he")}
      aria-label={label}
      title={label}
      className={cn(
        "grid h-8 min-w-8 place-items-center rounded-lg border border-line px-1.5 text-xs font-semibold text-ink-muted",
        "transition-colors hover:bg-panel-2/60 hover:text-ink",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        className,
      )}
    >
      {isHebrew ? "EN" : "עב"}
    </button>
  );
}
