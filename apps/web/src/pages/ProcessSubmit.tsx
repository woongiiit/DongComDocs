import { Link, useParams } from "react-router-dom";
import { useEffect, useState, type FormEvent } from "react";
import { apiFetch, submitProcessFiles, type ProcessDetail } from "../api";

export default function ProcessSubmit() {
  const { processId } = useParams<{ processId: string }>();
  const [proc, setProc] = useState<ProcessDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<FileList | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!processId) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await apiFetch<ProcessDetail>(`/api/processes/${processId}`);
        if (!cancelled) setProc(p);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "불러오기 실패");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [processId]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!processId || !files?.length) {
      setError("파일을 선택하세요.");
      return;
    }
    setError(null);
    setPending(true);
    setDone(null);
    try {
      const { submissionId } = await submitProcessFiles(processId, files);
      setDone(`제출이 완료되었습니다. (제출 ID: ${submissionId})`);
      setFiles(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "오류");
    } finally {
      setPending(false);
    }
  }

  const rules = (proc?.rulesJson ?? {}) as {
    fileRules?: { allowedExtensions?: string[]; maxFiles?: number };
    llm?: { enabled?: boolean };
  };

  return (
    <div className="layout">
      <p>
        <Link to="/">← 목록</Link>
      </p>
      {error ? <p className="error">{error}</p> : null}
      {done ? <p style={{ color: "#15803d" }}>{done}</p> : null}

      {!proc && !error ? <p className="muted">불러오는 중…</p> : null}

      {proc ? (
        <div className="card">
          <h1 style={{ marginTop: 0 }}>{proc.title}</h1>
          <p className="muted">
            제출 기간: {proc.startDate ?? "제한 없음"} ~ {proc.endDate ?? "제한 없음"}
          </p>
          {proc.description ? <p className="muted">{proc.description}</p> : null}
          {rules.fileRules?.allowedExtensions?.length ? (
            <p className="muted">
              허용 확장자: {rules.fileRules.allowedExtensions.map((x) => `.${x}`).join(", ")}
            </p>
          ) : null}
          {rules.fileRules?.maxFiles != null ? (
            <p className="muted">제출 파일 수: {rules.fileRules.maxFiles}</p>
          ) : null}

          <form onSubmit={onSubmit} style={{ marginTop: "1rem" }}>
            <label htmlFor="files">파일</label>
            <input
              id="files"
              type="file"
              multiple
              onChange={(ev) => setFiles(ev.target.files)}
            />
            <div className="row" style={{ marginTop: "1rem" }}>
              <button type="submit" className="btn" disabled={pending}>
                {pending ? "업로드 중…" : "제출하기"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
