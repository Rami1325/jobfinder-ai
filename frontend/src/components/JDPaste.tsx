interface Props {
  value: string;
  onChange: (v: string) => void;
}

export default function JDPaste({ value, onChange }: Props) {
  return (
    <div className="panel">
      <h2>2 · Target job description</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Copy the full posting from LinkedIn / Indeed / any site and paste it here.
      </p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste the job description text…"
      />
    </div>
  );
}
