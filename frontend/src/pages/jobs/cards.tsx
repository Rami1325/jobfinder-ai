// Job result/history card components (split out of JobsPage.tsx — PLAN 12.5d).
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Building2,
  ExternalLink,
  MessageCircle,
  Send,
  Trash2,
} from "lucide-react";
import { Badge, BorderGlow, Button, CountUp, ProgressRing } from "../../components/ui";
import { fitReason } from "../../lib/fitReason";
import type { JobMatch, JobSearchHit } from "../../types";
import { avatarTone, companyDomain, isNewPosting, postedAgo, sourceLabel } from "./shared";

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
export function WhatsAppShare({ title, company, url }: { title: string; company: string; url: string }) {
  const { t } = useTranslation("jobs");
  if (!url) return null;
  const text = `${title || t("card.untitled")}${company ? ` — ${company}` : ""}\n${url}`;
  return (
    <a
      href={`https://wa.me/?text=${encodeURIComponent(text)}`}
      target="_blank"
      rel="noreferrer"
      title={t("card.shareWhatsApp")}
      className="inline-flex items-center gap-1 text-mint hover:underline"
    >
      <MessageCircle size={12} /> {t("card.share")}
    </a>
  );
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
export function KeywordChips({ matched, gaps }: { matched?: string[]; gaps: string[] }) {
  const top = (matched ?? []).slice(0, 3);
  if (top.length === 0 && gaps.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {top.map((k) => (
        <Badge key={`ok-${k}`} tone="covered">
          {k}
        </Badge>
      ))}
      {gaps.map((g) => (
        <Badge key={g} tone="missing">
          {g}
        </Badge>
      ))}
    </div>
  );
}

/** Job-result card surface — every row gets the cursor-reactive BorderGlow;
 * the top match is still called out by its mint "best" badge. */
export function JobResultCard({ children }: { children: ReactNode }) {
  return (
    <BorderGlow innerClassName="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
      {children}
    </BorderGlow>
  );
}

export function MatchCard({ m, best, appStatus }: { m: JobMatch; best: boolean; appStatus?: string }) {
  const nav = useNavigate();
  const { t } = useTranslation("jobs");
  return (
    <JobResultCard>
      <ProgressRing value={m.overall} size={92} stroke={8} label={t("card.fit")} />
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <CompanyAvatar company={m.company} url={m.url || undefined} logoUrl={m.logo_url} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {best && <Badge tone="mint" className="shrink-0">{t("card.best")}</Badge>}
            <p className="min-w-0 max-w-full truncate font-semibold text-ink">
              {m.title || t("card.untitled")}
            </p>
            <NewBadge postedAt={m.posted_at} />
            {m.source && <Badge className="shrink-0">{sourceLabel(m.source)}</Badge>}
            {appStatus && <AppStatusBadge status={appStatus} />}
          </div>
          <p className="text-sm text-ink-muted">
            {m.company || "—"}
            {m.location ? ` · ${m.location}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
            <span>
              {t("card.atsLabel")}{" "}
              <CountUp
                to={Math.round(m.keyword_coverage)}
                duration={0.9}
                suffix="%"
                className="font-medium tabular-nums text-ink"
              />
            </span>
            <span>
              {t("card.recruiterFitLabel")}{" "}
              <CountUp
                to={Math.round(m.fit_score)}
                duration={0.9}
                suffix="%"
                className="font-medium tabular-nums text-ink"
              />
            </span>
            {m.posted_at && (
              <span title={m.posted_at}>{t("card.posted", { when: postedAgo(m.posted_at, t) })}</span>
            )}
            {m.url && (
              <a
                href={m.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent-soft hover:underline"
              >
                <ExternalLink size={12} /> {t("card.viewOn", { source: sourceLabel(m.source) || "LinkedIn" })}
              </a>
            )}
            <WhatsAppShare title={m.title} company={m.company} url={m.url} />
          </div>
          {(() => {
            const reason = fitReason(m.top_matched, m.top_gaps, t);
            return reason ? (
              <p dir="auto" className="mt-2 text-xs text-ink-faint">{reason}</p>
            ) : null;
          })()}
          <KeywordChips matched={m.top_matched} gaps={m.top_gaps} />
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-2">
        <Button
          variant="secondary"
          icon={<ArrowRight size={15} className="rtl:-scale-x-100" />}
          onClick={() =>
            nav("/app", {
              state: {
                jdText: m.jd_text,
                jobUrl: m.url || undefined,
                jobTitle: m.title,
                company: m.company,
              },
            })
          }
        >
          {t("card.tailorToThis")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Send size={14} className="rtl:-scale-x-100" />}
          onClick={() =>
            nav("/tools/outreach", {
              state: { jdText: m.jd_text, company: m.company, jobTitle: m.title },
            })
          }
        >
          {t("card.outreach")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Building2 size={14} />}
          onClick={() =>
            nav("/tools/company-brief", {
              state: { jdText: m.jd_text, company: m.company, jobTitle: m.title },
            })
          }
        >
          {t("card.brief")}
        </Button>
      </div>
    </JobResultCard>
  );
}

export function HistoryRow({ hit, onDelete }: { hit: JobSearchHit; onDelete: (id: number) => void }) {
  const nav = useNavigate();
  const { t } = useTranslation("jobs");
  return (
    <JobResultCard>
      <ProgressRing value={hit.overall} size={64} stroke={6} label={t("card.fit")} />
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <CompanyAvatar company={hit.company} url={hit.url || undefined} logoUrl={hit.logo_url} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="min-w-0 max-w-full truncate font-semibold text-ink">
              {hit.title || t("card.untitled")}
            </p>
            <NewBadge postedAt={hit.posted_at} />
            {hit.source && <Badge className="shrink-0">{sourceLabel(hit.source)}</Badge>}
            <AppStatusBadge status={hit.app_status} />
          </div>
          <p className="text-sm text-ink-muted">
            {hit.company || "—"}
            {hit.location ? ` · ${hit.location}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
            <span>{t("history.searchedOn", { date: hit.searched_at.slice(0, 10) })}</span>
            {hit.posted_at && (
              <span title={hit.posted_at}>{t("card.posted", { when: postedAgo(hit.posted_at, t) })}</span>
            )}
            {hit.url && (
              <a
                href={hit.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent-soft hover:underline"
              >
                <ExternalLink size={12} /> {t("card.openOn", { source: sourceLabel(hit.source) || "LinkedIn" })}
              </a>
            )}
            <WhatsAppShare title={hit.title} company={hit.company} url={hit.url} />
          </div>
          {(() => {
            const reason = fitReason(hit.top_matched, hit.top_gaps, t);
            return reason ? (
              <p dir="auto" className="mt-2 text-xs text-ink-faint">{reason}</p>
            ) : null;
          })()}
          <KeywordChips matched={hit.top_matched} gaps={hit.top_gaps} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<ArrowRight size={14} className="rtl:-scale-x-100" />}
          onClick={() =>
            nav("/app", {
              state: {
                jdText: hit.jd_text,
                jobUrl: hit.url || undefined,
                jobTitle: hit.title,
                company: hit.company,
              },
            })
          }
        >
          {t("card.tailor")}
        </Button>
        <button
          onClick={() =>
            nav("/tools/outreach", {
              state: { jdText: hit.jd_text, company: hit.company, jobTitle: hit.title },
            })
          }
          title={t("card.outreach")}
          className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-line p-2 text-ink-muted transition-all hover:-translate-y-0.5 hover:border-accent/50 hover:text-accent-soft md:min-h-0 md:min-w-0"
        >
          <Send size={14} className="rtl:-scale-x-100" />
        </button>
        <button
          onClick={() =>
            nav("/tools/company-brief", {
              state: { jdText: hit.jd_text, company: hit.company, jobTitle: hit.title },
            })
          }
          title={t("card.brief")}
          className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-line p-2 text-ink-muted transition-all hover:-translate-y-0.5 hover:border-accent/50 hover:text-accent-soft md:min-h-0 md:min-w-0"
        >
          <Building2 size={14} />
        </button>
        <button
          onClick={() => onDelete(hit.id)}
          title={t("card.removeFromHistory")}
          className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-line p-2 text-ink-muted transition-all hover:-translate-y-0.5 hover:border-danger/50 hover:text-danger md:min-h-0 md:min-w-0"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </JobResultCard>
  );
}

