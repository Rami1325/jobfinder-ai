import { useState } from "react";
import { ScanLine, CheckCircle2, AlertTriangle, XCircle, Sparkles } from "lucide-react";
import { atsScan } from "../../api/client";
import ResumeGate from "../../components/ResumeGate";
import ToolShell from "../../components/ToolShell";
import { useMasterResume } from "../../hooks/useMasterResume";
import { Badge, Button, Card, CardTitle, ProgressRing, Skeleton } from "../../components/ui";
import type { ATSScanResult } from "../../types";

const sev = {
  good: { icon: <CheckCircle2 size={16} className="text-mint" />, cls: "text-mint" },
  warn: { icon: <AlertTriangle size={16} className="text-warn" />, cls: "text-warn" },
  bad: { icon: <XCircle size={16} className="text-danger" />, cls: "text-danger" },
};

export default function AtsToolPage() {
  const { master, loading } = useMasterResume();
  const [jdText, setJdText] = useState("");
  const [result, setResult] = useState<ATSScanResult | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    if (!master?.resume) return;
    setRunning(true);
    setResult(null);
    try {
      setResult(await atsScan(master.resume, jdText));
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!master?.resume) return <ResumeGate feature="the ATS scanner" />;

  return (
    <ToolShell
      title="ATS résumé scanner"
      subtitle="Format + keyword checks on your saved résumé. Add a job description for coverage scoring."
      icon={<ScanLine className="text-accent-soft" />}
    >
      <Card>
        <CardTitle>Optional: target job description</CardTitle>
        <textarea
          value={jdText}
          onChange={(e) => setJdText(e.target.value)}
          placeholder="Paste a JD to also score keyword coverage (optional)…"
          className="mt-3 min-h-[120px] w-full resize-y rounded-xl border border-line bg-bg-soft p-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
        />
        <Button className="mt-3" loading={running} icon={<Sparkles size={16} />} onClick={run}>
          Scan résumé
        </Button>
      </Card>

      {running && <Skeleton className="h-40 w-full" />}

      {result && !running && (
        <Card className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <ProgressRing value={result.score} size={120} label="ATS score" />
          <div className="flex-1 space-y-2">
            {result.keyword_coverage > 0 && (
              <p className="text-sm text-ink-muted">
                Keyword coverage vs. JD: <span className="font-semibold text-ink">{Math.round(result.keyword_coverage)}%</span>
              </p>
            )}
            {result.issues.map((iss, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                {sev[iss.severity].icon}
                <span>
                  <span className={sev[iss.severity].cls}>{iss.label}</span>
                  {iss.detail && <span className="text-ink-muted"> — {iss.detail}</span>}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {result && result.gaps.length > 0 && !running && (
        <Card>
          <CardTitle>Missing keywords</CardTitle>
          <div className="mt-3 flex flex-wrap gap-2">
            {result.gaps
              .filter((g) => g.status !== "covered")
              .map((g) => (
                <Badge key={g.keyword} tone={g.status as "partial" | "missing"}>
                  {g.keyword}
                </Badge>
              ))}
          </div>
        </Card>
      )}
    </ToolShell>
  );
}
