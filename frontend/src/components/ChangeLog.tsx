import { ShieldCheck, ShieldAlert } from "lucide-react";
import type { ChangeLogEntry, FabricationFlag } from "../types";
import { Card, CardTitle } from "./ui";
import { cn } from "../lib/cn";

interface Props {
  changelog: ChangeLogEntry[];
  flags: FabricationFlag[];
}

/** The trust panel — the product's core differentiator, surfaced prominently. */
export default function ChangeLog({ changelog, flags }: Props) {
  const clean = flags.length === 0;
  return (
    <Card glow={clean} className={clean ? "border-mint/40" : "border-danger/50"}>
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "grid h-11 w-11 shrink-0 place-items-center rounded-xl",
            clean ? "bg-mint/15 text-mint" : "bg-danger/15 text-danger",
          )}
        >
          {clean ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}
        </span>
        <div>
          <CardTitle>{clean ? "All claims verified" : "Fabrication check — review these"}</CardTitle>
          <p className="mt-0.5 text-sm text-ink-muted">
            {clean
              ? "Every factual anchor matches your original résumé — nothing invented."
              : `${flags.length} item${flags.length > 1 ? "s" : ""} may not be supported by your résumé.`}
          </p>
        </div>
      </div>

      {!clean && (
        <div className="mt-4 space-y-2">
          {flags.map((f, i) => (
            <div key={i} className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm">
              <span className="font-semibold capitalize text-danger">{f.category}:</span>{" "}
              <span className="text-ink">{f.value}</span>
              {f.detail && <div className="mt-0.5 text-xs text-ink-muted">{f.detail}</div>}
            </div>
          ))}
        </div>
      )}

      <h3 className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
        Edits made
      </h3>
      {changelog.length === 0 ? (
        <p className="text-sm text-ink-muted">No changes recorded.</p>
      ) : (
        <div className="space-y-2">
          {changelog.map((c, i) => (
            <div key={i} className="rounded-lg border-l-2 border-accent bg-panel-2/60 px-3 py-2">
              <div className="text-sm">
                <span className="font-semibold capitalize text-accent-soft">{c.section}</span>
                <span className="text-ink"> — {c.change}</span>
              </div>
              {c.reason && <div className="mt-0.5 text-xs text-ink-muted">Why: {c.reason}</div>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
