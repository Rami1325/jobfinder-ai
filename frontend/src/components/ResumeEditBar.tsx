import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Loader2, Undo2 } from "lucide-react";
import { Button } from "./ui";
import {
  resolveMasterConflict,
  retryMasterSave,
  undoBlockEdit,
  type MasterConflict,
  type MasterSave,
} from "../state/tailorStore";

interface Props {
  save: MasterSave;
  conflict: MasterConflict | null;
  /** Why the last save failed; "" for the fallback sentence. */
  error: string;
  canUndo: boolean;
}

/**
 * Where the master's autosave stands, and Undo (PLAN 31.6/2).
 *
 * There was a Save button here, with an unsaved-changes count, until the three
 * backend fixes it waited on landed (31.6/1): every edit now saves a pause
 * later, and this says Saving… or Saved. What it may NOT do is say Saved about
 * a save the server refused, so each refusal has its own panel and stays on
 * screen until it is answered:
 *   - a failure (the network, the server) offers Try again;
 *   - STALE: another tab or device saved a newer version since this document
 *     was opened. Load that version, or keep this one (the other is kept as a
 *     restore point);
 *   - SLOT: the resume now reads as the other language, and saving it would
 *     replace the resume in that language's slot. Nothing is saved until the
 *     person undoes the change or says to save it there.
 *
 * SHAPE: a FRAGMENT, not a bar. Every child is a flex item of the document
 * toolbar's own wrapping row, and the panels are `w-full` siblings that break
 * onto their own line of it. That is what keeps a refusal on screen: it is
 * chrome over the document, not a toast, because "your work is not saved" must
 * not disappear while the work is still not saved.
 */
export default function ResumeEditBar({ save, conflict, error, canUndo }: Props) {
  const { t } = useTranslation("tailor");
  const [busy, setBusy] = useState(false);

  // Nothing edited on this visit and nothing broken: nothing here, so the
  // toolbar keeps its one row at rest (PLAN 31.2/1).
  if (save === "idle" && !canUndo) return null;

  const answer = (choice: "keep" | "load" | "switch") => {
    setBusy(true);
    void resolveMasterConflict(choice).finally(() => setBusy(false));
  };
  const langName = conflict?.kind === "slot" && conflict.language === "he" ? t("langSwitch.name.he") : t("langSwitch.name.en");
  const status =
    save === "saving"
      ? { icon: <Loader2 size={14} className="animate-spin" aria-hidden />, text: t("edit.saving") }
      : save === "saved"
        ? { icon: <Check size={14} className="text-mint" aria-hidden />, text: t("edit.autoSaved") }
        : save === "idle"
          ? null
          : { icon: <AlertTriangle size={14} className="text-danger" aria-hidden />, text: t("edit.notSaved") };

  return (
    <>
      {/* One flex item, so the status and Undo wrap as a unit. Below sm the
          icon carries the status and the words are its accessible name; from
          sm there is room to say it. */}
      <span className="inline-flex shrink-0 items-center gap-1">
        {status && (
          <span title={status.text} className="inline-flex items-center gap-1 text-xs text-ink-muted">
            {status.icon}
            <span className="sr-only sm:not-sr-only">{status.text}</span>
          </span>
        )}
        {canUndo && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Undo2 size={14} />}
            onClick={undoBlockEdit}
            aria-label={t("edit.undo")}
            title={t("edit.undo")}
          />
        )}
      </span>

      {(save === "failed" || save === "conflict") && (
        // `order-last` so it breaks onto its own line under the row.
        <div role="alert" className="order-last w-full">
          {save === "failed" && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-danger">
              <AlertTriangle size={15} className="shrink-0" />
              <span className="min-w-0">{error || t("edit.saveErrorFallback")}</span>
              <button
                type="button"
                onClick={() => void retryMasterSave()}
                className="font-medium underline underline-offset-2"
              >
                {t("edit.retry")}
              </button>
            </div>
          )}

          {conflict?.kind === "stale" && (
            <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2">
              <p className="text-sm font-semibold text-ink">{t("edit.staleTitle")}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{t("edit.staleBody")}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => answer("load")}>
                  {t("edit.staleLoad")}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => answer("keep")}>
                  {t("edit.staleKeep")}
                </Button>
              </div>
            </div>
          )}

          {conflict?.kind === "slot" && (
            <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2">
              <p className="text-sm font-semibold text-ink">{t("edit.langWarnTitle")}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{t("edit.langWarnAuto", { lang: langName })}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {canUndo && (
                  <Button size="sm" variant="secondary" icon={<Undo2 size={14} />} disabled={busy} onClick={undoBlockEdit}>
                    {t("edit.undo")}
                  </Button>
                )}
                <Button size="sm" variant="danger" disabled={busy} onClick={() => answer("switch")}>
                  {t("edit.langWarnSwitch", { lang: langName })}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
