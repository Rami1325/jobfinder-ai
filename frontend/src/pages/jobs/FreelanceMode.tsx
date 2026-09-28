// The Jobs page's "Freelance & contract" mode (2026-09-28, freelance part 3):
// the switch over the search, the line under it, the count of what a freelance
// search left out, and the honest note that most freelance work is listed
// elsewhere. The SERVER does every judgement (`job_search.freelance_kept`, on
// each board's own field): nothing here reads a title or a label.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Briefcase, Handshake } from "lucide-react";
import GigLinks from "../../components/GigLinks";
import { Button, Card } from "../../components/ui";
import { cn } from "../../lib/cn";
import type { SearchMode } from "../../types";
import { SEARCH_MODES } from "./shared";

const MODE_KEY = "jobfinder.searchMode";

function readMode(): SearchMode {
  try {
    return localStorage.getItem(MODE_KEY) === "freelance" ? "freelance" : "jobs";
  } catch {
    return "jobs";
  }
}

/** The mode the switch shows, remembered on this device only (a convenience:
 * the server never needs it, and a blocked storage just starts on "Jobs"). */
export function useSearchMode(): [SearchMode, (m: SearchMode) => void] {
  const [mode, setMode] = useState<SearchMode>(readMode);
  function choose(m: SearchMode) {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* private window: the switch still works for this visit */
    }
  }
  return [mode, choose];
}

/** "Jobs / Freelance & contract": two 44 px choices on a phone, one line. The
 * line saying what the mode keeps shows under it on the open search card; the
 * folded card leaves it out (`hint={false}`), because that card is what the page
 * opens on and every line of it pushes the first job down (measured: the switch
 * alone moved the first saved job from 567 to 621 px at 390, and the line would
 * add 38 more). There the summary says "freelance & contract" after a search. */
export function SearchModeSwitch({
  mode,
  onChange,
  disabled = false,
  hint = true,
  className,
}: {
  mode: SearchMode;
  onChange: (m: SearchMode) => void;
  disabled?: boolean;
  hint?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("jobs");
  return (
    <div className={className}>
      <div
        role="radiogroup"
        aria-label={t("freelance.modeLabel")}
        className="inline-flex max-w-full rounded-lg border border-line bg-bg-soft p-0.5"
      >
        {SEARCH_MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            disabled={disabled}
            onClick={() => onChange(m)}
            className={cn(
              "min-h-11 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors disabled:opacity-50 sm:px-4 lg:min-h-9",
              mode === m ? "bg-panel text-ink shadow-sm" : "text-ink-muted hover:text-ink",
            )}
          >
            {m === "freelance" ? t("freelance.modeFreelance") : t("freelance.modeJobs")}
          </button>
        ))}
      </div>
      {hint && mode === "freelance" && <p className="mt-1.5 text-xs text-ink-muted">{t("freelance.hint")}</p>}
    </div>
  );
}

/** "N jobs left out: their boards don't list them as contract or freelance."
 * Quiet, like the applied count; nothing for none. */
export function NotFreelanceCount({ count }: { count: number }) {
  const { t } = useTranslation("jobs");
  if (count <= 0) return null;
  return (
    <p className="flex items-start gap-2 text-xs text-ink-muted">
      <Briefcase size={13} aria-hidden className="mt-px shrink-0" />
      <span className="min-w-0">{t("freelance.leftOut", { count })}</span>
    </p>
  );
}

/** Under a freelance search's results: most freelance work in Israel is posted
 * where JobFinder cannot read it, so the page says so, opens the proposal writer
 * for a gig found there, and links to where to look, with the search's own
 * title filled in (`GigLinks`: plain links, nothing read). With nothing found it
 * IS the answer, in a card. */
export function FreelanceNote({ empty, title }: { empty: boolean; title: string }) {
  const { t } = useTranslation("jobs");
  const nav = useNavigate();
  const body = (
    <>
      {empty && <p className="text-sm font-semibold text-ink">{t("freelance.none")}</p>}
      <p className={cn("text-sm text-ink-muted", empty && "mt-1")}>{t("freelance.few")}</p>
      <Button
        size="sm"
        variant="secondary"
        className="mt-2 min-h-11 lg:min-h-0"
        icon={<Handshake size={14} />}
        onClick={() => nav("/tools/proposal")}
      >
        {t("freelance.pasteGig")}
      </Button>
      {/* The row bleeds to the box's own edges: the Card's p-5, the note's px-3. */}
      <GigLinks title={title} bleed={empty ? "-mx-5 px-5" : "-mx-3 px-3"} className="mt-3" />
    </>
  );
  return empty ? <Card>{body}</Card> : <div className="rounded-lg border border-line px-3 py-3">{body}</div>;
}
