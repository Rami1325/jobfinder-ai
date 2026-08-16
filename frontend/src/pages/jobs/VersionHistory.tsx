// Master résumé restore points (PLAN 20.8 / N1). `PUT /profile/resume`
// overwrites in place and several paths save without the user thinking of it as
// a save — the Builder, the Skills editor, a re-upload — so until this existed
// one bad save was unrecoverable for the most valuable object a user owns.
//
// Restoring is itself undoable: the server snapshots the state it replaces, so
// a mis-click here cannot be the thing that loses the résumé. The confirm step
// is still there because "restore" reads as destructive even when it isn't.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, RotateCcw } from "lucide-react";
import { listResumeVersions, restoreResumeVersion } from "../../api/client";
import { apiErrorMessage } from "../../lib/apiError";
import { Button, Modal, Skeleton, useToast } from "../../components/ui";
import type { MasterResume, ResumeVersion } from "../../types";

/** "3 roles · 2 projects" — enough to tell two restore points apart without
 * opening either, which is why the list endpoint returns the counts. */
function VersionSummary({ v }: { v: ResumeVersion }) {
  const { t } = useTranslation("jobs");
  return (
    <span className="text-xs text-ink-muted">
      {t("versions.counts", { roles: v.experience_count, projects: v.project_count })}
    </span>
  );
}

export function VersionHistoryModal({
  open,
  onClose,
  onRestored,
}: {
  open: boolean;
  onClose: () => void;
  onRestored: (m: MasterResume) => void;
}) {
  const { t, i18n } = useTranslation("jobs");
  const toast = useToast();
  const [versions, setVersions] = useState<ResumeVersion[] | null>(null);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setVersions(null);
    setError("");
    setConfirmId(null);
    listResumeVersions()
      .then((v) => alive && setVersions(v))
      .catch((e: unknown) => alive && setError(apiErrorMessage(e, t("versions.loadError"))));
    return () => {
      alive = false;
    };
  }, [open, t]);

  async function restore(id: number) {
    setRestoring(id);
    try {
      const master = await restoreResumeVersion(id);
      onRestored(master);
      toast("success", t("versions.restored"));
      onClose();
    } catch (e: unknown) {
      toast("error", apiErrorMessage(e, t("versions.restoreError")));
    } finally {
      setRestoring(null);
    }
  }

  // Locale-aware and direction-safe: the Hebrew UI must not render a Gregorian
  // date in an English format next to right-to-left text.
  const when = (iso: string) => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleString(i18n.language === "he" ? "he-IL" : "en-GB", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        });
  };

  return (
    <Modal open={open} onClose={onClose} title={t("versions.title")}>
      <p className="mb-4 text-sm text-ink-muted">{t("versions.body")}</p>

      {error && <p className="text-sm text-danger">{error}</p>}

      {versions === null && !error && (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      )}

      {versions?.length === 0 && (
        <p className="rounded-lg border border-line bg-bg-soft/60 px-3 py-6 text-center text-sm text-ink-muted">
          {t("versions.empty")}
        </p>
      )}

      <ul className="space-y-2">
        {versions?.map((v) => (
          <li
            key={v.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-bg-soft/60 px-3 py-2.5"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-ink" dir="auto">
                  {v.headline || t("versions.untitled")}
                </span>
                <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
                  {v.language}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                <span className="text-xs text-ink-faint">{when(v.created_at)}</span>
                <VersionSummary v={v} />
              </div>
            </div>
            {confirmId === v.id ? (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  loading={restoring === v.id}
                  onClick={() => restore(v.id)}
                  icon={<RotateCcw size={14} />}
                >
                  {t("versions.confirm")}
                </Button>
                <button
                  type="button"
                  onClick={() => setConfirmId(null)}
                  className="text-xs text-ink-muted hover:underline"
                >
                  {t("common:actions.cancel", { ns: "common" })}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmId(v.id)}
                className="shrink-0 text-xs font-semibold text-accent-soft hover:underline"
              >
                {t("versions.restore")}
              </button>
            )}
          </li>
        ))}
      </ul>

      {!!versions?.length && (
        <p className="mt-4 flex items-start gap-2 text-xs text-ink-faint">
          <History size={13} className="mt-0.5 shrink-0" />
          {t("versions.note")}
        </p>
      )}
    </Modal>
  );
}
