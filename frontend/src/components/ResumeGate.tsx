import { Link } from "react-router-dom";
import { FileText } from "lucide-react";
import { Button, Card } from "./ui";

/** Shown when a feature needs the master résumé but none is saved yet. */
export default function ResumeGate({ feature }: { feature: string }) {
  return (
    <Card className="py-12 text-center">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl bg-accent/10 text-accent-soft">
        <FileText />
      </div>
      <h2 className="text-lg font-semibold text-ink">No résumé saved yet</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">
        Upload your résumé on the Tailor page first — it becomes your master résumé, which {feature} uses.
      </p>
      <Link to="/app" className="mt-5 inline-block">
        <Button>Go to Tailor</Button>
      </Link>
    </Card>
  );
}
