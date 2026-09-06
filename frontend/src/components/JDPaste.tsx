import { useState } from "react";
import { Bookmark, Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchJob, getApplication, listApplications } from "../api/client";
import { apiErrorMessage } from "../lib/apiError";
import { Button } from "./ui";
import type { ApplicationOut } from "../types";

interface Props {
  value: string;
  onChange: (v: string) => void;
}

// A single-token, host-looking string → treat as a job link.
const URL_RE = /^(https?:\/\/)?([\w-]+\.)+[\w-]{2,}(\/\S*)?$/i;

export default function JDPaste({ value, onChange }: Props) {
  const { t } = useTranslation("tailor");
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

  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (error) setError("");
        }}
        placeholder={t("jdPaste.placeholder")}
        className="min-h-[240px] w-full resize-y rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {isLink && (
          <>
            <Button size="sm" variant="secondary" loading={loading} icon={<Link2 size={14} />} onClick={fetchFromLink}>
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
        >
          {t("jdPaste.savedCta")}
        </Button>
      </div>

      {picking && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-line bg-bg-soft/60">
          {pickBusy && !apps && <p className="p-3 text-sm text-ink-muted">{t("jdPaste.savedLoading")}</p>}
          {apps?.length === 0 && <p className="p-3 text-sm text-ink-muted">{t("jdPaste.savedNone")}</p>}
          {apps?.map((a) => (
            <button
              key={a.id}
              type="button"
              disabled={pickBusy}
              onClick={() => pick(a.id)}
              className="block w-full border-b border-line/60 px-3 py-2 text-start transition-colors last:border-b-0 hover:bg-panel-2/70 focus-visible:bg-panel-2/70 focus-visible:outline-none disabled:opacity-60"
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
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
