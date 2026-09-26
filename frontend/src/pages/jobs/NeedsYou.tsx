// "Needs you" (PLAN 31.5/5): at most three one-tap chips at the top of Jobs,
// each a thing waiting on the person: drafts to review, applications gone
// quiet, and the resume's top fix. Every count is one the page READ, from the
// same readers the tracker and the review use, and a chip appears only once its
// reader has answered with something: nothing when nothing, never a guess.
import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Clock, FileCheck2, Wrench, type LucideIcon } from "lucide-react";
import { getStaleApplications } from "../../api/client";
import { badCount } from "../../components/ReviewPanel";
import { useReview } from "../../hooks/useReview";
import { awaitingReview } from "../../lib/kitsReview";
import { getKitsState, subscribeKits } from "../../state/kitsStore";
import type { ResumeModel } from "../../types";

export function NeedsYou({ resume }: { resume: ResumeModel }) {
  const { t } = useTranslation("jobs");
  const nav = useNavigate();
  // The Tracker entry's own count (`awaitingReview`): 0 for a list never loaded.
  const { kits } = useSyncExternalStore(subscribeKits, getKitsState);
  const drafts = awaitingReview(kits);
  // The tracker's own "gone quiet" list, the one its nudge reads.
  const [quiet, setQuiet] = useState(0);
  useEffect(() => {
    let live = true;
    getStaleApplications()
      .then((items) => {
        if (live) setQuiet(items.length);
      })
      .catch(() => {}); // unknown is no chip, never a zero said out loud
    return () => {
      live = false;
    };
  }, []);
  // The review of the master, the same free, deterministic check the document
  // runs: only its "to fix" count, the drawer's own number.
  const review = useReview(resume, null);
  const fix = badCount(review.data);

  const chips: { key: string; label: string; Icon: LucideIcon; go: () => void }[] = [];
  if (drafts > 0)
    chips.push({ key: "drafts", label: t("needs.drafts", { count: drafts }), Icon: FileCheck2, go: () => nav("/tracker", { state: { show: "review" } }) });
  if (quiet > 0) chips.push({ key: "quiet", label: t("needs.quiet", { count: quiet }), Icon: Clock, go: () => nav("/tracker") });
  if (fix > 0) chips.push({ key: "fix", label: t("needs.fix", { count: fix }), Icon: Wrench, go: () => nav("/app", { state: { pane: "review" } }) });
  if (!chips.length) return null;

  return (
    <ul aria-label={t("needs.label")} className="flex flex-wrap gap-2">
      {chips.map(({ key, label, Icon, go }) => (
        <li key={key}>
          <button
            type="button"
            onClick={go}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-warn/40 bg-warn/10 px-3 text-xs font-semibold text-ink transition-colors hover:bg-warn/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            <Icon size={14} aria-hidden className="shrink-0 text-warn" />
            {label}
          </button>
        </li>
      ))}
    </ul>
  );
}
