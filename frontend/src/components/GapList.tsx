import type { GapItem } from "../types";

interface Props {
  gaps: GapItem[];
}

export default function GapList({ gaps }: Props) {
  if (!gaps.length) return null;
  const order: Record<string, number> = { missing: 0, partial: 1, covered: 2 };
  const sorted = [...gaps].sort((a, b) => order[a.status] - order[b.status]);
  const missing = gaps.filter((g) => g.status === "missing").length;

  return (
    <div className="panel">
      <h2>Keyword gap analysis</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {missing} of {gaps.length} key terms still missing. Only add terms that reflect real experience.
      </p>
      <div>
        {sorted.map((g) => (
          <span key={g.keyword} className={`tag ${g.status}`} title={g.suggestion}>
            {g.status === "covered" ? "✓" : g.status === "partial" ? "≈" : "✗"} {g.keyword}
          </span>
        ))}
      </div>
    </div>
  );
}
