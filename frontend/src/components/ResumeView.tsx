import { useTranslation } from "react-i18next";
import type { ResumeModel } from "../types";
import { Badge } from "./ui";

interface Props {
  resume: ResumeModel;
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

  return (
    <div
      dir="auto"
      className="rounded-xl border border-line bg-bg-soft p-5 text-ink [&_section]:mt-5"
    >
      <div className="text-xl font-bold text-ink">{c.name || t("sections.fallbackName")}</div>
      {contactBits.length > 0 && (
        <div className="mt-0.5 text-xs text-ink-muted">{contactBits.join(" · ")}</div>
      )}

      {resume.summary && (
        <section>
          <SectionHead>{t("sections.summary")}</SectionHead>
          <p className="text-sm leading-relaxed text-ink-muted">{resume.summary}</p>
        </section>
      )}

      {resume.skills.length > 0 && (
        <section>
          <SectionHead>{t("sections.skills")}</SectionHead>
          <div className="flex flex-wrap gap-1.5">
            {resume.skills.map((s) => (
              <Badge key={s}>{s}</Badge>
            ))}
          </div>
        </section>
      )}

      {resume.experience.length > 0 && (
        <section>
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
      )}

      {resume.projects.length > 0 && (
        <section>
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
      )}

      {resume.education.length > 0 && (
        <section>
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
      )}

      {(resume.military_service ?? []).length > 0 && (
        <section>
          {/* defaultValue fallbacks: catalog keys pending (locale files owned by the frontend pass) */}
          <SectionHead>{t("sections.militaryService", "Military Service")}</SectionHead>
          <div className="space-y-3">
            {(resume.military_service ?? []).map((m, i) => (
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
      )}

      {resume.certifications.length > 0 && (
        <section>
          <SectionHead>{t("sections.certifications")}</SectionHead>
          <ul className="list-disc space-y-0.5 ps-5 text-sm text-ink-muted">
            {resume.certifications.map((cert, i) => (
              <li key={i}>{cert}</li>
            ))}
          </ul>
        </section>
      )}

      {(resume.languages ?? []).length > 0 && (
        <section>
          <SectionHead>{t("sections.languages", "Languages")}</SectionHead>
          <div className="flex flex-wrap gap-1.5">
            {(resume.languages ?? []).map((l, i) => (
              <Badge key={i}>{[l.language, l.level].filter(Boolean).join(" – ")}</Badge>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
