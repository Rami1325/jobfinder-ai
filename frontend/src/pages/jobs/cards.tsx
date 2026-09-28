// Job result/history card components (split out of JobsPage.tsx — PLAN 12.5d).
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ArrowRight,
  Banknote,
  Building2,
  ExternalLink,
  EyeOff,
  Ghost,
  Globe,
  Laptop,
  MessageCircle,
  Bookmark,
  BookmarkCheck,
  Send,
  Trash2,
  Users,
  Wand2,
} from "lucide-react";
import { listKits, saveApplication } from "../../api/client";
import { Badge, BorderGlow, Button, MoreMenu, useToast, type MoreItem } from "../../components/ui";
import { cn } from "../../lib/cn";
import { fitReason } from "../../lib/fitReason";
import { useUses } from "../../lib/usesStore";
import { getKitsState, startKitBatch, subscribeKits } from "../../state/kitsStore";
import type {
  Applicants,
  FilteredJob,
  GeoRestriction,
  GhostReport,
  GhostSignal,
  JobMatch,
  JobSearchHit,
} from "../../types";
import type { AlsoOn } from "../../types";
import {
  applicantsText,
  avatarTone,
  companyDomain,
  isNewPosting,
  jdTextWithLocation,
  kitJobFromMatch,
  normalizeJobUrl,
  postedAgo,
  sourceLabel,
} from "./shared";

/** Cross-board dedupe (PLAN 15.1): the same posting found on other boards —
 * one merged card, with each duplicate board linked so the user can apply
 * wherever they prefer. */
function AlsoOnLinks({ links }: { links?: AlsoOn[] }) {
  const { t, i18n } = useTranslation("jobs");
  if (!links?.length) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-ink-muted">
      {t("card.alsoOn")}
      {links.map((a) => (
        <a
          key={a.url}
          href={a.url}
          target="_blank"
          rel="noreferrer"
          className="text-accent-soft underline-offset-2 hover:underline"
        >
          {sourceLabel(a.source, i18n.language)}
        </a>
      ))}
    </span>
  );
}

/** Company logo when the job board provided one, else the company favicon when
 * the job URL points at a company domain, else a lettered avatar on a
 * background derived deterministically from the name. */
export function CompanyAvatar({ company, url, logoUrl }: { company: string; url?: string; logoUrl?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const domain = url ? companyDomain(url) : null;
  const candidates = [
    logoUrl || null,
    domain
      ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`
      : null,
  ].filter((s): s is string => !!s && !failed.includes(s));
  const src = candidates[0];
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={40}
        height={40}
        loading="lazy"
        onError={() => setFailed((f) => [...f, src])}
        className={`h-10 w-10 shrink-0 rounded-lg border border-line bg-panel-2 object-contain ${
          src === logoUrl ? "p-1" : "p-1.5"
        }`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-base font-bold ${avatarTone(company || "?")}`}
    >
      {(company.trim().charAt(0) || "•").toUpperCase()}
    </span>
  );
}

/** WhatsApp share for a job card — Israel's default way to pass a job along. */
/** A WhatsApp share of the posting: its title, company and link. An entry in
 * the job row's "⋯" since PLAN 31.2/5, where it was a link on every card. */
export function whatsAppHref(title: string, company: string, url: string, t: TFunction<"jobs">): string {
  const text = `${title || t("card.untitled")}${company ? ` — ${company}` : ""}\n${url}`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}


export function NewBadge({ postedAt }: { postedAt?: string }) {
  const { t } = useTranslation("jobs");
  if (!postedAt || !isNewPosting(postedAt)) return null;
  return (
    <Badge tone="mint" className="shrink-0">
      {t("card.new")}
    </Badge>
  );
}

/** The posting is outside the search's "Posted within" window — by its own
 * card date (old-but-relevant backfill, PLAN 15.6), or because the role was
 * first listed earlier than this listing says — shown with the EARLIEST date a
 * board stated for it, so it is never mistaken for a fresh listing.
 *
 * "First posted" when that date is earlier than this listing's own "Posted"
 * line. Not "earlier listing": for Greenhouse the earlier date is the same
 * listing's `first_published`, so that wording would be false there. */
export function StaleBadge({
  stale,
  postedAt,
  firstPostedAt,
}: {
  stale?: boolean;
  postedAt?: string;
  firstPostedAt?: string;
}) {
  const { t } = useTranslation("jobs");
  const shown = firstPostedAt || postedAt; // an old backend sends no field: today's behaviour
  if (!stale || !shown) return null;
  // The backend returns the card's own string verbatim unless it found an
  // EARLIER board date (ghost_signals.earliest_board_date), so a different
  // string IS an earlier date. No date comparison lives here: one matcher,
  // one answer.
  const earlier = !!firstPostedAt && firstPostedAt !== postedAt;
  return (
    <Badge tone="partial" className="shrink-0" title={shown}>
      {earlier
        ? t("card.olderFirstPosted", { when: postedAgo(shown, t) })
        : t("card.older", { when: postedAgo(shown, t) })}
    </Badge>
  );
}

/** The board's own competition line (Phase 32): "131 applicants on LinkedIn".
 *
 * Quiet on purpose: text, never a badge, at 12 px beside the age badges on both
 * rows, so on a fresh posting (which carries New) it rides a row the card
 * already has and a phone still shows three jobs a screen (job-search.md). Mint
 * for "early", the one reading that says hurry; muted for a count. It says the
 * board's name because the number is the board's, one board's, not a count of
 * everyone who applied anywhere. Nothing at all when `applicantsText` has
 * nothing to say (no reading, one the server found stale, an unknown kind). */
export function CompetitionLine({ applicants }: { applicants?: Applicants | null }) {
  const { t } = useTranslation("jobs");
  const text = applicantsText(applicants, t);
  if (!text) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs",
        applicants?.kind === "early" ? "text-mint" : "text-ink-muted",
      )}
    >
      <Users size={12} aria-hidden className="shrink-0" />
      {text}
    </span>
  );
}

/** A hiring restriction the posting STATES, quoted from the posting itself.
 *
 * A full-width line, not a badge: the badge row already carries up to seven
 * shrink-0 children in ~264px at 390px, an eighth forces a wrap on exactly the
 * users this is for, and a two-word badge cannot carry the evidence. The quote
 * is what makes an occasionally-wrong detector usable — if we fire on an EEO
 * paragraph, the sentence is instantly recognisable as a misfire and the user
 * adjudicates instead of trusting us. It cannot live in `title`: there is no
 * hover on a phone.
 *
 * `dir="auto"` is correct HERE (unlike on the resume sheet, where it flips a
 * whole document): the quote is in the POSTING's language, which need not be
 * the UI locale. `break-words` is load-bearing — `raw` is untrusted third-party
 * text. A Globe, never a warning triangle: at 12px in amber a triangle reads as
 * an app error rather than a property of the job. */
export function GeoNote({ geo }: { geo?: GeoRestriction | null }) {
  const { t } = useTranslation("jobs");
  if (!geo) return null;
  const key = ["us", "uk", "eu", "il_excluded"].includes(geo.scope) ? geo.scope : "other";
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-warn">
      <Globe size={12} className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">
        {t(`card.geo.${key}`)}
        {geo.raw ? (
          // <bdi> + dir="auto" on the QUOTE, never on the paragraph: the
          // paragraph's first strong character is the translated label, so a
          // paragraph-level dir="auto" resolves from the UI locale and leaves
          // the posting's own sentence unisolated — in Hebrew the quotes and
          // the final period then reorder around the English run.
          <bdi dir="auto" className="text-ink-faint">
            {" · “"}
            {geo.raw}
            {"”"}
          </bdi>
        ) : null}
      </span>
    </p>
  );
}

/** Why a worldwide posting was hidden before it took a result slot: its
 * location names a country where pay is well below Israel's. That location is
 * the only thing the backend's rule reads, so it is the evidence, and the
 * sentence quotes it rather than naming a country we inferred from it.
 *
 * `GeoNote`'s shape, for `GeoNote`'s reasons: a full-width line with the
 * evidence on the page, because there is no hover on a phone, and
 * `break-words`, because the location is untrusted board text.
 *
 * The location is wrapped in FIRST STRONG ISOLATE ... POP DIRECTIONAL ISOLATE,
 * the text form of `GeoNote`'s `<bdi dir="auto">`, because a `t()` value cannot
 * carry an element. Measured in Chromium inside the Hebrew sentence: "Sofia,
 * Sofia City, Bulgaria" and even "Sofia (Remote)" draw in order without it
 * (brackets resolve as a pair), but "1000 Sofia, Bulgaria" draws its number
 * out of place, and board text is untrusted.
 *
 * No `PostingNote` under it: "Quoted from the posting" is about a sentence the
 * posting wrote, and this row quotes none. A Banknote, never a warning
 * triangle, for `GeoNote`'s reason. */
function MarketNote({ location }: { location: string }) {
  const { t } = useTranslation("jobs");
  if (!location) return null;
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-warn">
      <Banknote size={12} className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">
        {t("card.marketNote", { location: `\u2068${location}\u2069` })}
      </span>
    </p>
  );
}

/** Why a posting was hidden for its work mode, in the posting's own words. The
 * backend read them (`app.core.work_mode`) after the fetch and before any model
 * call, so the modes it states and the words that stated them ARE the evidence,
 * quoted like `GeoNote`'s sentence. "work_mode": it states only modes the user did
 * not pick. "not_remote": it came from the worldwide pass and does not say it is
 * remote, which may mean it states other modes or states none. */
function WorkModeNote({ job }: { job: FilteredJob }) {
  const { t } = useTranslation("jobs");
  const modes = (job.work_modes ?? []).map((m) => t(`workModes.${m}`)).join(", ");
  const sentence =
    job.reason === "work_mode"
      ? t("card.workModeNote", { modes })
      : modes
        ? t("card.notRemoteNote", { modes })
        : t("card.notRemoteSilent");
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-warn">
      {job.reason === "work_mode" ? (
        <Building2 size={12} className="mt-0.5 shrink-0" />
      ) : (
        <Laptop size={12} className="mt-0.5 shrink-0" />
      )}
      <span className="min-w-0 break-words">
        {sentence}
        {job.work_mode_evidence ? (
          // Isolated on the QUOTE, for GeoNote's reason: an English sentence
          // inside a Hebrew line reorders around its own quotes otherwise.
          <bdi dir="auto" className="text-ink-faint">
            {" · “"}
            {job.work_mode_evidence}
            {"”"}
          </bdi>
        ) : null}
      </span>
    </p>
  );
}

// Every ghost `kind` this build has a string for. A newer backend may emit a
// kind we have never heard of, and `t("card.ghost.<unknown>")` renders the KEY
// — a dotted path at 12px in amber, on the card, in production. So an unknown
// kind is skipped and the next-strongest known signal is shown instead;
// abstention is the safe direction here exactly as it is in the classifier.
const GHOST_KINDS = ["closed", "evergreen", "long_open", "reposted"];

// Sort key for `strength`. An unrecognised value from a newer backend sorts
// LAST rather than throwing — the same reason `strength` is a plain string on
// the type and not a union.
const GHOST_RANK: Record<string, number> = { certain: 0, strong: 1, weak: 2 };

/** The ONE ghost signal a card shows, or null when it shows none.
 *
 * Two decisions live here rather than at the call sites, so nothing can drift
 * between what the card DRAWS and what it suppresses for.
 *
 * **`closed || likely` is the threshold, never `signals.length > 0`.** The
 * backend owns one pinned rule for `likely` (>= 1 strong, or >= 2 weak) and
 * re-deriving a second one here would be two gates answering the same question
 * about the same posting — the correction the geo work already paid for once.
 * It also matters in the false-positive direction: a lone weak signal is the
 * "we're always looking for great people" line that ships inside the about-us
 * blurb of perfectly real postings, and an amber warning on it is a guard
 * firing on legitimate input, which is worse than no guard.
 *
 * The pick is a STABLE sort by strength, so the backend's own rule order
 * survives inside a rank — a partition, never a re-sort. */
export function strongestGhostSignal(ghost?: GhostReport | null): GhostSignal | null {
  if (!ghost || !(ghost.closed || ghost.likely)) return null;
  const known = (ghost.signals ?? []).filter((s) => GHOST_KINDS.includes(s.kind));
  return (
    [...known].sort((a, b) => (GHOST_RANK[a.strength] ?? 9) - (GHOST_RANK[b.strength] ?? 9))[0] ??
    null
  );
}

/** One signal's label. `t` is passed in so this stays a plain function — it is
 * called from `GhostNote`'s render AND from its `title` builder, and a second
 * `useTranslation` inside a loop is a hook in a loop. */
function ghostLabel(s: GhostSignal, t: TFunction<"jobs">): string {
  if (s.kind !== "long_open") return t(`card.ghost.${s.kind}`);
  // `basis` separates two claims that must never share a sentence.
  // "first_published" is the BOARD's own publish date — "Posted N days ago".
  // Anything else falls to the sightings phrasing, which describes OUR
  // observation: it is the claim we can always substantiate, because a signal
  // we emitted is by construction a posting we have seen. Printing "Posted N
  // days ago" off a number the board never gave us would be inventing an
  // attribution, which is the one thing `raw`-style evidence exists to avoid.
  return t(`card.ghost.long_open.${s.basis === "first_published" ? "published" : "seen"}`, {
    days: s.days,
  });
}

/** Reasons to suspect this posting is not a live vacancy — quoted, or counted.
 *
 * `GeoNote`'s shape, for `GeoNote`'s reasons: a full-width line rather than an
 * eighth `shrink-0` badge in a ~264px row at 390px, and the evidence ON THE
 * PAGE rather than in `title`, because there is no hover on a phone and a
 * two-word badge cannot carry a sentence. `break-words` is load-bearing —
 * `raw` is untrusted third-party text, so an unbroken 200-character run would
 * otherwise push the card's own layout sideways. `<bdi dir="auto">` wraps the
 * QUOTE and never the paragraph: the paragraph opens with the translated
 * label, so a paragraph-level `dir="auto"` resolves from the UI locale and
 * leaves the posting's own sentence unisolated — in Hebrew the curly quotes
 * and the trailing period then reorder around an English run.
 *
 * **ONE evidence line, however many signals fired.** Some apps itemise four
 * lines per row; at 390px four stacked evidence lines ARE the card. The rest go
 * in `title`. That is desktop-only and therefore a real degradation — but the
 * signal the card is ASSERTING is always on the page, and `title` carries only
 * corroboration for that same claim. That is the distinction `GeoNote`'s own
 * "it cannot live in `title`" note is drawing: evidence for the claim must be
 * readable on a phone; a second reason to believe it need not be.
 *
 * A Ghost, never a warning triangle, for `GeoNote`'s reason: at 12px in amber a
 * triangle reads as an app error rather than as a property of the job. */
export function GhostNote({ ghost }: { ghost?: GhostReport | null }) {
  const { t } = useTranslation("jobs");
  const shown = strongestGhostSignal(ghost);
  if (!shown) return null;
  const rest = (ghost?.signals ?? []).filter((s) => s !== shown && GHOST_KINDS.includes(s.kind));
  const more = rest
    .map((s) => (s.raw ? `${ghostLabel(s, t)} — “${s.raw}”` : ghostLabel(s, t)))
    .join("\n");
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-warn" title={more || undefined}>
      <Ghost size={12} className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">
        {ghostLabel(shown, t)}
        {shown.raw ? (
          <bdi dir="auto" className="text-ink-faint">
            {" · “"}
            {shown.raw}
            {"”"}
          </bdi>
        ) : null}
      </span>
    </p>
  );
}

/** The honesty line under whichever notes are showing — ONE sentence per card.
 *
 * `card.geoNote` shipped in both locales and was rendered NOWHERE; this is
 * where it renders. Only one disclaimer is drawn even when both notes are up:
 * two of them under two evidence lines is four lines of chrome on a 390px card,
 * and the second is read by nobody. The GEO sentence wins that slot because it
 * is the one with teeth — a location label is the only one of the two that can
 * talk a user out of a job they could actually work, which is exactly what
 * "we report what it says, never whether you qualify" is there to prevent.
 *
 * The ghost twin is not decoration: the geo sentence would be FALSE for a
 * `long_open` signal, whose number is a count out of our own search history
 * rather than a quotation, so "Quoted from the posting" would be an invented
 * attribution. Both keys are reachable — a blocking geo restriction never
 * reaches a `MatchCard` (it was filtered), and a closed `RestrictedRow` carries
 * no geo note at all. */
function PostingNote({ geo, ghost }: { geo: boolean; ghost: boolean }) {
  const { t } = useTranslation("jobs");
  if (!geo && !ghost) return null;
  return (
    <p className="mt-1 text-xs text-ink-faint">{t(geo ? "card.geoNote" : "card.ghost.note")}</p>
  );
}

/** One posting the search dropped before scoring, shown when the user taps
 * "Show them".
 *
 * Same card family as a real result so the revealed list reads as one list —
 * but deliberately NO ProgressRing and no Tailor / Application-kit buttons: it
 * was filtered before analyze_and_score ever ran, so a ring at 0 or "—" would
 * read as a zero fit, which is a number we never computed. */
export function RestrictedRow({ job }: { job: FilteredJob }) {
  const { t, i18n } = useTranslation("jobs");
  const lang = i18n.language;
  // One posting, one reason, each tested BY NAME. `reason` defaults to
  // "restriction" on the backend and is ABSENT on a pre-Phase-28 response, so a
  // restriction is `!reason || reason === "restriction"`: an old payload still
  // shows the restriction it was dropped for. The old test, "anything not
  // literally closed is a restriction", went false when `market` arrived: a
  // posting hidden for its country's pay fell into the restriction branch and,
  // having no restriction to quote, showed no reason at all. A reason this
  // build has never heard of draws no note, which is the honest direction.
  const closed = job.reason === "closed";
  const market = job.reason === "market";
  const mode = job.reason === "work_mode" || job.reason === "not_remote";
  const restriction = !job.reason || job.reason === "restriction";
  return (
    <JobResultCard>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <CompanyAvatar company={job.company} url={job.url} logoUrl={job.logo_url} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="min-w-0 max-w-full truncate font-semibold text-ink">
              {job.title || t("card.untitled")}
            </p>
            {job.source && <Badge className="shrink-0">{sourceLabel(job.source, lang)}</Badge>}
            <Badge tone="neutral" className="shrink-0">
              {t("card.geoNotScored")}
            </Badge>
          </div>
          <p className="text-sm text-ink-muted">
            {job.company || "—"}
            {job.location ? ` · ${job.location}` : ""}
          </p>
          {closed ? (
            <GhostNote ghost={job.ghost} />
          ) : market ? (
            <MarketNote location={job.location} />
          ) : mode ? (
            <WorkModeNote job={job} />
          ) : restriction ? (
            <GeoNote geo={job.geo_restriction} />
          ) : null}
          <PostingNote
            geo={restriction && !!job.geo_restriction}
            ghost={closed && !!strongestGhostSignal(job.ghost)}
          />
          {job.url && (
            <a
              href={job.url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs text-accent-soft hover:underline"
            >
              <ExternalLink size={12} /> {t("card.openOn", { source: sourceLabel(job.source, lang) || "LinkedIn" })}
            </a>
          )}
        </div>
      </div>
    </JobResultCard>
  );
}



// Tracker status shown on history rows (colors mirror the Tracker board).
const APP_STATUS: Record<
  string,
  { tone: "neutral" | "mint" | "partial" | "danger"; cls?: string }
> = {
  saved: { tone: "neutral" },
  applied: { tone: "mint" },
  interview: { tone: "partial" },
  offer: { tone: "mint", cls: "border-mint bg-mint font-bold text-bg shadow-glow-mint" },
  rejected: { tone: "danger" },
};

export function AppStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation("jobs");
  const s = APP_STATUS[status];
  if (!s) return null;
  return (
    <Badge tone={s.tone} className={`shrink-0 ${s.cls ?? ""}`}>
      {t(`status.${status}`)}
    </Badge>
  );
}

// Matched (green) then missing (red) JD keywords on a job card. Matched chips
// are capped at 3 (PLAN 5.1/9.1) — the gaps are the actionable part.
/** A job result's surface. Every row wears the cursor-reactive BorderGlow (the
 * owner asked for it on every card, 2026-07-13); the top match is called out by
 * its mint "best" badge. COMPACT since PLAN 31.2/5: a card measured about 700 px
 * at 390 (a 100 px ring, three numbers, five chips and five stacked buttons), so
 * a phone showed one job per screen. */
export function JobResultCard({ children }: { children: ReactNode }) {
  return <BorderGlow innerClassName="flex items-start gap-3 p-3.5">{children}</BorderGlow>;
}

/** The search's one number, as a chip (PLAN 31.2/5): the blend it ranks by
 * (job-search.md, "`overall` is the right currency here"), rounded half-up like
 * every place that reads it (`alerts.displayed_score`, the kit threshold), so
 * this chip, the email and the batch queue cannot disagree about a job. The
 * ring and the two numbers it blends move to the job page (31.4). */
export function MatchChip({ value }: { value: number }) {
  const { t } = useTranslation("jobs");
  return (
    <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-ink">
      {t("card.matchChip", { value: Math.round(value) })}
    </span>
  );
}

export function MatchCard({
  m,
  best,
  appStatus,
  appId,
  onNotForMe,
}: {
  m: JobMatch;
  best: boolean;
  appStatus?: string;
  /** The tracker row the posting is on, which the saved icon opens (PLAN 31.4/6). */
  appId?: number | null;
  /** "Not for me" (PLAN 31.5/4): the page hides the row and offers more. */
  onNotForMe?: () => void;
}) {
  const nav = useNavigate();
  const { t, i18n } = useTranslation("jobs");
  const { t: tCommon } = useTranslation("common");
  const toast = useToast();
  const { batching, kits } = useSyncExternalStore(subscribeKits, getKitsState);
  // Opening a job's existing kit is free and a new one uses 1 (Phase 30 / C4), so
  // at none left the kit entry is disabled only when the loaded kits hold no live
  // kit for this posting. With the list not loaded, the server decides.
  const tailorOut = useUses("tailor").out;
  const hasKit =
    !!m.url && !!kits?.some((k) => k.status !== "failed" && normalizeJobUrl(k.url) === normalizeJobUrl(m.url));
  const kitOut = tailorOut && kits !== null && !hasKit;
  const [kitError, setKitError] = useState("");
  // The page's status map is rebuilt per SEARCH, not per click, so a freshly
  // saved job would keep showing "Save" until the next search without a local
  // override. The row just saved wins over `appStatus` for exactly that window,
  // and its id is the job's page the saved icon opens.
  const [savedId, setSavedId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const status = savedId !== null ? "saved" : appStatus;
  const rowId = savedId ?? appId ?? null;
  // Computed once and shared by the badge row and the note below it, so the
  // suppression rule and the drawn line can never disagree — see the badge row.
  const ghostShown = strongestGhostSignal(m.ghost);

  async function saveForLater() {
    setSaving(true);
    try {
      // The place and the date too, so the job's page can show them (PLAN 31.4).
      const saved = await saveApplication({
        job_title: m.title,
        company: m.company,
        jd_text: m.jd_text,
        overall_score: m.overall,
        job_url: m.url || undefined,
        status: "saved",
        location: m.location || undefined,
        posted_at: m.posted_at || undefined,
      });
      setSavedId(saved.id);
      // With the next step, not only the news (PLAN 31.2/10): the job's page.
      toast("success", t("card.saveDone"), {
        action: { label: tCommon("actions.view"), onClick: () => nav(`/applications/${saved.id}`) },
      });
    } catch {
      toast("error", t("card.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  // Per-job application kit (PLAN 15.9): the auto-apply path for ONE job —
  // batch "Tailor my top matches" was the only way in, and users looking at a
  // specific posting never found it. Creates + processes a single kit, then
  // lands on its review page (approve → send).
  async function makeKit() {
    setKitError("");
    const summary = await startKitBatch([kitJobFromMatch(m)]);
    if (!summary) {
      // A refusal, the monthly limit included, is said under the row rather
      // than in a toast that is gone before anyone reads why.
      setKitError(getKitsState().error);
      return;
    }
    try {
      // The drain may have processed leftover queued kits too — find OURS by
      // URL rather than trusting lastKit.
      const kit = (await listKits()).find((k) => k.url === m.url);
      if (kit && kit.status !== "queued" && kit.status !== "running") {
        if (kit.status === "failed") {
          toast("error", kit.error || t("card.kitFailed"));
        } else {
          nav(`/kits/${kit.id}`); // done/approved/rejected/submitted all review fine
        }
        return;
      }
    } catch {
      /* listing failed — fall through to the generic pointer */
    }
    toast("info", t("card.kitExists"));
  }

  const jdForTools = jdTextWithLocation(m.jd_text, m.location);
  const reason = fitReason(m.top_matched, m.top_gaps, t);
  // What has no slot of its own on a compact row (PLAN 31.2/5). The kit, the
  // outreach and the brief move to the job's own page with 31.4; until then
  // they are here, so a search result keeps every door it had.
  const more: MoreItem[] = [
    ...(m.url && m.jd_text
      ? [{ key: "kit", label: t("card.kit"), Icon: Wand2, onClick: () => void makeKit(), disabled: kitOut || batching }]
      : []),
    {
      key: "outreach",
      label: t("card.outreach"),
      Icon: Send,
      onClick: () => nav("/tools/outreach", { state: { jdText: jdForTools, company: m.company, jobTitle: m.title } }),
    },
    {
      key: "brief",
      label: t("card.brief"),
      Icon: Building2,
      onClick: () =>
        nav("/tools/company-brief", { state: { jdText: jdForTools, company: m.company, jobTitle: m.title } }),
    },
    ...(m.url
      ? [
          {
            key: "open",
            label: t("card.viewOn", { source: sourceLabel(m.source, i18n.language) || "LinkedIn" }),
            Icon: ExternalLink,
            href: m.url,
          },
          { key: "share", label: t("card.shareWhatsApp"), Icon: MessageCircle, href: whatsAppHref(m.title, m.company, m.url, t) },
        ]
      : []),
    ...(onNotForMe ? [{ key: "notForMe", label: t("card.notForMe"), Icon: EyeOff, onClick: onNotForMe }] : []),
  ];

  return (
    <JobResultCard>
      <CompanyAvatar company={m.company} url={m.url || undefined} logoUrl={m.logo_url} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          {/* `dir="auto"`: an English title in the Hebrew UI is an LTR run in
              an RTL box, and `truncate` would clip its START, where the words
              that identify the job are. The toolbar's name has the same rule. */}
          <p dir="auto" className="min-w-0 flex-1 truncate font-semibold text-ink">
            {m.title || t("card.untitled")}
          </p>
          <MatchChip value={m.overall} />
        </div>
        {/* company · when · the work modes the POSTING states · place. Words on
            this line rather than more badges; nothing for modes when it says
            nothing, because unknown is not "on-site" and a "Remote" search
            keeps such a posting on purpose (the hint under the control). The
            place goes LAST because it is the long part ("Tel Aviv District,
            Israel") and the one to lose when the line is cut; `dir="auto"` so
            the cut lands at its end, not at the company's first letters. */}
        <p dir="auto" className="truncate text-sm text-ink-muted">
          {m.company || "—"}
          {m.posted_at && <span title={m.posted_at}>{` · ${postedAgo(m.posted_at, t)}`}</span>}
          {m.work_modes && m.work_modes.length > 0
            ? ` · ${m.work_modes.map((mode) => t(`workModes.${mode}`)).join(" / ")}`
            : ""}
          {m.location ? ` · ${m.location}` : ""}
        </p>
        {/* Only when one of them has something to say (`empty:hidden`). */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 empty:hidden">
          {best && <Badge tone="mint" className="shrink-0">{t("card.best")}</Badge>}
          {/* "New" never sits beside "Older", and it reads the EARLIEST board
              date: a role relisted yesterday, or a Greenhouse role touched
              yesterday but first published last month, is not new at any
              "Posted within" setting. */}
          {!m.stale && <NewBadge postedAt={m.first_posted_at || m.posted_at} />}
          {/* NEVER TWO AGE CHIPS. A `long_open` ghost line and the "Older"
              badge make the same claim — this posting is old — and drawing
              both has the card arguing with itself about which number to
              believe. StaleBadge counts from the earliest BOARD-STATED date
              (`first_posted_at`), not the listing's rewritable `posted_at`,
              but the ghost line still wins because it also carries the
              suspicion — even when its first_seen basis is LATER than
              `first_posted_at` (a known gap: long_open does not read that
              date yet). The alert email follows the same rule
              (`alerts._older_chip_date`). This is the kind of line a later
              edit silently reinstates, so note the two wrong ways to write
              it: an unconditional `<StaleBadge>` puts both back, and gating
              on `m.ghost` instead deletes the age from every card carrying a
              signal we chose NOT to draw. The gate is `ghostShown`, the same
              value `GhostNote` renders — derived, never restated. */}
          {ghostShown?.kind !== "long_open" && (
            <StaleBadge stale={m.stale} postedAt={m.posted_at} firstPostedAt={m.first_posted_at} />
          )}
          {/* Beside the age, in this row rather than a line of its own: a
              LinkedIn posting fresh enough to carry a reading usually carries
              "New" too, so it mostly costs no height (Phase 32). */}
          <CompetitionLine applicants={m.applicants} />
          {m.salary?.raw && (
            <Badge tone="mint" className="shrink-0" title={t("card.salaryNote")}>
              {m.salary.raw}
            </Badge>
          )}
          <AlsoOnLinks links={m.also_on} />
          {status && <AppStatusBadge status={status} />}
        </div>
        <GeoNote geo={m.geo_restriction} />
        <GhostNote ghost={m.ghost} />
        <PostingNote geo={!!m.geo_restriction} ghost={!!ghostShown} />
        {/* The verdict and its reason in one line: the top terms it has and the
            top ones it misses, by name. Not "Has 3 of 5": the lists are the
            first six of each, so a count would be a count of what we kept. */}
        {reason && (
          <p dir="auto" className="mt-1 truncate text-xs text-ink-faint">
            {reason}
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          {/* Secondary (PLAN 31.7, one primary per screen): a list of these
              was a column of blue buttons under the page's own Search again. */}
          <Button
            size="sm"
            variant="secondary"
            icon={<ArrowRight size={14} className="rtl:-scale-x-100" />}
            onClick={() =>
              nav("/app", {
                state: {
                  jdText: jdForTools,
                  jobUrl: m.url || undefined,
                  jobTitle: m.title,
                  company: m.company,
                },
              })
            }
          >
            {t("card.tailor")}
          </Button>
          {status ? (
            // NOT disabled: it is the only route to the job the toast just
            // named, and a disabled button dispatches no click at all. It opens
            // the job's own page (PLAN 31.4/6), the tracker when no row is named.
            <button
              type="button"
              aria-label={rowId ? t("card.savedOpenJob") : t("card.savedGoTracker")}
              title={rowId ? t("card.savedOpenJob") : t("card.savedGoTracker")}
              onClick={() => nav(rowId ? `/applications/${rowId}` : "/tracker")}
              className="grid min-h-8 w-9 place-items-center rounded-lg border border-mint/40 bg-mint/10 text-mint transition hover:bg-mint/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              <BookmarkCheck size={15} aria-hidden />
            </button>
          ) : (
            // Only offered when the posting has a URL. A pasted listing has none
            // (`match_jobs` builds JobMatch without one), so its tracker row
            // could never be matched back by `appStatusByUrl` — the button would
            // reappear on every render and write a duplicate row each time, with
            // no way to reopen the posting from the tracker.
            m.url && (
              <button
                type="button"
                aria-label={t("card.save")}
                title={t("card.save")}
                disabled={saving}
                onClick={saveForLater}
                className="grid min-h-8 w-9 place-items-center rounded-lg border border-line bg-panel text-ink-muted transition hover:border-accent/40 hover:text-ink disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              >
                <Bookmark size={15} aria-hidden />
              </button>
            )
          )}
          <MoreMenu items={more} label={t("card.moreActions")} className="ms-auto" />
        </div>
        {kitError && (
          <p role="alert" className="mt-1.5 text-sm text-danger">
            {kitError}
          </p>
        )}
      </div>
    </JobResultCard>
  );
}

export function HistoryRow({
  hit,
  onDelete,
  opened = false,
  onNotForMe,
}: {
  hit: JobSearchHit;
  onDelete: (id: number) => void;
  /** "Not for me" (PLAN 31.5/4): the page hides the row and offers more. */
  onNotForMe?: () => void;
  /** The job an alert email's link opened (PLAN 31.4/6): the row the page
   * scrolls to, ringed so the reader sees which one it is. */
  opened?: boolean;
}) {
  const nav = useNavigate();
  const { t, i18n } = useTranslation("jobs");
  // The backend hands the listing's own date back verbatim unless a board
  // stated an EARLIER one for the role, so a different string IS an earlier
  // date (the StaleBadge rule): no date comparison lives here. A relisted role
  // is then not "New", and its row says when it was first posted.
  const firstPosted = hit.first_posted_at || hit.posted_at;
  const earlier = !!hit.first_posted_at && hit.first_posted_at !== hit.posted_at;
  const jdForTools = jdTextWithLocation(hit.jd_text, hit.location);
  const reason = fitReason(hit.top_matched, hit.top_gaps, t);
  // The compact row's "⋯" (PLAN 31.2/5), the search row's list plus Remove,
  // which still waits out its undo window (JobsPage `deleteHit`, 31.1/6).
  const more: MoreItem[] = [
    {
      key: "outreach",
      label: t("card.outreach"),
      Icon: Send,
      onClick: () => nav("/tools/outreach", { state: { jdText: jdForTools, company: hit.company, jobTitle: hit.title } }),
    },
    {
      key: "brief",
      label: t("card.brief"),
      Icon: Building2,
      onClick: () =>
        nav("/tools/company-brief", { state: { jdText: jdForTools, company: hit.company, jobTitle: hit.title } }),
    },
    ...(hit.url
      ? [
          {
            key: "open",
            label: t("card.openOn", { source: sourceLabel(hit.source, i18n.language) || "LinkedIn" }),
            Icon: ExternalLink,
            href: hit.url,
          },
          {
            key: "share",
            label: t("card.shareWhatsApp"),
            Icon: MessageCircle,
            href: whatsAppHref(hit.title, hit.company, hit.url, t),
          },
        ]
      : []),
    ...(onNotForMe ? [{ key: "notForMe", label: t("card.notForMe"), Icon: EyeOff, onClick: onNotForMe }] : []),
    { key: "remove", label: t("card.removeFromHistory"), Icon: Trash2, onClick: () => onDelete(hit.id) },
  ];
  return (
    <div id={`hit-${hit.id}`} className={cn("scroll-mt-20 rounded-2xl", opened && "ring-2 ring-accent/70 ring-offset-2 ring-offset-bg")}>
    <JobResultCard>
      <CompanyAvatar company={hit.company} url={hit.url || undefined} logoUrl={hit.logo_url} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p dir="auto" className="min-w-0 flex-1 truncate font-semibold text-ink">
            {hit.title || t("card.untitled")}
          </p>
          <MatchChip value={hit.overall} />
        </div>
        {/* The search row's order and direction, for its reasons. */}
        <p dir="auto" className="truncate text-sm text-ink-muted">
          {hit.company || "—"}
          {hit.posted_at && <span title={hit.posted_at}>{` · ${postedAgo(hit.posted_at, t)}`}</span>}
          {hit.location ? ` · ${hit.location}` : ""}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 empty:hidden">
          <NewBadge postedAt={firstPosted} />
          {/* The search row's place, for its reason (Phase 32). */}
          <CompetitionLine applicants={hit.applicants} />
          {hit.salary?.raw && (
            <Badge tone="mint" className="shrink-0" title={t("card.salaryNote")}>
              {hit.salary.raw}
            </Badge>
          )}
          <AlsoOnLinks links={hit.also_on} />
          <AppStatusBadge status={hit.app_status} />
        </div>
        <p className="mt-1 text-xs text-ink-faint">
          {t("history.searchedOn", { date: hit.searched_at.slice(0, 10) })}
          {earlier && (
            <span title={hit.first_posted_at}>
              {" · "}
              {t("card.firstPosted", { when: postedAgo(hit.first_posted_at ?? "", t) })}
            </span>
          )}
        </p>
        {reason && (
          <p dir="auto" className="mt-1 truncate text-xs text-ink-faint">
            {reason}
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          {/* Secondary (PLAN 31.7, one primary per screen): a list of these
              was a column of blue buttons under the page's own Search again. */}
          <Button
            size="sm"
            variant="secondary"
            icon={<ArrowRight size={14} className="rtl:-scale-x-100" />}
            onClick={() =>
              nav("/app", {
                state: {
                  jdText: jdForTools,
                  jobUrl: hit.url || undefined,
                  jobTitle: hit.title,
                  company: hit.company,
                },
              })
            }
          >
            {t("card.tailor")}
          </Button>
          {/* A History row on the tracker opens its job's page, as a saved
              search result does (PLAN 31.4/6). */}
          {hit.app_id ? (
            <button
              type="button"
              aria-label={t("card.savedOpenJob")}
              title={t("card.savedOpenJob")}
              onClick={() => nav(`/applications/${hit.app_id}`)}
              className="grid min-h-8 w-9 place-items-center rounded-lg border border-mint/40 bg-mint/10 text-mint transition hover:bg-mint/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              <BookmarkCheck size={15} aria-hidden />
            </button>
          ) : null}
          <MoreMenu items={more} label={t("card.moreActions")} className="ms-auto" />
        </div>
      </div>
    </JobResultCard>
    </div>
  );
}
