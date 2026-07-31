import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Briefcase,
  Download,
  FileText,
  GraduationCap,
  Hammer,
  Plus,
  RotateCcw,
  Save,
  Shield,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import {
  RESUME_TEMPLATES,
  downloadResume,
  resumeFilename,
  saveMasterResume,
  type ResumeTemplate,
} from "../api/client";
import { useMasterResume } from "../hooks/useMasterResume";
import { masterResumeLabel } from "../hooks/useSaveMasterResume";
import { resumeLanguage } from "../lib/lang";
import { Badge, Button, Card, CardTitle, Stepper, useToast } from "../components/ui";
import type {
  Education,
  Experience,
  MilitaryService,
  Project,
  ResumeModel,
} from "../types";

// PLAN 15.3 — résumé builder from scratch. A guided form producing a plain
// ResumeModel that rides the existing pipeline: PUT /profile/resume (the
// backend derives the facts ledger from the typed facts) + POST /render for
// DOCX/PDF. Kills the cold-start requirement: no file, no LinkedIn needed.

const DRAFT_KEY = "jf.builder.draft.v1";

const STEP_IDS = ["contact", "experience", "service", "education", "skills", "finish"] as const;
type StepId = (typeof STEP_IDS)[number];

function emptyResume(): ResumeModel {
  return {
    contact: { name: "", email: "", phone: "", location: "", linkedin: "", website: "" },
    headline: "",
    summary: "",
    skills: [],
    experience: [],
    education: [],
    projects: [],
    certifications: [],
    military_service: [],
    languages: [],
  };
}

function emptyExperience(): Experience {
  return { company: "", title: "", location: "", start_date: "", end_date: "", bullets: [] };
}
function emptyEducation(): Education {
  return { institution: "", degree: "", field: "", start_date: "", end_date: "", details: "" };
}
function emptyProject(): Project {
  return { name: "", description: "", bullets: [] };
}
function emptyService(): MilitaryService {
  return { unit: "", role: "", rank: "", start_date: "", end_date: "", bullets: [] };
}

type Draft = { resume: ResumeModel; step: number };

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const d = JSON.parse(raw) as Partial<Draft>;
      if (d.resume?.contact) {
        // Merge over a fresh model so drafts from older builder versions
        // (missing newer sections) still hydrate every field.
        const base = emptyResume();
        return {
          resume: { ...base, ...d.resume, contact: { ...base.contact, ...d.resume.contact } },
          step: Math.min(Math.max(d.step ?? 0, 0), STEP_IDS.length - 1),
        };
      }
    }
  } catch {
    // Corrupt draft — start clean.
  }
  return { resume: emptyResume(), step: 0 };
}

const cleanList = (xs: string[]) => xs.map((s) => s.trim()).filter(Boolean);

/** Drop empty repeatable entries and trim everything before save/render. */
function pruneResume(r: ResumeModel): ResumeModel {
  return {
    contact: {
      name: r.contact.name.trim(),
      email: r.contact.email.trim(),
      phone: r.contact.phone.trim(),
      location: r.contact.location.trim(),
      linkedin: r.contact.linkedin.trim(),
      website: r.contact.website.trim(),
    },
    headline: (r.headline ?? "").trim(),
    summary: r.summary.trim(),
    skills: cleanList(r.skills),
    experience: r.experience
      .map((e) => ({
        company: e.company.trim(),
        title: e.title.trim(),
        location: e.location.trim(),
        start_date: e.start_date.trim(),
        end_date: e.end_date.trim(),
        bullets: cleanList(e.bullets),
      }))
      .filter((e) => e.company || e.title),
    education: r.education
      .map((e) => ({
        institution: e.institution.trim(),
        degree: e.degree.trim(),
        field: e.field.trim(),
        start_date: e.start_date.trim(),
        end_date: e.end_date.trim(),
        details: e.details.trim(),
      }))
      .filter((e) => e.institution || e.degree),
    projects: r.projects
      .map((p) => ({
        name: p.name.trim(),
        description: p.description.trim(),
        bullets: cleanList(p.bullets),
      }))
      .filter((p) => p.name || p.description),
    certifications: cleanList(r.certifications),
    military_service: (r.military_service ?? [])
      .map((m) => ({
        unit: m.unit.trim(),
        role: m.role.trim(),
        rank: m.rank.trim(),
        start_date: m.start_date.trim(),
        end_date: m.end_date.trim(),
        bullets: cleanList(m.bullets),
      }))
      .filter((m) => m.unit || m.role),
    languages: (r.languages ?? [])
      .map((l) => ({ language: l.language.trim(), level: l.level.trim() }))
      .filter((l) => l.language),
  };
}

function updateAt<T>(xs: T[], i: number, patch: Partial<T>): T[] {
  return xs.map((x, j) => (j === i ? { ...x, ...patch } : x));
}
function removeAt<T>(xs: T[], i: number): T[] {
  return xs.filter((_, j) => j !== i);
}

const inputCls =
  "w-full rounded-xl border border-line bg-bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none";
const areaCls = `${inputCls} min-h-[96px] resize-y`;

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputCls}
      />
    </label>
  );
}

/** Two free-text date fields — the model stores dates as written ("2021", "today"). */
function DateInputs({
  start,
  end,
  onChange,
}: {
  start: string;
  end: string;
  onChange: (patch: { start_date?: string; end_date?: string }) => void;
}) {
  const { t } = useTranslation("builder");
  return (
    <div className="grid grid-cols-2 gap-3">
      <LabeledInput
        label={t("dates.start")}
        value={start}
        onChange={(v) => onChange({ start_date: v })}
        placeholder={t("dates.startPh")}
      />
      <LabeledInput
        label={t("dates.end")}
        value={end}
        onChange={(v) => onChange({ end_date: v })}
        placeholder={t("dates.endPh")}
      />
    </div>
  );
}

/** Bordered shell for one repeatable entry with a remove control. */
function EntryShell({ onRemove, children }: { onRemove: () => void; children: ReactNode }) {
  const { t } = useTranslation("builder");
  return (
    <div className="relative space-y-3 rounded-xl border border-line bg-panel-2 p-3">
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("experience.remove")}
        className="absolute end-2 top-2 rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-danger/15 hover:text-danger"
      >
        <Trash2 size={15} />
      </button>
      {children}
    </div>
  );
}

/** Chip editor — Enter/comma adds, blur commits, chips removable. */
function ChipInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState("");

  function commit() {
    const parts = text
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...values];
    for (const p of parts) {
      if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    }
    onChange(next);
    setText("");
  }

  return (
    <div>
      {values.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-bg-soft px-2.5 py-1 text-xs text-ink"
            >
              {v}
              <button
                type="button"
                aria-label={`× ${v}`}
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="text-ink-faint transition-colors hover:text-danger"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        placeholder={placeholder}
        className={inputCls}
      />
    </div>
  );
}

export default function BuilderPage() {
  const { t } = useTranslation("builder");
  const { t: tTailor } = useTranslation("tailor");
  const toast = useToast();
  const { masters, setMaster } = useMasterResume();

  const [{ resume, step }, setDraft] = useState<Draft>(loadDraft);
  const [template, setTemplate] = useState<ResumeTemplate>("classic");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const setResume = (patch: Partial<ResumeModel>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, resume: { ...d.resume, ...patch } }));
  };
  const setStep = (next: number) => setDraft((d) => ({ ...d, step: next }));

  // Phone users lose sessions constantly — every keystroke persists the draft.
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ resume, step }));
    } catch {
      // Storage full/blocked — the form still works, just without persistence.
    }
  }, [resume, step]);

  const built = useMemo(() => pruneResume(resume), [resume]);
  const hasName = built.contact.name.length > 0;
  const lang = resumeLanguage(built);
  const clash = masters.find((m) => (m.language ?? "en") === lang);

  function startOver() {
    localStorage.removeItem(DRAFT_KEY);
    setDraft({ resume: emptyResume(), step: 0 });
    setSaved(false);
  }

  async function save() {
    if (!hasName) return;
    setSaving(true);
    try {
      const m = await saveMasterResume({ resume: built, label: masterResumeLabel(built) });
      setMaster(m);
      setSaved(true);
      toast("success", t("finish.savedToast"));
    } catch {
      toast("error", t("finish.saveError"));
    } finally {
      setSaving(false);
    }
  }

  const stepLabels = STEP_IDS.map((id) => t(`steps.${id}`));
  const stepId: StepId = STEP_IDS[step];
  const nextDisabled = stepId === "contact" && !hasName;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-bold text-ink sm:text-2xl">
            <Hammer className="shrink-0 text-accent-soft" size={22} />
            {t("title")}
          </h1>
          <p className="mt-1 hidden text-sm text-ink-muted sm:block">{t("sub")}</p>
        </div>
        <Button variant="ghost" size="sm" icon={<RotateCcw size={14} />} onClick={startOver}>
          {t("startOver")}
        </Button>
      </div>

      <Stepper steps={stepLabels} current={step} />

      {stepId === "contact" && (
        <Card className="space-y-3">
          <CardTitle>{t("contact.title")}</CardTitle>
          <LabeledInput
            label={t("contact.name")}
            value={resume.contact.name}
            onChange={(v) => setResume({ contact: { ...resume.contact, name: v } })}
          />
          <LabeledInput
            label={t("contact.headline")}
            value={resume.headline ?? ""}
            onChange={(v) => setResume({ headline: v })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <LabeledInput
              label={t("contact.email")}
              type="email"
              value={resume.contact.email}
              onChange={(v) => setResume({ contact: { ...resume.contact, email: v } })}
            />
            <LabeledInput
              label={t("contact.phone")}
              type="tel"
              value={resume.contact.phone}
              onChange={(v) => setResume({ contact: { ...resume.contact, phone: v } })}
            />
            <LabeledInput
              label={t("contact.location")}
              value={resume.contact.location}
              onChange={(v) => setResume({ contact: { ...resume.contact, location: v } })}
            />
            <LabeledInput
              label={t("contact.linkedin")}
              value={resume.contact.linkedin}
              onChange={(v) => setResume({ contact: { ...resume.contact, linkedin: v } })}
            />
            <LabeledInput
              label={t("contact.website")}
              value={resume.contact.website}
              onChange={(v) => setResume({ contact: { ...resume.contact, website: v } })}
            />
          </div>
          <p className="text-xs text-ink-faint">{t("contact.optionalHint")}</p>
        </Card>
      )}

      {stepId === "experience" && (
        <>
          <Card className="space-y-3">
            <div className="flex items-center gap-2">
              <Briefcase size={17} className="text-accent-soft" />
              <CardTitle>{t("experience.title")}</CardTitle>
            </div>
            {resume.experience.length === 0 && (
              <p className="text-sm text-ink-muted">{t("experience.empty")}</p>
            )}
            {resume.experience.map((exp, i) => (
              <EntryShell
                key={i}
                onRemove={() => setResume({ experience: removeAt(resume.experience, i) })}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <LabeledInput
                    label={t("experience.role")}
                    value={exp.title}
                    onChange={(v) => setResume({ experience: updateAt(resume.experience, i, { title: v }) })}
                  />
                  <LabeledInput
                    label={t("experience.company")}
                    value={exp.company}
                    onChange={(v) => setResume({ experience: updateAt(resume.experience, i, { company: v }) })}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <LabeledInput
                    label={t("experience.location")}
                    value={exp.location}
                    onChange={(v) => setResume({ experience: updateAt(resume.experience, i, { location: v }) })}
                  />
                  <DateInputs
                    start={exp.start_date}
                    end={exp.end_date}
                    onChange={(patch) => setResume({ experience: updateAt(resume.experience, i, patch) })}
                  />
                </div>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-muted">
                    {t("experience.bullets")}
                  </span>
                  <textarea
                    value={exp.bullets.join("\n")}
                    onChange={(e) =>
                      setResume({
                        experience: updateAt(resume.experience, i, { bullets: e.target.value.split("\n") }),
                      })
                    }
                    className={areaCls}
                  />
                  <span className="mt-1 hidden text-xs text-ink-faint sm:block">
                    {t("experience.bulletsHint")}
                  </span>
                </label>
              </EntryShell>
            ))}
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus size={15} />}
              onClick={() => setResume({ experience: [...resume.experience, emptyExperience()] })}
            >
              {t("experience.add")}
            </Button>
          </Card>

          <Card className="space-y-3">
            <CardTitle>{t("projects.title")}</CardTitle>
            <p className="text-sm text-ink-muted">{t("projects.hint")}</p>
            {resume.projects.map((proj, i) => (
              <EntryShell key={i} onRemove={() => setResume({ projects: removeAt(resume.projects, i) })}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <LabeledInput
                    label={t("projects.name")}
                    value={proj.name}
                    onChange={(v) => setResume({ projects: updateAt(resume.projects, i, { name: v }) })}
                  />
                  <LabeledInput
                    label={t("projects.description")}
                    value={proj.description}
                    onChange={(v) => setResume({ projects: updateAt(resume.projects, i, { description: v }) })}
                  />
                </div>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-muted">
                    {t("projects.bullets")}
                  </span>
                  <textarea
                    value={proj.bullets.join("\n")}
                    onChange={(e) =>
                      setResume({
                        projects: updateAt(resume.projects, i, { bullets: e.target.value.split("\n") }),
                      })
                    }
                    className={areaCls}
                  />
                </label>
              </EntryShell>
            ))}
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus size={15} />}
              onClick={() => setResume({ projects: [...resume.projects, emptyProject()] })}
            >
              {t("projects.add")}
            </Button>
          </Card>
        </>
      )}

      {stepId === "service" && (
        <Card className="space-y-3">
          <div className="flex items-center gap-2">
            <Shield size={17} className="text-accent-soft" />
            <CardTitle>{t("service.title")}</CardTitle>
          </div>
          <p className="text-sm text-ink-muted">{t("service.hint")}</p>
          {(resume.military_service ?? []).map((ms, i) => (
            <EntryShell
              key={i}
              onRemove={() => setResume({ military_service: removeAt(resume.military_service ?? [], i) })}
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <LabeledInput
                  label={t("service.unit")}
                  value={ms.unit}
                  onChange={(v) =>
                    setResume({ military_service: updateAt(resume.military_service ?? [], i, { unit: v }) })
                  }
                />
                <LabeledInput
                  label={t("service.role")}
                  value={ms.role}
                  onChange={(v) =>
                    setResume({ military_service: updateAt(resume.military_service ?? [], i, { role: v }) })
                  }
                />
                <LabeledInput
                  label={t("service.rank")}
                  value={ms.rank}
                  onChange={(v) =>
                    setResume({ military_service: updateAt(resume.military_service ?? [], i, { rank: v }) })
                  }
                />
              </div>
              <DateInputs
                start={ms.start_date}
                end={ms.end_date}
                onChange={(patch) =>
                  setResume({ military_service: updateAt(resume.military_service ?? [], i, patch) })
                }
              />
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-muted">{t("service.bullets")}</span>
                <textarea
                  value={ms.bullets.join("\n")}
                  onChange={(e) =>
                    setResume({
                      military_service: updateAt(resume.military_service ?? [], i, {
                        bullets: e.target.value.split("\n"),
                      }),
                    })
                  }
                  className={areaCls}
                />
              </label>
            </EntryShell>
          ))}
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={15} />}
            onClick={() => setResume({ military_service: [...(resume.military_service ?? []), emptyService()] })}
          >
            {t("service.add")}
          </Button>
        </Card>
      )}

      {stepId === "education" && (
        <Card className="space-y-3">
          <div className="flex items-center gap-2">
            <GraduationCap size={17} className="text-accent-soft" />
            <CardTitle>{t("education.title")}</CardTitle>
          </div>
          <p className="text-sm text-ink-muted">{t("education.hint")}</p>
          {resume.education.map((edu, i) => (
            <EntryShell key={i} onRemove={() => setResume({ education: removeAt(resume.education, i) })}>
              <div className="grid gap-3 sm:grid-cols-2">
                <LabeledInput
                  label={t("education.institution")}
                  value={edu.institution}
                  onChange={(v) => setResume({ education: updateAt(resume.education, i, { institution: v }) })}
                />
                <LabeledInput
                  label={t("education.degree")}
                  value={edu.degree}
                  onChange={(v) => setResume({ education: updateAt(resume.education, i, { degree: v }) })}
                />
                <LabeledInput
                  label={t("education.field")}
                  value={edu.field}
                  onChange={(v) => setResume({ education: updateAt(resume.education, i, { field: v }) })}
                />
                <DateInputs
                  start={edu.start_date}
                  end={edu.end_date}
                  onChange={(patch) => setResume({ education: updateAt(resume.education, i, patch) })}
                />
              </div>
              <LabeledInput
                label={t("education.details")}
                value={edu.details}
                onChange={(v) => setResume({ education: updateAt(resume.education, i, { details: v }) })}
              />
            </EntryShell>
          ))}
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={15} />}
            onClick={() => setResume({ education: [...resume.education, emptyEducation()] })}
          >
            {t("education.add")}
          </Button>
        </Card>
      )}

      {stepId === "skills" && (
        <>
          <Card className="space-y-3">
            <CardTitle>{t("skills.title")}</CardTitle>
            <p className="text-sm text-ink-muted">{t("skills.hint")}</p>
            <ChipInput
              values={resume.skills}
              onChange={(skills) => setResume({ skills })}
              placeholder={t("skills.placeholder")}
            />
          </Card>
          <Card className="space-y-3">
            <CardTitle>{t("skills.languagesTitle")}</CardTitle>
            {(resume.languages ?? []).map((l, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="grid flex-1 grid-cols-2 gap-2">
                  <LabeledInput
                    label={t("skills.language")}
                    value={l.language}
                    onChange={(v) =>
                      setResume({ languages: updateAt(resume.languages ?? [], i, { language: v }) })
                    }
                  />
                  <LabeledInput
                    label={t("skills.level")}
                    value={l.level}
                    onChange={(v) => setResume({ languages: updateAt(resume.languages ?? [], i, { level: v }) })}
                    placeholder={t("skills.levelPlaceholder")}
                  />
                </div>
                <button
                  type="button"
                  aria-label={t("experience.remove")}
                  onClick={() => setResume({ languages: removeAt(resume.languages ?? [], i) })}
                  className="mb-1 rounded-lg p-2 text-ink-faint transition-colors hover:bg-danger/15 hover:text-danger"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus size={15} />}
              onClick={() =>
                setResume({ languages: [...(resume.languages ?? []), { language: "", level: "" }] })
              }
            >
              {t("skills.addLanguage")}
            </Button>
          </Card>
          <Card className="space-y-3">
            <CardTitle>{t("skills.certsTitle")}</CardTitle>
            <ChipInput
              values={resume.certifications}
              onChange={(certifications) => setResume({ certifications })}
              placeholder={t("skills.certsPlaceholder")}
            />
          </Card>
        </>
      )}

      {stepId === "finish" && (
        <>
          <Card className="space-y-3">
            <CardTitle>{t("finish.title")}</CardTitle>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-muted">
                {t("finish.summaryLabel")}
              </span>
              <textarea
                value={resume.summary}
                onChange={(e) => setResume({ summary: e.target.value })}
                className={areaCls}
              />
              <span className="mt-1 block text-xs text-ink-faint">{t("finish.summaryHint")}</span>
            </label>
            <div className="flex flex-wrap gap-1.5 text-xs text-ink-muted">
              {built.experience.length > 0 && (
                <Badge>{t("finish.counts.experience", { n: built.experience.length })}</Badge>
              )}
              {(built.military_service ?? []).length > 0 && (
                <Badge>{t("finish.counts.service", { n: (built.military_service ?? []).length })}</Badge>
              )}
              {built.education.length > 0 && (
                <Badge>{t("finish.counts.education", { n: built.education.length })}</Badge>
              )}
              {built.projects.length > 0 && (
                <Badge>{t("finish.counts.projects", { n: built.projects.length })}</Badge>
              )}
              {built.skills.length > 0 && (
                <Badge>{t("finish.counts.skills", { n: built.skills.length })}</Badge>
              )}
            </div>
            <p className="text-xs text-ink-faint">{t("finish.honesty")}</p>
          </Card>

          <Card className="space-y-3">
            {/* Template registry is ATS-safe by construction — reuse the tailor
                page's translated names so the two pickers never drift. */}
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("finish.template")}>
              {RESUME_TEMPLATES.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={template === id}
                  onClick={() => setTemplate(id)}
                  className={
                    template === id
                      ? "rounded-xl border border-accent/60 bg-accent/10 px-3 py-2 text-start transition-colors"
                      : "rounded-xl border border-line bg-panel-2 px-3 py-2 text-start transition-colors hover:border-accent/40"
                  }
                >
                  <span className="block text-sm font-semibold text-ink">
                    {tTailor(`download.templates.${id}.name`)}
                  </span>
                  <span className="block text-xs text-ink-muted">
                    {tTailor(`download.templates.${id}.desc`)}
                  </span>
                </button>
              ))}
            </div>

            {clash && !saved && (
              <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-ink">
                {t("finish.replaceWarn", { label: clash.label })}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button icon={<Save size={16} />} loading={saving} disabled={!hasName || saved} onClick={save}>
                {saved ? t("finish.saved") : t("finish.save")}
              </Button>
              <Button
                variant="secondary"
                icon={<Download size={16} />}
                disabled={!hasName}
                onClick={() => downloadResume(built, "docx", resumeFilename(built.contact.name, ""), template)}
              >
                {t("finish.docx")}
              </Button>
              <Button
                variant="secondary"
                icon={<Download size={16} />}
                disabled={!hasName}
                onClick={() => downloadResume(built, "pdf", resumeFilename(built.contact.name, ""), template)}
              >
                {t("finish.pdf")}
              </Button>
            </div>
            {!hasName && <p className="text-xs text-warn">{t("nameRequired")}</p>}
            <p className="text-xs text-ink-muted">{t("finish.atsNote")}</p>
          </Card>

          {saved && (
            <Card className="space-y-3">
              <CardTitle>{t("finish.next.title")}</CardTitle>
              <div className="flex flex-wrap gap-3">
                <Link to="/jobs">
                  <Button icon={<Briefcase size={16} />}>{t("finish.next.jobs")}</Button>
                </Link>
                <Link to="/app">
                  <Button variant="secondary" icon={<Wand2 size={16} />}>
                    {t("finish.next.tailor")}
                  </Button>
                </Link>
              </div>
            </Card>
          )}
        </>
      )}

      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>
          {t("nav.back")}
        </Button>
        {step < STEP_IDS.length - 1 ? (
          <div className="flex items-center gap-3">
            {nextDisabled && <span className="text-xs text-ink-faint">{t("nameRequired")}</span>}
            <Button disabled={nextDisabled} onClick={() => setStep(step + 1)}>
              {t("nav.next")}
            </Button>
          </div>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-ink-faint">
            <FileText size={13} /> {t("finish.autosaved")}
          </span>
        )}
      </div>
    </div>
  );
}
