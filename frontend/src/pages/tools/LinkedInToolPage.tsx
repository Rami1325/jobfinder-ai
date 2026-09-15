import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Contact, Copy, Sparkles } from "lucide-react";
import { linkedinOptimize } from "../../api/client";
import ResumeGate from "../../components/ResumeGate";
import ToolShell from "../../components/ToolShell";
import UsesNote from "../../components/UsesNote";
import { useMasterResume } from "../../hooks/useMasterResume";
import { apiErrorMessage } from "../../lib/apiError";
import { useUses } from "../../lib/usesStore";
import { Badge, Button, Card, CardTitle, Skeleton, useToast } from "../../components/ui";
import type { LinkedInResult } from "../../types";

export default function LinkedInToolPage() {
  const { t } = useTranslation("tools");
  const { master, loading } = useMasterResume();
  const [result, setResult] = useState<LinkedInResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const uses = useUses("linkedin");

  async function run() {
    if (!master?.resume) return;
    setRunning(true);
    setResult(null);
    setError("");
    try {
      setResult(await linkedinOptimize(master.resume));
    } catch (e) {
      // Said under the button (Phase 30 / C4). With no catch at all a refusal,
      // the monthly limit included, cleared the page and said nothing.
      setError(apiErrorMessage(e, t("linkedin.error")));
    } finally {
      setRunning(false);
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    toast("success", t("linkedin.copied"));
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!master?.resume) return <ResumeGate feature={t("linkedin.gateFeature")} />;

  return (
    <ToolShell
      title={t("cards.linkedin.title")}
      subtitle={t("linkedin.subtitle")}
      icon={<Contact className="text-accent-soft" />}
    >
      <Card>
        <Button loading={running} disabled={uses.out} icon={<Sparkles size={16} />} onClick={run}>
          {result ? t("linkedin.regenerate") : t("linkedin.optimize")}
        </Button>
        <UsesNote feature="linkedin" className="mt-2" />
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </Card>

      {running && <Skeleton className="h-64 w-full" />}

      {result && !running && (
        <div className="space-y-4">
          <Card>
            <div className="flex items-center justify-between">
              <CardTitle>{t("linkedin.headline")}</CardTitle>
              <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => copy(result.headline)}>
                {t("common:actions.copy")}
              </Button>
            </div>
            <p className="mt-2 text-sm text-ink">{result.headline}</p>
          </Card>

          <Card>
            <div className="flex items-center justify-between">
              <CardTitle>{t("linkedin.about")}</CardTitle>
              <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => copy(result.about)}>
                {t("common:actions.copy")}
              </Button>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink">{result.about}</p>
          </Card>

          {result.experience_bullets.length > 0 && (
            <Card>
              <div className="flex items-center justify-between">
                <CardTitle>{t("linkedin.bullets")}</CardTitle>
                <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => copy(result.experience_bullets.join("\n"))}>
                  {t("linkedin.copyAll")}
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
              <CardTitle>{t("linkedin.skills")}</CardTitle>
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
