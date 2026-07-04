import { Link } from "react-router-dom";
import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Card } from "./ui";

/** Shown when a feature needs the master résumé but none is saved yet.
 * `feature` should already be translated by the caller. */
export default function ResumeGate({ feature }: { feature: string }) {
  const { t } = useTranslation();
  return (
    <Card className="py-12 text-center">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl bg-accent/10 text-accent-soft">
        <FileText />
      </div>
      <h2 className="text-lg font-semibold text-ink">{t("resumeGate.title")}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">
        {t("resumeGate.body", { feature })}
      </p>
      <Link to="/jobs" className="mt-5 inline-block">
        <Button>{t("resumeGate.cta")}</Button>
      </Link>
    </Card>
  );
}
