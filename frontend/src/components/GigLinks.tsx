// "Look for gigs on" (2026-09-28, freelance): one quiet labelled row of plain
// links to the freelance platforms' own search pages, the search's title filled
// in (`lib/gigLinks.ts`, whose templates check-mirrors 105 holds to the research's
// verified table). JobFinder never fetches, reads or stores those pages: each chip
// is an <a> that opens the platform in a new tab, and nothing here asks the
// server anything. Shown under every freelance result and on the proposal tool.
//
// ONE row at every width, the "Needs you" strip's pattern: it scrolls sideways
// instead of wrapping (a second row would push what is under it down), bleeds to
// its container's edges (`bleed`, a literal class the caller hands in, so the
// chip that does not fit peeks in at the edge), draws no scrollbar, and each chip
// is a 44 px target on a phone with its focus ring inset (a scroller clips an
// outer one). A brand keeps its Latin name in Hebrew, isolated by <bdi> so "We
// Work Remotely" reads left to right inside the right-to-left row.
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight } from "lucide-react";
import { gigLinks } from "../lib/gigLinks";
import { cn } from "../lib/cn";

export default function GigLinks({
  title,
  bleed,
  className,
}: {
  /** The search's title; empty or absent opens each platform's general page. */
  title?: string | null;
  /** The container's padding, as a literal negative-margin + padding class pair. */
  bleed: string;
  className?: string;
}) {
  const { t, i18n } = useTranslation("jobs");
  const labelId = useId();
  const links = gigLinks(title, i18n.language);
  return (
    <div className={className}>
      <p id={labelId} className="text-xs text-ink-muted">
        {t("gigs.label")}
      </p>
      <ul
        aria-labelledby={labelId}
        className={cn("mt-1 flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", bleed)}
      >
        {links.map((link) => (
          <li key={link.id} className="shrink-0">
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t("gigs.opens", { site: link.name })}
              className="inline-flex min-h-11 items-center gap-1 whitespace-nowrap rounded-full border border-line bg-bg-soft px-3 text-xs font-medium text-ink transition-colors hover:border-accent/60 hover:text-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70 lg:min-h-9"
            >
              <bdi>{link.name}</bdi>
              <ArrowUpRight size={12} aria-hidden className="shrink-0 text-ink-faint" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
