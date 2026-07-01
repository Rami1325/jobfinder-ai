import { useState } from "react";
import { Link2 } from "lucide-react";
import { fetchJob } from "../api/client";
import { Button } from "./ui";

interface Props {
  value: string;
  onChange: (v: string) => void;
}

// A single-token, host-looking string → treat as a job link.
const URL_RE = /^(https?:\/\/)?([\w-]+\.)+[\w-]{2,}(\/\S*)?$/i;

export default function JDPaste({ value, onChange }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const trimmed = value.trim();
  const isLink = !/\s/.test(trimmed) && trimmed.length > 8 && URL_RE.test(trimmed);

  async function fetchFromLink() {
    setError("");
    setLoading(true);
    try {
      const text = await fetchJob(trimmed);
      if (text.trim().length < 40) {
        throw new Error(
          "Couldn't read the description from that link (the site may require login or block bots). Paste the text instead.",
        );
      }
      onChange(text);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "Could not fetch that link.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (error) setError("");
        }}
        placeholder="Paste the job description — or drop a job link (LinkedIn, Greenhouse, Lever…) and fetch it."
        className="min-h-[240px] w-full resize-y rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25"
      />
      {isLink && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" loading={loading} icon={<Link2 size={14} />} onClick={fetchFromLink}>
            Fetch description from link
          </Button>
          <span className="text-xs text-ink-muted">Detected a job link</span>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
