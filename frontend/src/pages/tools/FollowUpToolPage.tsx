import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Mail, Copy, Sparkles } from "lucide-react";
import { followUp } from "../../api/client";
import ToolShell from "../../components/ToolShell";
import UsesNote from "../../components/UsesNote";
import { followUpStage, useJobContext } from "../../hooks/useJobContext";
import { apiErrorMessage } from "../../lib/apiError";
import { useUses } from "../../lib/usesStore";
import { Button, Card, CardTitle, Skeleton, useToast } from "../../components/ui";
import type { FollowUpResult } from "../../types";

// Stage ids are sent to the API as-is (English); labels are translated.
const STAGES = ["after applying", "after an interview", "checking in", "after an offer"];

type NavState = { company?: string; role?: string; stage?: string } | null;

export default function FollowUpToolPage() {
  const { t } = useTranslation("tools");
  // Prefill when deep-linked from the tracker / a stale-application nudge.
  const prefill = (useLocation().state as NavState) ?? null;
  const [company, setCompany] = useState(prefill?.company ?? "");
  const [role, setRole] = useState(prefill?.role ?? "");
  const [stage, setStage] = useState(
    prefill?.stage && STAGES.includes(prefill.stage) ? prefill.stage : STAGES[0],
  );
  // Opened from a job's page (PLAN 31.4/3): its row fills the company and the
  // role the handoff left empty, and, with no stage handed over, picks the one
  // the job's status calls for. It survives a reload; navigation state does not.
  const ctx = useJobContext();
  const job = ctx?.job ?? null;
  useEffect(() => {
    if (!job) return;
    setCompany((cur) => cur || job.company);
    setRole((cur) => cur || job.job_title);
    // Only while the stage is still the untouched default: one the user picked
    // before the job arrived, or a handed-over one, wins.
    if (!prefill?.stage) setStage((cur) => (cur === STAGES[0] ? followUpStage(job.status) : cur));
  }, [job, prefill?.stage]);
  const [context, setContext] = useState("");
  const [result, setResult] = useState<FollowUpResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const uses = useUses("follow_up");

  async function run() {
    if (!company.trim() || !role.trim()) return;
    setRunning(true);
    setResult(null);
    setError("");
    try {
      setResult(await followUp({ company, role, stage, context }));
    } catch (e) {
      // Said under the button (Phase 30 / C4). With no catch at all a refusal,
      // the monthly limit included, cleared the page and said nothing.
      setError(apiErrorMessage(e, t("followup.error")));
    } finally {
      setRunning(false);
    }
  }

  const input =
    "w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none";

  return (
    <ToolShell
      title={t("cards.followup.title")}
      subtitle={t("followup.subtitle")}
      icon={<Mail className="text-accent-soft" />}
      back={ctx?.backTo}
    >
      <Card>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-ink-muted">{t("followup.company")}</label>
            <input dir="auto" className={input} value={company} onChange={(e) => setCompany(e.target.value)} placeholder={t("followup.companyPlaceholder")} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">{t("followup.role")}</label>
            <input dir="auto" className={input} value={role} onChange={(e) => setRole(e.target.value)} placeholder={t("followup.rolePlaceholder")} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">{t("followup.stage")}</label>
            <select className={input} value={stage} onChange={(e) => setStage(e.target.value)}>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {t(`followup.stages.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">{t("followup.fit")}</label>
            <input dir="auto" className={input} value={context} onChange={(e) => setContext(e.target.value)} placeholder={t("followup.fitPlaceholder")} />
          </div>
        </div>
        <Button
          className="mt-4"
          loading={running}
          icon={<Sparkles size={16} />}
          disabled={!company.trim() || !role.trim() || uses.out}
          onClick={run}
        >
          {t("followup.write")}
        </Button>
        <UsesNote feature="follow_up" className="mt-2" />
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </Card>

      {running && <Skeleton className="h-48 w-full" />}

      {result && !running && (
        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>{t("followup.draft")}</CardTitle>
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy size={13} />}
              onClick={() => {
                navigator.clipboard.writeText(`${t("followup.subject", { subject: result.subject })}\n\n${result.body}`);
                toast("success", t("followup.copied"));
              }}
            >
              {t("common:actions.copy")}
            </Button>
          </div>
          <p className="mt-2 text-sm font-semibold text-ink">{t("followup.subject", { subject: result.subject })}</p>
          <div className="mt-2 whitespace-pre-wrap rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink">
            {result.body}
          </div>
        </Card>
      )}
    </ToolShell>
  );
}
