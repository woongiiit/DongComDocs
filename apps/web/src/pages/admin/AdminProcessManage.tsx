import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { apiFetch, type ProcessSubmissionOverview } from "../../api";
import AdminWorkflowShell from "../../components/AdminWorkflowShell";
import { isWithinDateWindow, todayYmdSeoul } from "../../lib/processWindow";

type FilterKind = "ongoing" | "ended";

function processMatchesFilter(p: ProcessSubmissionOverview, today: string, filter: FilterKind): boolean {
  const open = isWithinDateWindow(today, p.startDate, p.endDate);
  return filter === "ongoing" ? open : !open;
}

export default function AdminProcessManage() {
  const [data, setData] = useState<ProcessSubmissionOverview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filterProcess, setFilterProcess] = useState<FilterKind>("ongoing");

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const list = await apiFetch<ProcessSubmissionOverview[]>("/api/processes/submission-overview");
        if (!cancel) setData(list);
      } catch (e) {
        if (!cancel) setError(e instanceof Error ? e.message : "불러오기 실패");
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  const today = todayYmdSeoul();
  const filtered = useMemo(
    () => data.filter((p) => processMatchesFilter(p, today, filterProcess)),
    [data, today, filterProcess]
  );

  return (
    <AdminWorkflowShell title="프로세스 관리" subtitle="프로세스별 제출 현황을 확인하세요." active="manage">
      {error ? <p className="error">{error}</p> : null}

      <div className="card">
        <label htmlFor="proc-filter" className="muted" style={{ display: "block", marginBottom: "0.35rem" }}>
          프로세스 구간
        </label>
        <select
          id="proc-filter"
          value={filterProcess}
          onChange={(e) => setFilterProcess(e.target.value as FilterKind)}
          style={{ maxWidth: "280px" }}
        >
          <option value="ongoing">진행 중 (제출 기간 내)</option>
          <option value="ended">종료됨 (기간 밖 또는 미시작 포함)</option>
        </select>
        <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
          서울 기준 달력 날짜로 판별합니다. 기간이 비어 있으면 항상 &quot;진행 중&quot;으로 봅니다.
        </p>
      </div>

      {!filtered.length && !error ? (
        <p className="muted">해당 조건의 프로세스가 없습니다.</p>
      ) : null}

      {filtered.map((p) => {
        const statusEntries = Object.entries(p.statusCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4);
        const statusText = statusEntries.length
          ? statusEntries.map(([k, v]) => `${k}: ${v}건`).join(" · ")
          : "—";

        return (
          <Link
            key={p.id}
            to={`/admin/processes/manage/${p.id}`}
            style={{ textDecoration: "none", color: "inherit" }}
          >
            <div className="card" style={{ cursor: "pointer" }}>
              <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>
                {p.title}
                <span className="muted" style={{ fontWeight: 400, fontSize: "0.9rem" }}>
                  {" "}
                  — 제출 {p.submissionsCount}건
                </span>
              </h2>
              <p className="muted" style={{ margin: "0 0 0.5rem" }}>
                기간: {p.startDate ?? "—"} ~ {p.endDate ?? "—"} · {p.active ? "공개" : "비공개"}
              </p>
              <p className="muted" style={{ margin: 0 }}>
                상태: {statusText}
              </p>
            </div>
          </Link>
        );
      })}
    </AdminWorkflowShell>
  );
}
