import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Save, Undo2 } from "lucide-react";
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
 *      id. One Hebrew word typed into an English resume saves over the Hebrew
 *      one and leaves the row you were editing untouched.
 *   3. There is no conflict check at any layer, so two tabs are last-write-wins.
 *
 * Until those are fixed on the backend, a Save button is the honest interface.
 * (2) is guarded here, client-side, because it is the one that destroys the
 * other document rather than just this one.
 *
 * SHAPE: a FRAGMENT, not a bar. Every child is a flex item of the document
 * toolbar's own wrapping row — the cluster rides at the end beside the verbs,
 * and the panels that must not be missed are `w-full` siblings that break onto
 * their own line of that same row. That is what keeps the save failure on
 * screen: it is chrome over the document, not a toast, because "your work is
 * not saved" must not disappear while the work is still not saved.
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
    // The failure is NOT a toast — see the shape note above.
  }

  function save() {
    const now = resumeLanguage(resume);
    if (savedResume && now !== resumeLanguage(savedResume)) {
      setConfirmLang(now);
      return;
    }
    void run();
  }

  // Nothing to save and nothing broken: nothing here. The "tap anything to
  // edit" hint this slot used to show on every visit cost the toolbar a whole
  // row over the paper; it is a one-time line above the paper now, in
  // TailorPage (PLAN 31.2/1).
  if (unsaved === 0 && !error) return null;

  const unsavedLabel = t("edit.unsaved", { count: unsaved });
  // "Unsaved" is only half the truth — the other half is WHERE the work is
  // until you save it. The device note is inline from `md`, and folded into
  // the count's accessible name below that, so the fact never depends on a
  // tooltip a touch screen cannot show.
  const pending = `${unsavedLabel}. ${t("edit.local")}`;

  return (
    <>
      {/* One flex item, so the three controls stay glued and wrap as a unit.
          Width budget at 390px: 26px count + 38px Undo + 76px Save + gaps is
          ~156px, which leaves the Tailor button beside it on a single tall row
          instead of a second one. */}
      <span className="inline-flex items-center gap-2">
        {/* Below sm the sentence is what would cost that row, so the number
            carries it and the sentence stays the tooltip and the accessible
            name. Above sm there is room to just say it. */}
        <span
          title={pending}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-accent/40 bg-accent/10 px-1.5 text-xs font-semibold tabular-nums text-ink sm:hidden"
        >
          <span aria-hidden>{unsaved}</span>
          <span className="sr-only">{pending}</span>
        </span>
        <span title={pending} className="hidden text-xs font-semibold text-ink sm:inline">
          {unsavedLabel}
        </span>
        <span className="hidden text-xs text-ink-faint md:inline">{t("edit.local")}</span>
        <Button
          size="sm"
          variant="ghost"
          icon={<Undo2 size={14} />}
          disabled={unsaved === 0 || saving}
          onClick={undoBlockEdit}
          aria-label={t("edit.undo")}
          title={t("edit.undo")}
        />
        {/* "Save", not "Save resume": the label sits inches from the CV and
            next to its own unsaved count, and the long form is what pushes the
            cluster onto its own row on a phone. The full wording stays as the
            tooltip rather than as an aria-label, so the accessible name still
            contains the visible one. */}
        <Button size="sm" loading={saving} icon={<Save size={14} />} onClick={save} title={t("edit.save")}>
          {saving ? t("edit.saving") : t("edit.saveShort")}
        </Button>
      </span>

      {/* `order-last` for the same reason the hint carries it — see above. */}
      {(error || confirmLang) && (
        <div className="order-last w-full">
          {error && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-danger">
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
      )}
    </>
  );
}
