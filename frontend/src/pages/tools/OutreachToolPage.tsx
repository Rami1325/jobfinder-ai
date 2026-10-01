import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Send, Copy, Sparkles, UserPlus, Mail, Users } from "lucide-react";
import { outreach } from "../../api/client";
import JDPaste from "../../components/JDPaste";
import ResumeGate from "../../components/ResumeGate";
import ToolShell from "../../components/ToolShell";
import UsesNote from "../../components/UsesNote";
import { useJobContext } from "../../hooks/useJobContext";
import { useMasterResume } from "../../hooks/useMasterResume";
import { apiErrorMessage } from "../../lib/apiError";
import { useUses } from "../../lib/usesStore";
import { Button, Card, CardTitle, Skeleton, useToast } from "../../components/ui";
import type { OutreachResult } from "../../types";

// Backend contact_role values (English, sent as-is); labels are translated.
const ROLES = ["recruiter", "hiring manager", "connection"] as const;

type NavState = { jdText?: string; company?: string; jobTitle?: string } | null;

const input =
  "min-h-11 w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-base text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none sm:text-sm";

export default function OutreachToolPage() {
  const { t } = useTranslation("tools");
  const { master, loading } = useMasterResume();
  const prefill = (useLocation().state as NavState) ?? null;
  // Opened from a job's page (PLAN 31.4/3): its row fills what the handoff did
  // not, and survives a reload, which navigation state does not.
  const ctx = useJobContext();
  const job = ctx?.job ?? null;
  const company = prefill?.company || job?.company || "";
  const jobTitle = prefill?.jobTitle || job?.job_title || "";
  const [jdText, setJdText] = useState(prefill?.jdText ?? "");
  useEffect(() => {
    if (job?.jd_text) setJdText((cur) => cur || job.jd_text);
  }, [job]);
  const [contactName, setContactName] = useState("");
  const [role, setRole] = useState<string>(ROLES[0]);
  const [result, setResult] = useState<OutreachResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const uses = useUses("outreach");

  async function run() {
    if (!master?.resume) return;
    setRunning(true);
    setResult(null);
    setError("");
    try {
      setResult(
        await outreach({
          resume: master.resume,
          jd_text: jdText,
          company,
          job_title: jobTitle,
          contact_name: contactName,
          contact_role: role,
        }),
      );
    } catch (e) {
      // Said under the button (Phase 30 / C4). With no catch at all a refusal,
      // the monthly limit included, cleared the page and said nothing.
      setError(apiErrorMessage(e, t("outreach.error")));
    } finally {
      setRunning(false);
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    toast("success", t("outreach.copied"));
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!master?.resume) return <ResumeGate feature={t("outreach.gateFeature")} />;

  return (
    <ToolShell
      title={t("cards.outreach.title")}
      subtitle={t("outreach.subtitle")}
      icon={<Send className="text-accent-soft rtl:-scale-x-100" />}
      back={ctx?.backTo}
    >
      <Card>
        {(company || jobTitle) && (
          <p className="mb-3 text-sm text-ink-muted" dir="auto">
            {t("outreach.targeting", { role: jobTitle || "—", company: company || "—" })}
          </p>
        )}
        <CardTitle>{t("outreach.jdTitle")}</CardTitle>
        <div className="mt-3">
          <JDPaste value={jdText} onChange={setJdText} />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-ink-muted">{t("outreach.contactName")}</label>
            <input
              dir="auto"
              className={input}
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder={t("outreach.contactNamePlaceholder")}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">{t("outreach.role")}</label>
            <select className={input} value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`outreach.roles.${r}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Button className="mt-4" loading={running} disabled={uses.out} icon={<Sparkles size={16} />} onClick={run}>
          {t("outreach.generate")}
        </Button>
        <UsesNote feature="outreach" className="mt-2" />
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        <p className="mt-3 text-xs text-ink-faint">{t("outreach.honesty")}</p>
      </Card>

      {running && <Skeleton className="h-64 w-full" />}

      {result && !running && (
        <>
          <TextCard
            icon={<UserPlus size={16} className="text-accent-soft" />}
            title={t("outreach.connection")}
            text={result.connection_note}
            copyLabel={t("common:actions.copy")}
            onCopy={() => copy(result.connection_note)}
            meta={t("outreach.chars", { count: result.connection_note.length })}
            metaWarn={result.connection_note.length > 300}
          />
          <Card>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <Mail size={16} className="text-accent-soft" /> {t("outreach.email")}
              </CardTitle>
              <Button
                size="sm"
                variant="ghost"
                icon={<Copy size={13} />}
                onClick={() => copy(`${result.inmail_subject}\n\n${result.inmail_body}`)}
              >
                {t("common:actions.copy")}
              </Button>
            </div>
            <p className="mt-2 text-sm font-semibold text-ink" dir="auto">
              {t("outreach.subject", { subject: result.inmail_subject })}
            </p>
            <div
              className="mt-2 whitespace-pre-wrap rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink"
              dir="auto"
            >
              {result.inmail_body}
            </div>
          </Card>
          <TextCard
            icon={<Users size={16} className="text-accent-soft" />}
            title={t("outreach.referral")}
            text={result.referral_message}
            copyLabel={t("common:actions.copy")}
            onCopy={() => copy(result.referral_message)}
          />
        </>
      )}
    </ToolShell>
  );
}

function TextCard({
  icon,
  title,
  text,
  copyLabel,
  onCopy,
  meta,
  metaWarn,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  copyLabel: string;
  onCopy: () => void;
  meta?: string;
  metaWarn?: boolean;
}) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <CardTitle className="flex min-w-0 items-center gap-2">{icon} {title}</CardTitle>
        <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={onCopy}>
          {copyLabel}
        </Button>
      </div>
      <div
        className="mt-2 whitespace-pre-wrap rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink"
        dir="auto"
      >
        {text}
      </div>
      {meta && (
        <p className={`mt-2 text-xs ${metaWarn ? "text-warn" : "text-ink-faint"}`}>{meta}</p>
      )}
    </Card>
  );
}
