import { useTranslation } from "react-i18next";
import { History, X } from "lucide-react";
import { Button } from "./ui";

interface Props {
  /** When the draft was last written, epoch ms. */
  savedAt: number;
  onKeep: () => void;
  onDiscard: () => void;
}

/**
 * "You have unsaved changes from last time — Restore / Discard."
 *
 * NEVER applied silently, and that is the whole design. Silently swapping the
 * document for a stored copy means a user who opens their CV sees text they
 * did not put there on this visit and cannot tell where it came from; the
 * document surface has to be trustworthy at a glance. Restoring is one tap,
 * and it lands as a normal edit — it saves itself like any other (PLAN 31.6/2)
 * and Undo takes it back, so there is no new state to learn and no way to be
 * stuck with content you did not want. Since the master saves itself, this bar
 * appears only for an edit whose save never landed: a tab closed inside the
 * pause, no network, a refusal left unanswered.
 */
export default function DraftRestoreBar({ savedAt, onKeep, onDiscard }: Props) {
  const { t, i18n } = useTranslation("tailor");
  // Formatted, never a raw ISO slice — the tracker's `created_at.slice(0, 10)`
  // beside Hebrew UI text is the thing not to copy. `resolvedLanguage` so the
  // date follows the interface the user is reading.
  const when = new Date(savedAt).toLocaleString(i18n.resolvedLanguage ?? "en", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <div className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <History size={16} className="shrink-0 text-warn" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{t("draft.title")}</p>
          <p className="mt-0.5 text-xs text-ink-muted">{t("draft.body", { when })}</p>
        </div>
        <span className="ms-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={onDiscard} className="min-h-11">
            {t("draft.discard")}
          </Button>
          <Button size="sm" icon={<History size={14} />} onClick={onKeep} className="min-h-11">
            {t("draft.keep")}
          </Button>
        </span>
      </div>
    </div>
  );
}
