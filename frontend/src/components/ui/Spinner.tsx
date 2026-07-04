import { cn } from "../../lib/cn";

export default function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 align-middle",
        className,
      )}
      // currentColor keeps the spinner legible on any surface in both themes
      // (white text on accent buttons, ink on panels).
      style={{
        borderColor: "color-mix(in srgb, currentColor 30%, transparent)",
        borderTopColor: "currentColor",
      }}
    />
  );
}
