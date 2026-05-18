import { useCallback, useEffect, useState } from "react";
import { apiFetch, openSubmissionFileInNewTab, type Submission } from "../api";
import AdminWorkflowShell from "../components/AdminWorkflowShell";

const CANCELLABLE_STATUS = "PROCESSED_STUB";

export default function MySubmissions() {
  const [items, setItems] = useState<Submission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const list = await apiFetch<Submission[]>("/api/submissions/mine");
    setItems(list);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await load();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "불러오기 실패");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function handleOpenFile(fileId: string) {
    setError(null);
    setOpeningId(fileId);
    try {
      await openSubmissionFileInNewTab(fileId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "파일을 열 수 없습니다.");
    } finally {
      setOpeningId(null);
    }
  }

  async function handleCancelSubmission(submissionId: string) {
    if (
      !window.confirm(
        "이 제출을 취소할까요? 업로드된 파일이 삭제되고 목록에서 사라집니다. 취소 내역은 서버에 기록됩니다."
      )
    ) {
      return;
    }
    setError(null);
    setCancellingId(submissionId);
    try {
      await apiFetch<{ ok: boolean }>(`/api/submissions/${submissionId}/cancel`, {
        method: "POST",
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "취소 실패");
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <AdminWorkflowShell title="내 제출" subtitle="제출한 파일과 처리 상태를 확인하세요." active="mine">
      {error ? <p className="error">{error}</p> : null}
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          제출한 파일 이름을 누르면 새 탭에서 열어 볼 수 있습니다.
        </p>
        <ul className="list">
          {items.map((s) => (
            <li key={s.id}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                <strong>{s.process.title}</strong>
                {s.status === CANCELLABLE_STATUS ? (
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ fontSize: "0.8rem", padding: "0.35rem 0.65rem", flexShrink: 0 }}
                    disabled={cancellingId === s.id}
                    onClick={() => void handleCancelSubmission(s.id)}
                  >
                    {cancellingId === s.id ? "취소 중…" : "제출 취소"}
                  </button>
                ) : null}
              </div>
              <p className="muted" style={{ margin: "0.25rem 0" }}>
                상태: {s.status} · {new Date(s.createdAt).toLocaleString("ko-KR")}
              </p>
              <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem" }}>
                {s.files.map((f) => (
                  <li key={f.id} style={{ marginBottom: "0.35rem" }}>
                    {f.formDocType ? (
                      <span className="muted" style={{ marginRight: "0.35rem" }}>
                        [{f.formDocType}]
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="file-link"
                      disabled={openingId === f.id}
                      onClick={() => void handleOpenFile(f.id)}
                    >
                      {f.originalName}
                    </button>
                    {openingId === f.id ? (
                      <span className="muted" style={{ marginLeft: "0.35rem" }}>
                        열는 중…
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        {!items.length && !error ? <p className="muted">제출 내역이 없습니다.</p> : null}
      </div>
    </AdminWorkflowShell>
  );
}
