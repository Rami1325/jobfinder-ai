import { useState } from "react";
import { Contact, Copy, Sparkles } from "lucide-react";
import { linkedinOptimize } from "../../api/client";
import ResumeGate from "../../components/ResumeGate";
import ToolShell from "../../components/ToolShell";
import { useMasterResume } from "../../hooks/useMasterResume";
import { Badge, Button, Card, CardTitle, Skeleton, useToast } from "../../components/ui";
import type { LinkedInResult } from "../../types";

export default function LinkedInToolPage() {
  const { master, loading } = useMasterResume();
  const [result, setResult] = useState<LinkedInResult | null>(null);
  const [running, setRunning] = useState(false);
  const toast = useToast();

  async function run() {
    if (!master?.resume) return;
    setRunning(true);
    setResult(null);
    try {
      setResult(await linkedinOptimize(master.resume));
    } finally {
      setRunning(false);
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    toast("success", "Copied");
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!master?.resume) return <ResumeGate feature="the LinkedIn optimizer" />;

  return (
    <ToolShell
      title="LinkedIn optimizer"
      subtitle="A keyword-rich headline, About, and bullets — built only from your real résumé."
      icon={<Contact className="text-accent-soft" />}
    >
      <Card>
        <Button loading={running} icon={<Sparkles size={16} />} onClick={run}>
          {result ? "Regenerate" : "Optimize my profile"}
        </Button>
      </Card>

      {running && <Skeleton className="h-64 w-full" />}

      {result && !running && (
        <div className="space-y-4">
          <Card>
            <div className="flex items-center justify-between">
              <CardTitle>Headline</CardTitle>
              <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => copy(result.headline)}>
                Copy
              </Button>
            </div>
            <p className="mt-2 text-sm text-ink">{result.headline}</p>
          </Card>

          <Card>
            <div className="flex items-center justify-between">
              <CardTitle>About</CardTitle>
              <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => copy(result.about)}>
                Copy
              </Button>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink">{result.about}</p>
          </Card>

          {result.experience_bullets.length > 0 && (
            <Card>
              <div className="flex items-center justify-between">
                <CardTitle>Experience bullets</CardTitle>
                <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => copy(result.experience_bullets.join("\n"))}>
                  Copy all
                </Button>
              </div>
              <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-ink">
                {result.experience_bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </Card>
          )}

          {result.skills.length > 0 && (
            <Card>
              <CardTitle>Skills</CardTitle>
              <div className="mt-3 flex flex-wrap gap-2">
                {result.skills.map((s) => (
                  <Badge key={s} tone="accent">
                    {s}
                  </Badge>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </ToolShell>
  );
}
