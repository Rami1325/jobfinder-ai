import type { ChangeLogEntry, FabricationFlag } from "../types";

interface Props {
  changelog: ChangeLogEntry[];
  flags: FabricationFlag[];
}

export default function ChangeLog({ changelog, flags }: Props) {
  return (
    <div className="panel">
      <h2>What changed</h2>

      {flags.length > 0 && (
        <>
          <h3 className="error">⚠ Fabrication check — review these</h3>
          {flags.map((f, i) => (
            <div className="flag" key={i}>
              <strong>{f.category}:</strong> {f.value}
              <div className="muted" style={{ fontSize: 13 }}>{f.detail}</div>
            </div>
          ))}
        </>
      )}
      {flags.length === 0 && (
        <p className="success">✓ No fabricated facts detected — all anchors match your original résumé.</p>
      )}

      <h3>Edits made</h3>
      {changelog.length === 0 ? (
        <p className="muted">No changes recorded.</p>
      ) : (
        changelog.map((c, i) => (
          <div className="changelog-item" key={i}>
            <span className="section">{c.section}</span> — {c.change}
            {c.reason && <div className="reason">Why: {c.reason}</div>}
          </div>
        ))
      )}
    </div>
  );
}
