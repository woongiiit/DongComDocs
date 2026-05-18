import { useEffect, useState } from "react";
import { apiFetch, getApiBase, getToken, type ProcessListItem, type ReanalysisRun } from "../../api";
import AdminWorkflowShell from "../../components/AdminWorkflowShell";

function sanitizeReanalysisBasenameSegment(title: string): string {
  const s = title
    .replace(/[\\/:*?"<>|\[\]]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return s.slice(0, 120) || "process";
}

function dateToYmdSeoulFromIso(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function dateToYmdHmSeoulFromIso(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}-${get("hour")}-${get("minute")}`;
}

function reanalysisDisplayName(processTitle: string, r: ReanalysisRun): string {
  const titlePart = sanitizeReanalysisBasenameSegment(processTitle);
  return `${titlePart}-${dateToYmdHmSeoulFromIso(r.createdAt)}`;
}

/** 동일 프로세스에서 createdAt → id 순으로 몇 번째 재분석인지 (API와 동일 규칙) */
function reanalysisOrdinal(runs: ReanalysisRun[], r: ReanalysisRun): number {
  const sorted = [...runs].sort((a, b) => {
    const t = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (t !== 0) return t;
    return a.id.localeCompare(b.id);
  });
  const idx = sorted.findIndex((x) => x.id === r.id);
  return (idx >= 0 ? idx : 0) + 1;
}

function reanalysisDownloadFilename(
  processTitle: string,
  runs: ReanalysisRun[],
  r: ReanalysisRun,
  ext: "xlsx" | "zip"
): string {
  const titlePart = sanitizeReanalysisBasenameSegment(processTitle);
  const ymd = dateToYmdSeoulFromIso(r.finishedAt ?? r.createdAt);
  const n = reanalysisOrdinal(runs, r);
  return `${titlePart}-${ymd}-${n}.${ext}`;
}

async function downloadWithAuth(path: string, filename: string): Promise<void> {
  const token = getToken();
  const base = getApiBase();
  const res = await fetch(`${base}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let message = "다운로드 실패";
    try {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      message = e.error ?? message;
    } catch {
      // noop
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AdminProcessDocumentProcessing() {
  const [processes, setProcesses] = useState<ProcessListItem[]>([]);
  const [processId, setProcessId] = useState("");
  const [runs, setRuns] = useState<ReanalysisRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);

  const anyRunning = runs.some((r) => r.status === "RUNNING");

  useEffect(() => {
    (async () => {
      try {
        const list = await apiFetch<ProcessListItem[]>("/api/processes");
        setProcesses(list);
      } catch (e) {
        setError(e instanceof Error ? e.message : "프로세스 목록 실패");
      }
    })();
  }, []);

  async function loadRuns(targetId: string): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const rs = await apiFetch<ReanalysisRun[]>(`/api/processes/${targetId}/reanalysis-runs`);
      setRuns(rs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "run 목록 불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!processId) {
      setRuns([]);
      return;
    }
    void loadRuns(processId);
  }, [processId]);

  // RUNNING 상태인 동안 주기적으로 상태를 갱신해서 진행도를 UI에 표시합니다.
  useEffect(() => {
    if (!processId) return;
    if (!anyRunning) return;
    const t = window.setInterval(() => {
      void loadRuns(processId);
    }, 2000);
    return () => window.clearInterval(t);
  }, [processId, anyRunning]);

  async function startRun(): Promise<void> {
    if (!processId) return;
    setRunning(true);
    setError(null);
    try {
      await apiFetch(`/api/processes/${processId}/reanalysis-runs`, { method: "POST" });
      await loadRuns(processId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "재분석 시작 실패");
    } finally {
      setRunning(false);
    }
  }

  const selectedProcessTitle = processes.find((p) => p.id === processId)?.title ?? "";

  return (
    <AdminWorkflowShell title="문서 처리 실행" subtitle="제출 문서를 재분석하고 결과를 다운로드하세요." active="processing">
      {error ? <p className="error">{error}</p> : null}

      <div className="card">
        <label htmlFor="proc">대상 프로세스</label>
        <select id="proc" value={processId} onChange={(e) => setProcessId(e.target.value)}>
          <option value="">선택…</option>
          {processes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </div>

      {processId ? (
        <div className="card" style={{ marginTop: "1rem" }}>
          <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>재분석 실행 / 결과 다운로드</h2>

          <div className="row" style={{ marginBottom: "0.75rem" }}>
            <button type="button" className="btn" onClick={() => void startRun()} disabled={running}>
              {running ? "요청 중…" : "재분석 시작"}
            </button>
            <button type="button" className="btn secondary" disabled={loading} onClick={() => void loadRuns(processId)}>
              새로고침
            </button>
          </div>

          {!runs.length ? <p className="muted">아직 run 이력이 없습니다.</p> : null}

          {!!runs.length ? (
            <ul className="list">
              {runs.map((r) => (
                <li key={r.id}>
                  <strong>{reanalysisDisplayName(selectedProcessTitle, r)}</strong>
                  <span className="muted"> — 상태: {r.status}</span>
                  <span className="muted"> — {new Date(r.createdAt).toLocaleString("ko-KR")}</span>
                  {r.totalFiles ? (
                    <div style={{ marginTop: "0.4rem" }}>
                      <div className="muted" style={{ fontSize: "0.95em" }}>
                        진행도: {r.processedFiles ?? 0}/{r.totalFiles}
                      </div>
                      <div
                        style={{
                          marginTop: "0.35rem",
                          height: 8,
                          background: "#e5e7eb",
                          borderRadius: 999,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.round(((r.processedFiles ?? 0) / r.totalFiles) * 100)}%`,
                            height: "100%",
                            background: r.status === "FAILED" ? "#ef4444" : "#2563eb",
                            transition: "width 0.25s ease",
                          }}
                        />
                      </div>
                    </div>
                  ) : null}
                  {r.errorMessage ? (
                    <p className="error" style={{ margin: "0.25rem 0 0" }}>
                      {r.errorMessage}
                    </p>
                  ) : null}

                  <div className="row" style={{ marginTop: "0.4rem" }}>
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={downloadBusy === r.id || r.status !== "SUCCEEDED"}
                      onClick={async () => {
                        try {
                          setDownloadBusy(r.id);
                          await downloadWithAuth(
                            `/api/processes/reanalysis-runs/${r.id}/xlsx`,
                            reanalysisDownloadFilename(selectedProcessTitle, runs, r, "xlsx")
                          );
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "xlsx 다운로드 실패");
                        } finally {
                          setDownloadBusy(null);
                        }
                      }}
                    >
                      XLSX 다운로드
                    </button>
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={downloadBusy === r.id || r.status !== "SUCCEEDED"}
                      onClick={async () => {
                        try {
                          setDownloadBusy(r.id);
                          await downloadWithAuth(
                            `/api/processes/reanalysis-runs/${r.id}/zip`,
                            reanalysisDownloadFilename(selectedProcessTitle, runs, r, "zip")
                          );
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "ZIP 다운로드 실패");
                        } finally {
                          setDownloadBusy(null);
                        }
                      }}
                    >
                      ZIP 다운로드
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </AdminWorkflowShell>
  );
}

