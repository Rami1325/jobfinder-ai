import { useState } from "react";
import { Copy, RefreshCw, Wand2, Scissors } from "lucide-react";
import { coverLetter } from "../api/client";
import type { JDModel, ResumeModel } from "../types";
import { Button, Card, CardTitle, useToast } from "./ui";

interface Props {
  resume: ResumeModel;
  jd: JDModel;
  onGenerated?: (text: string) => void;
  /** Restores a previously generated letter when the page is revisited. */
  initialText?: string;
}

const TONES = ["professional", "enthusiastic", "concise", "warm"];

export default function CoverLetter({ resume, jd, onGenerated, initialText }: Props) {
  const [text, setText] = useState(initialText ?? "");
  const [tone, setTone] = useState("professional");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  async function generate(extra?: string) {
    setError("");
    setLoading(true);
    try {
      const t = await coverLetter(resume, jd, extra ? `${tone}, ${extra}` : tone);
      setText(t);
      onGenerated?.(t);
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Failed to generate cover letter.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardTitle>Cover letter</CardTitle>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={tone}
          onChange={(e) => setTone(e.target.value)}
          className="rounded-lg border border-line bg-bg-soft px-2.5 py-2 text-sm capitalize text-ink focus:border-accent/60 focus:outline-none"
        >
          {TONES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <Button variant="secondary" size="sm" loading={loading} icon={<Wand2 size={15} />} onClick={() => generate()}>
          {text ? "Regenerate" : "Generate"}
        </Button>
        {text && (
          <>
            <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => generate("make it more specific to this role")}>
              More specific
            </Button>
            <Button variant="ghost" size="sm" icon={<Scissors size={14} />} onClick={() => generate("make it noticeably shorter")}>
              Shorter
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Copy size={14} />}
              onClick={() => {
                navigator.clipboard.writeText(text);
                toast("success", "Copied to clipboard");
              }}
            >
              Copy
            </Button>
          </>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {text && (
        <div className="mt-3 whitespace-pre-wrap break-words rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink">
          {text}
        </div>
      )}
    </Card>
  );
}
