import { useState } from "react";
import { Mail, Copy, Sparkles } from "lucide-react";
import { followUp } from "../../api/client";
import ToolShell from "../../components/ToolShell";
import { Button, Card, CardTitle, Skeleton, useToast } from "../../components/ui";
import type { FollowUpResult } from "../../types";

const STAGES = ["after applying", "after an interview", "checking in", "after an offer"];

export default function FollowUpToolPage() {
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [stage, setStage] = useState(STAGES[0]);
  const [context, setContext] = useState("");
  const [result, setResult] = useState<FollowUpResult | null>(null);
  const [running, setRunning] = useState(false);
  const toast = useToast();

  async function run() {
    if (!company.trim() || !role.trim()) return;
    setRunning(true);
    setResult(null);
    try {
      setResult(await followUp({ company, role, stage, context }));
    } finally {
      setRunning(false);
    }
  }

  const input =
    "w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none";

  return (
    <ToolShell
      title="Follow-up email writer"
      subtitle="A concise, specific follow-up for any stage — no clichés, no filler."
      icon={<Mail className="text-accent-soft" />}
    >
      <Card>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-ink-muted">Company</label>
            <input className={input} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Corp" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">Role</label>
            <input className={input} value={role} onChange={(e) => setRole(e.target.value)} placeholder="Senior Backend Engineer" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">Stage</label>
            <select className={`${input} capitalize`} value={stage} onChange={(e) => setStage(e.target.value)}>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">Point of fit (optional)</label>
            <input className={input} value={context} onChange={(e) => setContext(e.target.value)} placeholder="Excited about their platform work" />
          </div>
        </div>
        <Button className="mt-4" loading={running} icon={<Sparkles size={16} />} disabled={!company.trim() || !role.trim()} onClick={run}>
          Write email
        </Button>
      </Card>

      {running && <Skeleton className="h-48 w-full" />}

      {result && !running && (
        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>Draft</CardTitle>
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy size={13} />}
              onClick={() => {
                navigator.clipboard.writeText(`Subject: ${result.subject}\n\n${result.body}`);
                toast("success", "Copied email");
              }}
            >
              Copy
            </Button>
          </div>
          <p className="mt-2 text-sm font-semibold text-ink">Subject: {result.subject}</p>
          <div className="mt-2 whitespace-pre-wrap rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink">
            {result.body}
          </div>
        </Card>
      )}
    </ToolShell>
  );
}
