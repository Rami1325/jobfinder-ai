import { useEffect, useState } from "react";
import {
  deleteApplication,
  downloadResume,
  getApplication,
  listApplications,
  updateApplication,
} from "../api/client";
import ResumeView from "../components/ResumeView";
import type { ApplicationDetail, ApplicationOut } from "../types";

const STATUSES = ["saved", "applied", "interview", "offer", "rejected"];

export default function TrackerPage() {
  const [apps, setApps] = useState<ApplicationOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      setApps(await listApplications());
    } catch {
      setError("Could not load applications. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function changeStatus(id: number, status: string) {
    const updated = await updateApplication(id, { status });
    setApps((prev) => prev.map((a) => (a.id === id ? updated : a)));
  }

  async function remove(id: number) {
    await deleteApplication(id);
    setApps((prev) => prev.filter((a) => a.id !== id));
  }

  async function view(id: number) {
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await getApplication(id));
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="panel">
      <h2>Application history</h2>
      {loading && (
        <p className="muted">
          <span className="spinner" /> Loading…
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {!loading && apps.length === 0 && (
        <p className="muted">No applications yet. Tailor a résumé and click “Save to tracker”.</p>
      )}
      {apps.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Company</th>
              <th>Score</th>
              <th>Status</th>
              <th>Saved</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {apps.map((a) => (
              <tr key={a.id}>
                <td>{a.job_title || "—"}</td>
                <td>{a.company || "—"}</td>
                <td>{a.overall_score}%</td>
                <td>
                  <select value={a.status} onChange={(e) => changeStatus(a.id, e.target.value)}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="muted">{a.created_at?.slice(0, 10)}</td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn secondary" onClick={() => view(a.id)}>
                      View
                    </button>
                    <button className="btn ghost" onClick={() => remove(a.id)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(detail || detailLoading) && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 style={{ margin: 0 }}>
                {detail ? `${detail.job_title || "Résumé"}${detail.company ? " · " + detail.company : ""}` : "Loading…"}
              </h2>
              <button className="btn ghost" onClick={() => setDetail(null)}>
                ✕ Close
              </button>
            </div>

            {detailLoading && (
              <p className="muted">
                <span className="spinner" /> Loading résumé…
              </p>
            )}

            {detail && (
              <>
                <div className="row" style={{ marginBottom: 14 }}>
                  <span className="muted">Match score: {detail.overall_score}%</span>
                  <div className="spacer" />
                  {detail.tailored_resume && (
                    <>
                      <button className="btn" onClick={() => downloadResume(detail.tailored_resume!, "docx")}>
                        Download .docx
                      </button>
                      <button
                        className="btn secondary"
                        onClick={() => downloadResume(detail.tailored_resume!, "pdf")}
                      >
                        Download .pdf
                      </button>
                    </>
                  )}
                </div>

                {detail.tailored_resume ? (
                  <ResumeView resume={detail.tailored_resume} />
                ) : (
                  <p className="muted">No saved résumé for this entry.</p>
                )}

                {detail.cover_letter && (
                  <>
                    <h3>Cover letter</h3>
                    <div className="cover-letter">{detail.cover_letter}</div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
