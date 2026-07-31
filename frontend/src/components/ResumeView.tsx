import { useTranslation } from "react-i18next";
import type { ResumeModel } from "../types";
import { Badge } from "./ui";

interface Props {
  resume: ResumeModel;
}

/**
 * Mirror of `app/core/section_order.py` (PLAN 17.5) — Education outranks
 * Experience on an early-career résumé. Duplicated rather than fetched so the
 * preview can never lay out differently from the file the user downloads; the
 * Python side is the source of truth and is pinned by the smoke test.
 */
const EARLY_CAREER_YEARS = 3;
const STUDY_WINDOW_YEARS = 6;
const EXPERIENCED_ORDER = [
  "summary", "skills", "experience", "projects", "education", "military",
  "certifications", "languages",
] as const;
const EARLY_CAREER_ORDER = [
  "summary", "skills", "education", "experience", "projects", "military",
  "certifications", "languages",
] as const;
const CURRENT_RE = /present|current|now|today|ongoing|היום|כיום|הווה/i;

/** Years of work, measured over the UNION of the roles so concurrent jobs are
 * not double counted. Year precision is enough to pick a layout. */
function yearsOfExperience(resume: ResumeModel): number {
  const yearOf = (d: string): number | null => {
    const m = /(?:19|20)\d{2}/.exec(d || "");
    return m ? Number(m[0]) : null;
  };
  const spans = resume.experience
    .map((e) => {
      const start = yearOf(e.start_date);
      if (start === null) return null;
      const end =
        yearOf(e.end_date) ??
        (!e.end_date || CURRENT_RE.test(e.end_date) ? new Date().getFullYear() : null);
      return end !== null && end > start ? ([start, end] as [number, number]) : null;
    })
    .filter((s): s is [number, number] => s !== null)
    .sort((a, b) => a[0] - b[0]);
  if (spans.length === 0) return 0;
  let total = 0;
  let [lo, hi] = spans[0];
  for (const [a, b] of spans.slice(1)) {
    if (a > hi) {
      total += hi - lo;
      [lo, hi] = [a, b];
    } else {
      hi = Math.max(hi, b);
    }
  }
  return total + hi - lo;
}

function sectionOrder(resume: ResumeModel): readonly string[] {
  if (resume.education.length === 0) return EXPERIENCED_ORDER; // nothing to promote
  if (resume.experience.length === 0) return EARLY_CAREER_ORDER;
  const thisYear = new Date().getFullYear();
  const yearOf = (d: string): number | null => {
    const m = /(?:19|20)\d{2}/.exec(d || "");
    return m ? Number(m[0]) : null;
  };
  const studying = resume.education.some((e) => {
    const end = (e.end_date || "").trim();
    if (CURRENT_RE.test(end) || /expected|צפוי/i.test(end)) return true;
    const endYear = yearOf(end);
    if (endYear !== null) return endYear > thisYear;
    // A blank end date only means "still there" when the studies began
    // recently; on an old degree it just means the field was never filled in.
    const start = yearOf(e.start_date);
    return !end && start !== null && thisYear - start <= STUDY_WINDOW_YEARS;
  });
  return studying || yearsOfExperience(resume) < EARLY_CAREER_YEARS
    ? EARLY_CAREER_ORDER
    : EXPERIENCED_ORDER;
}

/** Section heading — small uppercase accent label with a hairline underline,
 * matching the premium surfaces (replaces the old `.resume-view h4`). */
function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-1.5 border-b border-line pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-soft">
      {children}
    </h4>
  );
}

export default function ResumeView({ resume }: Props) {
  const { t } = useTranslation("tailor");
  const c = resume.contact;
  const contactBits = [c.email, c.phone, c.location, c.linkedin, c.website].filter(Boolean);
  const military = resume.military_service ?? [];
  const languages = resume.languages ?? [];

  const sections: Record<string, React.ReactNode> = {
    summary: resume.summary ? (
      <section key="summary">
        <SectionHead>{t("sections.summary")}</SectionHead>
        <p className="text-sm leading-relaxed text-ink-muted">{resume.summary}</p>
      </section>
    ) : null,

    skills: resume.skills.length > 0 ? (
      <section key="skills">
        <SectionHead>{t("sections.skills")}</SectionHead>
        <div className="flex flex-wrap gap-1.5">
          {resume.skills.map((s) => (
            <Badge key={s}>{s}</Badge>
          ))}
        </div>
      </section>
    ) : null,

    experience: resume.experience.length > 0 ? (
      <section key="experience">
        <SectionHead>{t("sections.experience")}</SectionHead>
        <div className="space-y-3">
          {resume.experience.map((e, i) => (
            <div key={i}>
              <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
                <strong className="text-sm font-semibold text-ink">
                  {[e.title, e.company].filter(Boolean).join(" — ")}
                </strong>
                <span className="text-xs text-ink-muted">
                  {[e.location, [e.start_date, e.end_date].filter(Boolean).join(" – ")]
                    .filter(Boolean)
                    .join(" | ")}
                </span>
              </div>
              <ul className="mt-1 list-disc space-y-0.5 ps-5 text-sm text-ink-muted">
                {e.bullets.map((b, j) => (
                  <li key={j}>{b}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    ) : null,

    projects: resume.projects.length > 0 ? (
      <section key="projects">
        <SectionHead>{t("sections.projects")}</SectionHead>
        <div className="space-y-3">
          {resume.projects.map((p, i) => (
            <div key={i}>
              <strong className="text-sm font-semibold text-ink">{p.name}</strong>
              {p.description && <span className="text-sm text-ink-muted"> — {p.description}</span>}
              <ul className="mt-1 list-disc space-y-0.5 ps-5 text-sm text-ink-muted">
                {p.bullets.map((b, j) => (
                  <li key={j}>{b}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    ) : null,

    education: resume.education.length > 0 ? (
      <section key="education">
        <SectionHead>{t("sections.education")}</SectionHead>
        <div className="space-y-2">
          {resume.education.map((e, i) => (
            <div key={i} className="text-sm">
              <strong className="font-semibold text-ink">
                {[e.degree, e.field].filter(Boolean).join(", ") || e.institution}
              </strong>
              <span className="text-ink-muted">
                {" "}
                {[e.institution, [e.start_date, e.end_date].filter(Boolean).join(" – ")]
                  .filter(Boolean)
                  .join(" | ")}
              </span>
              {e.details && <div className="text-ink-muted">{e.details}</div>}
            </div>
          ))}
        </div>
      </section>
    ) : null,

    military: military.length > 0 ? (
      <section key="military">
        {/* defaultValue fallbacks: catalog keys pending (locale files owned by the frontend pass) */}
        <SectionHead>{t("sections.militaryService", "Military Service")}</SectionHead>
        <div className="space-y-3">
          {military.map((m, i) => (
            <div key={i}>
              <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
                <strong className="text-sm font-semibold text-ink">
                  {[m.role, m.unit].filter(Boolean).join(" — ")}
                </strong>
                <span className="text-xs text-ink-muted">
                  {[m.rank, [m.start_date, m.end_date].filter(Boolean).join(" – ")]
                    .filter(Boolean)
                    .join(" | ")}
                </span>
              </div>
              <ul className="mt-1 list-disc space-y-0.5 ps-5 text-sm text-ink-muted">
                {m.bullets.map((b, j) => (
                  <li key={j}>{b}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    ) : null,

    certifications: resume.certifications.length > 0 ? (
      <section key="certifications">
        <SectionHead>{t("sections.certifications")}</SectionHead>
        <ul className="list-disc space-y-0.5 ps-5 text-sm text-ink-muted">
          {resume.certifications.map((cert, i) => (
            <li key={i}>{cert}</li>
          ))}
        </ul>
      </section>
    ) : null,

    languages: languages.length > 0 ? (
      <section key="languages">
        <SectionHead>{t("sections.languages", "Languages")}</SectionHead>
        <div className="flex flex-wrap gap-1.5">
          {languages.map((l, i) => (
            <Badge key={i}>{[l.language, l.level].filter(Boolean).join(" – ")}</Badge>
          ))}
        </div>
      </section>
    ) : null,
  };

  return (
    <div
      dir="auto"
      className="rounded-xl border border-line bg-bg-soft p-5 text-ink [&_section]:mt-5"
    >
      <div className="text-xl font-bold text-ink">{c.name || t("sections.fallbackName")}</div>
      {resume.headline && (
        <div className="mt-0.5 text-sm font-medium text-accent-soft">{resume.headline}</div>
      )}
      {contactBits.length > 0 && (
        <div className="mt-0.5 text-xs text-ink-muted">{contactBits.join(" · ")}</div>
      )}

      {sectionOrder(resume).map((key) => sections[key])}
    </div>
  );
}
