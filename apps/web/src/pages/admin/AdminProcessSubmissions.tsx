import { Link, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { apiFetch, type AdminProcessSubmissionsResponse } from "../../api";
import AdminWorkflowShell from "../../components/AdminWorkflowShell";

export default function AdminProcessSubmissions() {
  const { processId } = useParams<{ processId: string }>();
  const [data, setData] = useState<AdminProcessSubmissionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!processId) return;
    let cancel = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await apiFetch<AdminProcessSubmissionsResponse>(`/api/processes/${processId}/submissions`);
        if (!cancel) setData(res);
      } catch (e) {
        if (!cancel) setError(e instanceof Error ? e.message : "불러오기 실패");
      } finally {
        if (!cancel) setLoading(false);
      }
    })();

    return () => {
      cancel = true;
    };
  }, [processId]);

  return (
    <AdminWorkflowShell title="제출 현황" subtitle="프로세스별 제출 파일과 상태를 확인하세요." active="manage">
      <p>
        <Link to="/admin/processes/manage">← 프로세스 관리</Link>
      </p>

      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="muted">불러오는 중…</p> : null}

      {data ? (
        <>
          <h1 style={{ marginBottom: "0.75rem" }}>{data.process.title}</h1>
          <div className="card">
            <p className="muted" style={{ marginTop: 0 }}>
              기간: {data.process.startDate ?? "—"} ~ {data.process.endDate ?? "—"} ·{" "}
              {data.process.active ? "공개" : "비공개"}
            </p>
            <p className="muted" style={{ margin: 0 }}>
              제출 건수: {data.submissions.length}건
            </p>
          </div>

          {!data.submissions.length ? (
            <p className="muted" style={{ marginTop: "0.75rem" }}>
              아직 제출이 없습니다.
            </p>
          ) : (
            <div className="card" style={{ marginTop: "0.75rem" }}>
              <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>제출 목록 · 파일 목록</h2>
              <ul className="list">
                {data.submissions.map((s) => (
                  <li key={s.id}>
                    <strong>학번 {s.user.studentId}</strong>
                    <span className="muted"> — 상태: {s.status}</span>
                    <span className="muted"> — {new Date(s.createdAt).toLocaleString("ko-KR")}</span>
                    <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
                      파일: {s.files.map((f) => (f.formDocType ? `[${f.formDocType}] ${f.originalName}` : f.originalName)).join(", ") || "—"}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : null}
    </AdminWorkflowShell>
  );
}

