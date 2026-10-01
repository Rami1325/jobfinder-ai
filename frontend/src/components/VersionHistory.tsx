// Master resume restore points (PLAN 20.8 / N1), on the document since PLAN
// 31.6/3. `PUT /profile/resume` overwrites in place, and since 31.6/2 every
// edit saves itself, so the server keeps a restore point each time the resume
// is replaced and one per half hour of editing (`resume_versions`).
//
// It lived on the Jobs page, behind a small link by the master resume's name:
// the one page that IS the resume could not show its own history. It opens
// from the document's tools now (the rail, and "⋯" on a phone), and a restore
// point is SHOWN, whole, before it is restored, which is what the old two-step
// Restore / "Restore this one" stood in for: you could not see what you were
// about to bring back.
//
// Restoring is itself undoable: the server snapshots the state it replaces, so
// a mis-click here cannot be the thing that loses the resume.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronRight, History, RotateCcw } from "lucide-react";
import { getResumeVersion, listResumeVersions, restoreResumeVersion, type ResumeTemplate } from "../api/client";
import { apiErrorMessage } from "../lib/apiError";
import { Button, Modal, Skeleton, useToast } from "./ui";
import ResumeView from "./ResumeView";
import type { MasterResume, ResumeVersion } from "../types";

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
  template,
  beforeRestore,
}: {
  open: boolean;
  onClose: () => void;
  onRestored: (m: MasterResume) => void;
  /** The design the document is drawn in, so a restore point reads like it. */
  template?: ResumeTemplate;
  /** Runs before a restore: /app sends an edit still waiting to save first, so
   * the state the restore replaces is the one on screen, and kept. */
  beforeRestore?: () => Promise<unknown>;
}) {
  const { t, i18n } = useTranslation("jobs");
  const toast = useToast();
  const [versions, setVersions] = useState<ResumeVersion[] | null>(null);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(false);
  // The restore point being looked at, and its content once it has loaded.
  const [picked, setPicked] = useState<ResumeVersion | null>(null);
  const [shown, setShown] = useState<MasterResume | null>(null);
  const [shownError, setShownError] = useState("");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setVersions(null);
    setError("");
    setPicked(null);
    listResumeVersions()
      .then((v) => alive && setVersions(v))
      .catch((e: unknown) => alive && setError(apiErrorMessage(e, t("versions.loadError"))));
    return () => {
      alive = false;
    };
  }, [open, t]);

  useEffect(() => {
    if (!picked) return;
    let alive = true;
    setShown(null);
    setShownError("");
    getResumeVersion(picked.id)
      .then((m) => alive && setShown(m))
      .catch((e: unknown) => alive && setShownError(apiErrorMessage(e, t("versions.loadOneError"))));
    return () => {
      alive = false;
    };
  }, [picked, t]);

  async function restore(id: number) {
    setRestoring(true);
    try {
      await beforeRestore?.();
      const master = await restoreResumeVersion(id);
      onRestored(master);
      toast("success", t("versions.restored"));
      onClose();
    } catch (e: unknown) {
      toast("error", apiErrorMessage(e, t("versions.restoreError")));
    } finally {
      setRestoring(false);
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
      {picked ? (
        <div>
          <button
            type="button"
            onClick={() => setPicked(null)}
            className="tap-44 mb-3 inline-flex items-center gap-1 text-sm font-medium text-accent-soft hover:underline"
          >
            <ArrowLeft size={15} className="rtl:-scale-x-100" /> {t("versions.back")}
          </button>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink" dir="auto">
                {picked.headline || t("versions.untitled")}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-faint">
                <span>{t("versions.until", { when: when(picked.created_at) })}</span>
                <VersionSummary v={picked} />
              </p>
            </div>
            <Button
              size="sm"
              icon={<RotateCcw size={14} />}
              loading={restoring}
              disabled={!shown}
              onClick={() => restore(picked.id)}
              className="min-h-11"
            >
              {t("versions.restoreThis")}
            </Button>
          </div>
          {shownError && <p className="text-sm text-danger">{shownError}</p>}
          {!shown && !shownError && <Skeleton className="h-[28rem] w-full" />}
          {/* The whole restore point, drawn the way the document is (the
              sheet is ResumeView's own): read only, since nothing is written
              until it is restored. */}
          {shown && <ResumeView resume={shown.resume} surface="sheet" template={template} />}
        </div>
      ) : (
        <>
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
              <li key={v.id}>
                <button
                  type="button"
                  onClick={() => setPicked(v)}
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-line bg-bg-soft/60 px-3 py-2.5 text-start transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-ink" dir="auto">
                        {v.headline || t("versions.untitled")}
                      </span>
                      <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
                        {v.language}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-2">
                      <span className="text-xs text-ink-faint">{when(v.created_at)}</span>
                      <VersionSummary v={v} />
                    </span>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold text-accent-soft">
                    {t("versions.view")}
                    <ChevronRight size={14} className="rtl:-scale-x-100" aria-hidden />
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {!!versions?.length && (
            <p className="mt-4 flex items-start gap-2 text-xs text-ink-faint">
              <History size={13} className="mt-0.5 shrink-0" />
              {t("versions.note")}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
