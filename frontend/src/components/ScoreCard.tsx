import type { Score } from "../types";

interface Props {
  before: Score;
  after: Score;
}

function Metric({ label, before, after }: { label: string; before: number; after: number }) {
  const delta = Math.round((after - before) * 10) / 10;
  const cls = delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : "muted";
  return (
    <div className="metric">
      <div className="num">{after}%</div>
      <div className="lbl">{label}</div>
      <div className={cls} style={{ fontSize: 12 }}>
        {delta > 0 ? "▲" : delta < 0 ? "▼" : "="} {Math.abs(delta)} (was {before}%)
      </div>
    </div>
  );
}

export default function ScoreCard({ before, after }: Props) {
  return (
    <div className="panel">
      <h2>Match score</h2>
      <div className="score-ring">
        <Metric label="Overall" before={before.overall} after={after.overall} />
        <Metric label="ATS keyword coverage" before={before.keyword_coverage} after={after.keyword_coverage} />
        <Metric label="Recruiter fit" before={before.fit_score} after={after.fit_score} />
      </div>
      {after.rationale && <p className="muted" style={{ marginTop: 14 }}>{after.rationale}</p>}
    </div>
  );
}
