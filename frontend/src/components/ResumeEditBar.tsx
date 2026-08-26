import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Pencil, Save, Undo2 } from "lucide-react";
import { Button, useToast } from "./ui";
import { commitResumeEdits, undoBlockEdit } from "../state/tailorStore";
import { masterResumeLabel } from "../hooks/useSaveMasterResume";
import { resumeLanguage } from "../lib/lang";
import type { ResumeModel } from "../types";

interface Props {
  resume: ResumeModel;
  /** The last saved state, for the language-flip guard. */
  savedResume: ResumeModel | null;
  masterLabel: string;
  unsaved: number;
  saving: boolean;
  error: string;
}

/**
 * Explicit save, not autosave — and that is a decision with three concrete
 * reasons, all of which are live bugs waiting behind an autosave:
 *
 *   1. The server keeps 20 versions per (user, language) and snapshots on every
 *      changed PUT. Twenty-one autosaves is three minutes of typing, and it has
 *      by then evicted the uploaded original and every restore point that meant
 *      anything.
 *   2. `PUT /profile/resume` picks the row by DETECTED language and carries no
 *      id. One Hebrew word typed into an English résumé saves over the Hebrew
 *      one and leaves the row you were editing untouched.
 *   3. There is no conflict check at any layer, so two tabs are last-write-wins.
 *
 * Until those are fixed on the backend, a Save button is the honest interface.
 * (2) is guarded here, client-side, because it is the one that destroys the
 * other document rather than just this one.
 */
export default function ResumeEditBar({ resume, savedResume, masterLabel, unsaved, saving, error }: Props) {
  const { t } = useTranslation("tailor");
  const toast = useToast();
  const [confirmLang, setConfirmLang] = useState<"he" | "en" | null>(null);

  async function run() {
    const ok = await commitResumeEdits(
      masterLabel || masterResumeLabel(resume),
      t("edit.saveErrorFallback"),
    );
    setConfirmLang(null);
    if (ok) toast("success", t("edit.saved"));
    // The failure is NOT a toast. "Your work is not saved" must not disappear
    // while the work is still not saved — it stays in the bar, with Retry.
  }

  function save() {
    const now = resumeLanguage(resume);
    if (savedResume && now !== resumeLanguage(savedResume)) {
      setConfirmLang(now);
      return;
    }
    void run();
  }

  if (unsaved === 0 && !error) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-ink-faint">
        <Pencil size={12} /> {t("edit.hint")}
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-accent/40 bg-accent/5 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-semibold text-ink">{t("edit.unsaved", { count: unsaved })}</span>
        <span className="text-xs text-ink-faint">{t("edit.local")}</span>
        <span className="ms-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" icon={<Undo2 size={14} />} disabled={unsaved === 0 || saving} onClick={undoBlockEdit}>
            {t("edit.undo")}
          </Button>
          <Button size="sm" loading={saving} icon={<Save size={14} />} onClick={save}>
            {saving ? t("edit.saving") : t("edit.save")}
          </Button>
        </span>
      </div>

      {error && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-danger">
          <AlertTriangle size={15} className="shrink-0" />
          <span className="min-w-0">{error}</span>
          <button type="button" onClick={save} className="font-medium underline underline-offset-2">
            {t("edit.retry")}
          </button>
        </div>
      )}

      {confirmLang && (
        <div className="mt-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2">
          <p className="text-sm font-semibold text-ink">{t("edit.langWarnTitle")}</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            {t("edit.langWarnBody", { lang: t(`langSwitch.name.${confirmLang}`) })}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirmLang(null)}>
              {t("edit.cancel")}
            </Button>
            <Button size="sm" variant="danger" onClick={run}>
              {t("edit.langWarnConfirm")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
