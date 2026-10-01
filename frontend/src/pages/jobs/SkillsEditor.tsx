// "Skills I have that aren't on my resume" (PLAN 15.10): edits the master
// resume's skills list directly. Added skills become part of the resume itself
// — match scoring counts them, tailoring may legitimately use them, and the
// renderers print them — so the honesty note matters: only true skills belong
// here. The fabrication guard is unaffected (it never tracked skills; it
// guards employers/titles/dates/credentials/numbers/military).
import { useEffect, useMemo, useState } from "react";
import { withSkills } from "../../lib/resumeBlocks";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { saveMasterResume } from "../../api/client";
import { Button, Modal, useToast } from "../../components/ui";
import type { MasterResume } from "../../types";
import { inputCls } from "./shared";

export function SkillsEditorModal({
  open,
  onClose,
  masters,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  masters: MasterResume[];
  onSaved: (m: MasterResume) => void;
}) {
  const { t } = useTranslation("jobs");
  const toast = useToast();
  // Paired he/en masters: edit one at a time, switchable when both exist.
  const [lang, setLang] = useState<string>("");
  const target = useMemo(
    () => masters.find((m) => (m.language ?? "en") === lang) ?? masters[0] ?? null,
    [masters, lang],
  );
  const [draft, setDraft] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);

  // (Re)seed the draft whenever the modal opens or the target master switches.
  useEffect(() => {
    if (!open) return;
    setDraft(target?.resume.skills ?? []);
    setInput("");
  }, [open, target]);

  if (!target) return null;
  const originals = new Set(target.resume.skills.map((s) => s.toLowerCase()));

  function addFromInput() {
    const parts = input
      .split(/[,;؛،]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    setDraft((prev) => {
      const seen = new Set(prev.map((s) => s.toLowerCase()));
      const fresh = parts.filter((p) => !seen.has(p.toLowerCase()));
      return [...prev, ...fresh];
    });
    setInput("");
  }

  async function save() {
    if (!target || saving) return;
    setSaving(true);
    try {
      const saved = await saveMasterResume({
        // `withSkills`, not a spread. Writing `skills` alone left every removed
        // skill inside its group, and the model validator's flat union put it
        // back on the next load -- so deleting a grouped skill here toasted
        // "saved" and silently did nothing.
        resume: withSkills(target.resume, draft),
        ledger: target.ledger,
        label: target.label,
      });
      onSaved(saved);
      toast("success", t("skillsEditor.savedToast"));
      onClose();
    } catch {
      toast("error", t("skillsEditor.saveError"));
    } finally {
      setSaving(false);
    }
  }

  const dirty =
    draft.length !== target.resume.skills.length ||
    draft.some((s, i) => s !== target.resume.skills[i]);

  return (
    <Modal open={open} onClose={onClose} title={t("skillsEditor.title")} maxWidth="max-w-lg">
      <p className="text-sm text-ink-muted">{t("skillsEditor.body")}</p>
      <p className="mt-1 text-xs font-medium text-warn">{t("skillsEditor.honesty")}</p>

      {/* The third tap-target pass: each control here is a 44 px target. The
          language chips (26 px) and a skill's remove button (16 px) wear
          `tap-44`; the chips sit 12 px apart, since a short one's layer reaches
          4 px sideways, and the skills wrap 18 px apart, the room two remove
          buttons' layers need (each reaches 9 px past its chip). A layer lies
          over its own chip's words, never another control. */}
      {masters.length > 1 && (
        <div className="mt-3 flex gap-3">
          {masters.map((m) => {
            const l = m.language ?? "en";
            const active = l === (target.language ?? "en");
            return (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={`tap-44 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  active
                    ? "border-accent/60 bg-accent/10 text-ink"
                    : "border-line text-ink-muted hover:text-ink"
                }`}
              >
                {t(`langTag.${l === "he" ? "he" : "en"}`)}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-x-1.5 gap-y-[18px]">
        {draft.map((s) => (
          <span
            key={s}
            dir="auto"
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
              originals.has(s.toLowerCase())
                ? "border-line text-ink"
                : "border-mint/50 bg-mint/10 text-mint"
            }`}
          >
            {s}
            <button
              type="button"
              onClick={() => setDraft((prev) => prev.filter((x) => x !== s))}
              title={t("skillsEditor.remove")}
              className="tap-44 rounded p-0.5 text-ink-muted transition-colors hover:text-danger"
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {draft.length === 0 && (
          <span className="text-xs text-ink-faint">{t("skillsEditor.empty")}</span>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <input
          value={input}
          dir="auto"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addFromInput();
            }
          }}
          placeholder={t("skillsEditor.placeholder")}
          className={`${inputCls} min-w-0 flex-1`}
        />
        <Button variant="secondary" size="sm" disabled={!input.trim()} onClick={addFromInput} className="min-h-11">
          {t("skillsEditor.add")}
        </Button>
      </div>

      <div className="mt-5 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} className="min-h-11">
          {t("common:actions.cancel")}
        </Button>
        <Button size="sm" loading={saving} disabled={!dirty} onClick={save} className="min-h-11">
          {t("skillsEditor.save")}
        </Button>
      </div>
    </Modal>
  );
}
