import { cn } from "../../lib/cn";

export default function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white align-middle",
        className,
      )}
    />
  );
}
