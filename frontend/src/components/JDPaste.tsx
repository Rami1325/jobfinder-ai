import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bookmark, Briefcase, Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchJob, getApplication, listApplications } from "../api/client";
import { apiErrorMessage } from "../lib/apiError";
import { Button } from "./ui";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useMediaQuery } from "../hooks/useMediaQuery";
import type { ApplicationOut } from "../types";

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** The posting this text was analysed as, once a result for it is on
   * screen: the box folds to one line, "Senior Backend Engineer · Paywise ·
   * Edit" (PLAN 31.2/9), so the result is what the screen shows. The caller
   * passes it only while the text is still the text that was analysed. */
  folded?: { title: string; company: string } | null;
}

// A single-token, host-looking string → treat as a job link.
const URL_RE = /^(https?:\/\/)?([\w-]+\.)+[\w-]{2,}(\/\S*)?$/i;

export default function JDPaste({ value, onChange, folded }: Props) {
  const { t } = useTranslation("tailor");
  // "Edit" on the folded line opens the box; a NEW analysis folds it again.
  const [unfolded, setUnfolded] = useState(false);
  const foldKey = folded ? `${folded.title}\u0000${folded.company}` : "";
  useEffect(() => setUnfolded(false), [foldKey]);
  // Below lg the picker is a bottom sheet, at the thumb that opened it; it
  // opened below the fold on Interview (PLAN 31.2/9). From lg it stays inline.
  const wide = useMediaQuery("(min-width: 1024px)");
  const sheetRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // The saved-job picker. Deliberately an inline disclosure rather than a
  // Modal: this component already renders INSIDE one (TailorOverlay), and
  // `Modal` binds ESC and backdrop on `window`, so a nested one would close
  // both. Opening it is also what loads the list — four pages mount JDPaste and
  // none of them should pay for /applications until someone asks for it.
  const [picking, setPicking] = useState(false);
  const [apps, setApps] = useState<ApplicationOut[] | null>(null);
  const [pickBusy, setPickBusy] = useState(false);

  const sheetUp = picking && !wide;
  useDialogFocus(sheetUp, sheetRef);
  // Escape closes the SHEET and nothing else. TailorOverlay's Modal closes on
  // any Escape it hears on window, so this listens in the capture phase and
  // stops the event there; the dialog underneath never learns of it.
  useEffect(() => {
    if (!sheetUp) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPicking(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sheetUp]);

  const trimmed = value.trim();
  const isLink = !/\s/.test(trimmed) && trimmed.length > 8 && URL_RE.test(trimmed);

  async function fetchFromLink() {
    setError("");
    setLoading(true);
    try {
      const text = await fetchJob(trimmed);
      if (text.trim().length < 40) {
        throw new Error(t("jdPaste.noText"));
      }
      onChange(text);
    } catch (e: any) {
      setError(apiErrorMessage(e, e?.message || t("jdPaste.fetchError")));
    } finally {
      setLoading(false);
    }
  }

  async function openPicker() {
    setError("");
    if (picking) {
      setPicking(false);
      return;
    }
    setPicking(true);
    if (apps) return; // already loaded this session
    setPickBusy(true);
    try {
      setApps(await listApplications());
    } catch (e: unknown) {
      setError(apiErrorMessage(e, t("jdPaste.savedLoadError")));
      setPicking(false);
    } finally {
      setPickBusy(false);
    }
  }

  /** `listApplications` does not carry `jd_text`, so the posting is fetched on
   * pick. A row saved without a description is a real case (the tracker holds
   * jobs added from a card), and it gets a plain message rather than silently
   * pasting an empty string over what the user already typed. */
  async function pick(id: number) {
    setError("");
    setPickBusy(true);
    try {
      const d = await getApplication(id);
      if (!d.jd_text?.trim()) {
        setError(t("jdPaste.savedEmpty"));
        return;
      }
      onChange(d.jd_text);
      setPicking(false);
    } catch (e: unknown) {
      setError(apiErrorMessage(e, t("jdPaste.savedLoadError")));
    } finally {
      setPickBusy(false);
    }
  }

  const list = (
    <>
      {pickBusy && !apps && <p className="p-3 text-sm text-ink-muted">{t("jdPaste.savedLoading")}</p>}
      {apps?.length === 0 && <p className="p-3 text-sm text-ink-muted">{t("jdPaste.savedNone")}</p>}
      {apps?.map((a) => (
        <button
          key={a.id}
          type="button"
          disabled={pickBusy}
          onClick={() => pick(a.id)}
          className="block min-h-11 w-full border-b border-line/60 px-3 py-2.5 text-start transition-colors last:border-b-0 hover:bg-panel-2/70 focus-visible:bg-panel-2/70 focus-visible:outline-none disabled:opacity-60"
        >
          {/* Two lines, each with its own direction. "Title at Company" on
              one line wraps unpredictably when a Latin title sits beside a
              Hebrew company, and `dir="auto"` per string is right HERE
              precisely because these are read-only and have no caret — the
              explicit-dir rule exists for editable resume fields. */}
          <span dir="auto" className="block truncate text-sm font-medium text-ink">
            {a.job_title || "—"}
          </span>
          <span dir="auto" className="block truncate text-xs text-ink-muted">
            {a.company || "—"}
          </span>
        </button>
      ))}
    </>
  );

  if (folded && !unfolded)
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-bg-soft px-3 py-2.5">
        <Briefcase size={15} className="shrink-0 text-accent-soft" aria-hidden />
        <p dir="auto" className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {folded.title || t("jdPaste.thisJob")}
          {folded.company ? ` · ${folded.company}` : ""}
        </p>
        <Button size="sm" variant="ghost" onClick={() => setUnfolded(true)} className="tap-44">
          {t("jdPaste.edit")}
        </Button>
      </div>
    );

  return (
    <div>
      {/* The posting's own direction (the phone polish pass): an English ad
          under the Hebrew UI put its full stops at the wrong end of each line. */}
      <textarea
        dir="auto"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (error) setError("");
        }}
        placeholder={t("jdPaste.placeholder")}
        className="min-h-[240px] w-full resize-y rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25"
      />
      {/* Both buttons wear `tap-44` at their 34 px (the third tap-target pass):
          5.25 px of layer, clear of the box 8 px above, and wrapped rows 12 px
          apart. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-3">
        {isLink && (
          <>
            <Button size="sm" variant="secondary" loading={loading} icon={<Link2 size={14} />} onClick={fetchFromLink} className="tap-44">
              {t("jdPaste.fetchCta")}
            </Button>
            <span className="text-xs text-ink-muted">{t("jdPaste.detected")}</span>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={<Bookmark size={14} />}
          onClick={openPicker}
          aria-expanded={picking}
          className="tap-44"
        >
          {t("jdPaste.savedCta")}
        </Button>
      </div>

      {picking && wide && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-line bg-bg-soft/60">{list}</div>
      )}
      {/* Below lg: a bottom sheet, portalled over everything including the
          dialog this may sit in (z-[55], above the modal layer, under toasts).
          A tap inside it bubbles up the React tree to that dialog's panel,
          which stops it, so the dialog's backdrop never hears it. */}
      {sheetUp &&
        createPortal(
          <>
            <div
              aria-hidden
              onClick={(e) => {
                e.stopPropagation();
                setPicking(false);
              }}
              className="fixed inset-0 z-[55] touch-none bg-black/40"
            />
            <div
              ref={sheetRef}
              role="dialog"
              aria-modal="true"
              aria-label={t("jdPaste.savedCta")}
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
              className="animate-fade-up fixed inset-x-0 bottom-0 z-[55] flex max-h-[70dvh] flex-col rounded-t-2xl border-t border-line bg-bg-soft pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-panel focus:outline-none"
            >
              <div aria-hidden className="mx-auto mb-1 mt-2 h-1 w-10 shrink-0 rounded-full bg-line" />
              <p className="px-4 pb-2 pt-1 text-sm font-semibold text-ink">{t("jdPaste.savedCta")}</p>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-line/60">{list}</div>
            </div>
          </>,
          document.body,
        )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
