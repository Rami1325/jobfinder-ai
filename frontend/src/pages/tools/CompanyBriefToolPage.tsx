import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Building2,
  Copy,
  ExternalLink,
  UserSearch,
  Mail,
  ShieldAlert,
  Sparkles,
  Users,
} from "lucide-react";
import { companyBrief } from "../../api/client";
import JDPaste from "../../components/JDPaste";
import ResumeGate from "../../components/ResumeGate";
import ToolShell from "../../components/ToolShell";
import UsesNote from "../../components/UsesNote";
import { useJobContext } from "../../hooks/useJobContext";
import { useMasterResume } from "../../hooks/useMasterResume";
import { apiErrorMessage } from "../../lib/apiError";
import { useUses } from "../../lib/usesStore";
import { Badge, Button, Card, CardTitle, Skeleton, useToast } from "../../components/ui";
import type { CompanyBriefResult } from "../../types";

type NavState = { jdText?: string; company?: string; jobTitle?: string; url?: string } | null;

const input =
  "w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none";

/** Deterministic LinkedIn people-search deep link (mirrors the backend helper). */
function linkedinSearch(query: string) {
  return "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(query);
}

export default function CompanyBriefToolPage() {
  const { t } = useTranslation("tools");
  const { master, loading } = useMasterResume();
  const prefill = (useLocation().state as NavState) ?? null;
  const [company, setCompany] = useState(prefill?.company ?? "");
  const [url, setUrl] = useState(prefill?.url ?? "");
  const [pageText, setPageText] = useState("");
  const [jdText, setJdText] = useState(prefill?.jdText ?? "");
  // Editable: the role drives the deterministic "hiring chain" targeting
  // (AI Engineer ⇒ CTO / Head of AI chips) as well as the reach-out message.
  const [jobTitle, setJobTitle] = useState(prefill?.jobTitle ?? "");
  // Opened from a job's page (PLAN 31.4/3): its row fills every field the
  // handoff left empty, and survives a reload, which navigation state does not.
  const ctx = useJobContext();
  const job = ctx?.job ?? null;
  useEffect(() => {
    if (!job) return;
    setCompany((cur) => cur || job.company);
    setUrl((cur) => cur || job.job_url);
    setJdText((cur) => cur || job.jd_text);
    setJobTitle((cur) => cur || job.job_title);
  }, [job]);
  const [result, setResult] = useState<CompanyBriefResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const uses = useUses("company_brief");

  const canRun = Boolean(url.trim() || pageText.trim() || jdText.trim());

  async function run() {
    if (!master?.resume || !canRun) return;
    setRunning(true);
    setResult(null);
    setError("");
    try {
      setResult(
        await companyBrief({
          resume: master.resume,
          company,
          url,
          page_text: pageText,
          jd_text: jdText,
          job_title: jobTitle,
        }),
      );
    } catch (e) {
      // Under the button rather than in a toast (Phase 30 / C4): a refusal, the
      // monthly limit included, stays beside the note that priced the tap.
      setError(apiErrorMessage(e, t("brief.error")));
    } finally {
      setRunning(false);
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    toast("success", t("brief.copied"));
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!master?.resume) return <ResumeGate feature={t("brief.gateFeature")} />;

  return (
    <ToolShell
      title={t("cards.brief.title")}
      subtitle={t("brief.subtitle")}
      icon={<Building2 className="text-accent-soft" />}
      back={ctx?.backTo}
    >
      <Card>
        {jobTitle && (
          <p className="mb-3 text-sm text-ink-muted" dir="auto">
            {t("brief.targeting", { role: jobTitle, company: company || "—" })}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-ink-muted">{t("brief.company")}</label>
            <input
              dir="auto"
              className={input}
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder={t("brief.companyPlaceholder")}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">{t("brief.role")}</label>
            <input
              dir="auto"
              className={input}
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder={t("brief.rolePlaceholder")}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">{t("brief.url")}</label>
            <input
              dir="ltr"
              className={input}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("brief.urlPlaceholder")}
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-ink-faint">{t("brief.urlHint")}</p>

        <label className="mb-1 mt-3 block text-xs text-ink-muted">{t("brief.pageText")}</label>
        <textarea
          dir="auto"
          value={pageText}
          onChange={(e) => setPageText(e.target.value)}
          placeholder={t("brief.pageTextPlaceholder")}
          className="min-h-[72px] w-full resize-y rounded-lg border border-line bg-bg-soft p-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
        />

        <label className="mb-1 mt-3 block text-xs text-ink-muted">{t("brief.jdTitle")}</label>
        <JDPaste value={jdText} onChange={setJdText} />

        <Button
          className="mt-4"
          loading={running}
          disabled={!canRun || uses.out}
          icon={<Sparkles size={16} />}
          onClick={run}
        >
          {t("brief.build")}
        </Button>
        <UsesNote feature="company_brief" className="mt-2" />
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </Card>

      {running && <Skeleton className="h-64 w-full" />}

      {result && !running && (
        <>
          <div className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm text-ink">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warn" />
            <span>{result.grounded ? t("brief.verify") : t("brief.ungrounded")}</span>
          </div>

          {result.overview && (
            <Card>
              <CardTitle dir="auto">
                {result.company ? `${result.company} — ${t("brief.overview")}` : t("brief.overview")}
              </CardTitle>
              <p className="mt-2 text-sm leading-relaxed text-ink" dir="auto">
                {result.overview}
              </p>
            </Card>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <ListCard title={t("brief.products")} items={result.products} />
            <ListCard title={t("brief.culture")} items={result.culture} />
            <ListCard title={t("brief.interviewStyle")} items={result.interview_style} />
            <ListCard title={t("brief.talkingPoints")} items={result.talking_points} accent />
          </div>

          <Card>
            <CardTitle className="flex items-center gap-2">
              <Users size={16} className="text-accent-soft" /> {t("brief.people")}
            </CardTitle>
            <p className="mt-1 text-xs text-ink-faint">{t("brief.peopleNote")}</p>
            {result.people.length > 0 ? (
              <div className="mt-3 space-y-3">
                {result.people.map((p, i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-line bg-bg-soft p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-ink" dir="auto">{p.name}</span>
                      {p.role && <Badge tone="neutral">{p.role}</Badge>}
                    </div>
                    {p.evidence && (
                      <p className="mt-1 text-xs italic text-ink-muted" dir="auto">
                        “{p.evidence}”
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {p.linkedin_search && (
                        <a
                          href={p.linkedin_search}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink-muted transition-colors hover:border-accent/50 hover:text-accent-soft"
                        >
                          <UserSearch size={12} /> {t("brief.searchOnLinkedin")}
                          <ExternalLink size={11} className="rtl:-scale-x-100" />
                        </a>
                      )}
                      {p.email && (
                        <a
                          href={`mailto:${p.email}`}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-mint/40 bg-mint/10 px-2.5 py-1 text-xs font-semibold text-mint"
                          title={t("brief.emailOnPage")}
                        >
                          <Mail size={12} /> {p.email}
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-ink-muted">
                <span>{t("brief.peopleEmpty")}</span>
                {(result.company || company) && (
                  <a
                    href={linkedinSearch(`${result.company || company} recruiter`)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink-muted transition-colors hover:border-accent/50 hover:text-accent-soft"
                  >
                    <UserSearch size={12} />{" "}
                    {t("brief.findRecruiters", { company: result.company || company })}
                    <ExternalLink size={11} className="rtl:-scale-x-100" />
                  </a>
                )}
              </div>
            )}
            {(result.targets ?? []).length > 0 && (
              <div className="mt-4 border-t border-line pt-3">
                <p className="text-xs font-semibold text-ink-muted">{t("brief.chain")}</p>
                <p className="mt-0.5 text-xs text-ink-faint">
                  {result.company_people_url ? t("brief.chainPeopleTab") : t("brief.chainSearch")}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(result.targets ?? []).map((tg) => (
                    <a
                      key={tg.title}
                      href={tg.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink-muted transition-colors hover:border-accent/50 hover:text-accent-soft"
                    >
                      <UserSearch size={12} /> {tg.title}
                      <ExternalLink size={11} className="rtl:-scale-x-100" />
                    </a>
                  ))}
                  {result.company_people_url && (
                    <a
                      href={result.company_people_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent-soft transition-colors hover:border-accent"
                    >
                      <Users size={12} /> {t("brief.allEmployees")}
                      <ExternalLink size={11} className="rtl:-scale-x-100" />
                    </a>
                  )}
                </div>
              </div>
            )}
            {result.hiring_emails.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                <span>{t("brief.hiringInbox")}:</span>
                {result.hiring_emails.map((e) => (
                  <a
                    key={e}
                    href={`mailto:${e}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-0.5 font-mono text-xs text-ink transition-colors hover:border-accent/50"
                  >
                    <Mail size={11} /> {e}
                  </a>
                ))}
              </div>
            )}
          </Card>

          {result.outreach_message && (
            <Card>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>{t("brief.message")}</CardTitle>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Copy size={13} />}
                  onClick={() =>
                    copy(
                      result.outreach_subject
                        ? `${result.outreach_subject}\n\n${result.outreach_message}`
                        : result.outreach_message,
                    )
                  }
                >
                  {t("common:actions.copy")}
                </Button>
              </div>
              {result.outreach_subject && (
                <p className="mt-2 text-sm font-semibold text-ink" dir="auto">
                  {t("brief.subject", { subject: result.outreach_subject })}
                </p>
              )}
              <div
                className="mt-2 whitespace-pre-wrap rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink"
                dir="auto"
              >
                {result.outreach_message}
              </div>
              <p className="mt-2 text-xs text-ink-faint">{t("brief.messageNote")}</p>
            </Card>
          )}
        </>
      )}
    </ToolShell>
  );
}

function ListCard({ title, items, accent }: { title: ReactNode; items: string[]; accent?: boolean }) {
  if (items.length === 0) return null;
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <ul className="mt-2 space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-ink" dir="auto">
            <span
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${accent ? "bg-accent" : "bg-ink-faint"}`}
            />
            {item}
          </li>
        ))}
      </ul>
    </Card>
  );
}
