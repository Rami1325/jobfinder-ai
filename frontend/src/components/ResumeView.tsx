import { useTranslation } from "react-i18next";
import type { ResumeModel } from "../types";

interface Props {
  resume: ResumeModel;
}

export default function ResumeView({ resume }: Props) {
  const { t } = useTranslation("tailor");
  const c = resume.contact;
  const contactBits = [c.email, c.phone, c.location, c.linkedin, c.website].filter(Boolean);

  return (
    <div className="resume-view">
      <div className="rv-name">{c.name || t("sections.fallbackName")}</div>
      {contactBits.length > 0 && <div className="rv-contact">{contactBits.join(" · ")}</div>}

      {resume.summary && (
        <section>
          <h4>{t("sections.summary")}</h4>
          <p>{resume.summary}</p>
        </section>
      )}

      {resume.skills.length > 0 && (
        <section>
          <h4>{t("sections.skills")}</h4>
          <div>
            {resume.skills.map((s) => (
              <span key={s} className="tag">{s}</span>
            ))}
          </div>
        </section>
      )}

      {resume.experience.length > 0 && (
        <section>
          <h4>{t("sections.experience")}</h4>
          {resume.experience.map((e, i) => (
            <div key={i} className="rv-item">
              <div className="rv-item-head">
                <strong>{[e.title, e.company].filter(Boolean).join(" — ")}</strong>
                <span className="muted">
                  {[e.location, [e.start_date, e.end_date].filter(Boolean).join(" – ")]
                    .filter(Boolean)
                    .join(" | ")}
                </span>
              </div>
              <ul>
                {e.bullets.map((b, j) => (
                  <li key={j}>{b}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {resume.projects.length > 0 && (
        <section>
          <h4>{t("sections.projects")}</h4>
          {resume.projects.map((p, i) => (
            <div key={i} className="rv-item">
              <strong>{p.name}</strong>
              {p.description && <span className="muted"> — {p.description}</span>}
              <ul>
                {p.bullets.map((b, j) => (
                  <li key={j}>{b}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {resume.education.length > 0 && (
        <section>
          <h4>{t("sections.education")}</h4>
          {resume.education.map((e, i) => (
            <div key={i} className="rv-item">
              <strong>{[e.degree, e.field].filter(Boolean).join(", ") || e.institution}</strong>
              <span className="muted">
                {" "}
                {[e.institution, [e.start_date, e.end_date].filter(Boolean).join(" – ")]
                  .filter(Boolean)
                  .join(" | ")}
              </span>
              {e.details && <div>{e.details}</div>}
            </div>
          ))}
        </section>
      )}

      {resume.certifications.length > 0 && (
        <section>
          <h4>{t("sections.certifications")}</h4>
          <ul>
            {resume.certifications.map((cert, i) => (
              <li key={i}>{cert}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
