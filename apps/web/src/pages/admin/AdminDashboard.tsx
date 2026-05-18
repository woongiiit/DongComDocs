import { Link } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, type AdminStats } from "../../api";
import AdminWorkflowShell from "../../components/AdminWorkflowShell";

export default function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    setStatsError(null);
    const data = await apiFetch<AdminStats>("/api/admin/stats");
    setStats(data);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadStats();
      } catch (e) {
        if (!cancelled) setStatsError(e instanceof Error ? e.message : "통계를 불러오지 못했습니다.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadStats]);

  return (
    <AdminWorkflowShell
      title="관리자 페이지"
      subtitle="서비스 이용 현황을 모니터링하고 공지사항을 관리하세요."
      active="dashboard"
    >
      {statsError ? <p className="error">{statsError}</p> : null}

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>공지사항 관리</h2>
          <Link to="/admin/announcements" className="btn">
            공지사항 관리로 이동
          </Link>
        </div>
        <p className="muted" style={{ margin: "0.5rem 0 0" }}>
          공지사항 작성·수정·삭제와 본문 내 이미지 삽입은 전용 페이지에서 진행합니다.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>서비스 이용 현황</h2>
        {!stats ? (
          <p className="muted">불러오는 중…</p>
        ) : (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: "0.75rem",
                marginTop: "0.5rem",
              }}
            >
              <StatBox label="등록된 프로세스" value={stats.processCount} sub={`공개 ${stats.activeProcessCount}`} />
              <StatBox label="누적 제출" value={stats.submissionCount} />
              <StatBox label="사용자" value={stats.userCount} sub={`관리자 ${stats.adminCount} / 학생 ${stats.studentCount}`} />
              <StatBox label="재분석 실행" value={stats.reanalysisRunsCount} sub="버튼 클릭 누적" />
              <StatBox
                label="모델 호출 (프록시)"
                value={stats.modelCallProxyCount}
                sub="분류·추출 결과 행 수"
              />
              <StatBox label="공지사항" value={stats.announcementCount} />
            </div>

            <h3 style={{ marginTop: "1.25rem", fontSize: "1rem" }}>제출 상태 분포</h3>
            {Object.keys(stats.statusCounts).length === 0 ? (
              <p className="muted">데이터가 없습니다.</p>
            ) : (
              <ul className="list" style={{ marginTop: "0.5rem" }}>
                {Object.entries(stats.statusCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([status, count]) => (
                    <li key={status} style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>{status}</span>
                      <strong>{count}건</strong>
                    </li>
                  ))}
              </ul>
            )}

            <h3 style={{ marginTop: "1.25rem", fontSize: "1rem" }}>프로세스별 제출 현황</h3>
            {stats.submissionsPerProcess.length === 0 ? (
              <p className="muted">제출 이력이 있는 프로세스가 없습니다.</p>
            ) : (
              <ul className="list" style={{ marginTop: "0.5rem" }}>
                {stats.submissionsPerProcess.map((p) => (
                  <li key={p.processId} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>
                      {p.title}
                      {!p.active ? <span className="muted"> (비공개)</span> : null}
                    </span>
                    <strong>{p.submissionsCount}건</strong>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </AdminWorkflowShell>
  );
}

function StatBox({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div
      style={{
        border: "1px solid #eee",
        borderRadius: "8px",
        padding: "0.75rem",
        background: "#fafafa",
      }}
    >
      <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
        {label}
      </p>
      <strong style={{ display: "block", fontSize: "1.4rem", marginTop: "0.25rem" }}>{value.toLocaleString("ko-KR")}</strong>
      {sub ? (
        <p className="muted" style={{ margin: "0.2rem 0 0", fontSize: "0.75rem" }}>
          {sub}
        </p>
      ) : null}
    </div>
  );
}
