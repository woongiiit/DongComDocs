import { Link } from "react-router-dom";
import { useEffect, useState, type ReactNode } from "react";
import { apiFetch, getToken, setToken } from "../api";
import { useAuth } from "../auth";
import ProcessManageMenu from "./ProcessManageMenu";

type AdminMenuKey = "home" | "create" | "manage" | "edit" | "layout" | "processing" | "mine" | "dashboard";

type AdminWorkflowShellProps = {
  title: string;
  subtitle: string;
  active: AdminMenuKey;
  children: ReactNode;
};

function tokenExpiresAtMs(): number | null {
  const token = getToken();
  const payloadPart = token?.split(".")[1];
  if (!payloadPart) return null;
  try {
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const json = atob(padded);
    const payload = JSON.parse(json) as { exp?: unknown };
    const exp = Number(payload.exp);
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function formatRemaining(ms: number | null): string {
  if (ms == null) return "--:--";
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function AdminMenuLink({ to, active, current, children }: { to: string; active: AdminMenuKey; current: AdminMenuKey; children: ReactNode }) {
  if (active === current) {
    return <span className="workflow-header-menu-current">{children}</span>;
  }
  return (
    <Link to={to} className="workflow-header-link">
      {children}
    </Link>
  );
}

export default function AdminWorkflowShell({ title, subtitle, active, children }: AdminWorkflowShellProps) {
  const { me, logout } = useAuth();
  const [sessionRemainingMs, setSessionRemainingMs] = useState<number | null>(null);
  const [sessionExpiresAtMs, setSessionExpiresAtMs] = useState<number | null>(() => tokenExpiresAtMs());
  const [extendingSession, setExtendingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => {
      if (!sessionExpiresAtMs) {
        setSessionRemainingMs(null);
        return;
      }
      const remaining = sessionExpiresAtMs - Date.now();
      setSessionRemainingMs(remaining);
      if (remaining <= 0) logout();
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [logout, sessionExpiresAtMs]);

  async function extendSession(): Promise<void> {
    setExtendingSession(true);
    setError(null);
    try {
      const res = await apiFetch<{ token: string }>("/api/auth/refresh", { method: "POST" });
      setToken(res.token);
      setSessionExpiresAtMs(tokenExpiresAtMs());
    } catch (e) {
      setError(e instanceof Error ? e.message : "세션 연장 실패");
    } finally {
      setExtendingSession(false);
    }
  }

  return (
    <div className="login-page app-home-page">
      <aside className="login-sidebar">
        <Link to="/" className="login-brand" aria-label="메인 화면으로 이동">
          <img className="login-brand__logo" src="/brand/login-logo.png" alt="Dongguk University" />
          <div className="login-brand__divider" aria-hidden />
          <span className="login-brand__service">Docs-AI</span>
        </Link>

        <section className="home-side-panel">
          <p className="workflow-eyebrow">Signed in</p>
          <h1>{title}</h1>
          <p>
            학번 {me?.studentId}
            <br />
            {me?.role === "ADMIN" ? "관리자" : "재학생"}
          </p>
          <div className="home-session-timer">
            <span>세션 남은 시간</span>
            <strong>{formatRemaining(sessionRemainingMs)}</strong>
          </div>
          <button type="button" className="home-logout-button" onClick={logout}>
            로그아웃
          </button>
          <button
            type="button"
            className="home-session-extend-button"
            disabled={extendingSession}
            onClick={() => void extendSession()}
          >
            {extendingSession ? "연장 중..." : "세션 연장"}
          </button>
          {error ? <p className="error" style={{ marginTop: "0.75rem" }}>{error}</p> : null}
        </section>

        <footer className="login-footer">
          <strong>서울 캠퍼스</strong>
          <span>업무 문서 자동화 시스템</span>
          <span>Copyright DongComDocs</span>
        </footer>
      </aside>

      <main className="login-hero workflow-hero" aria-label={title}>
        <header className="home-top-banner">
          <div>
            <p className="workflow-eyebrow">DongComDocs Admin</p>
            <h1>{title}</h1>
            <p className="workflow-subtitle">{subtitle}</p>
          </div>
          <nav className="workflow-header-actions" aria-label="관리자 메뉴">
            <AdminMenuLink to="/" active={active} current="home">업무 프로세스</AdminMenuLink>
            {me?.role === "ADMIN" ? <ProcessManageMenu /> : null}
            <AdminMenuLink to="/my-submissions" active={active} current="mine">내 제출</AdminMenuLink>
            {me?.role === "ADMIN" ? (
              <AdminMenuLink to="/admin" active={active} current="dashboard">관리자 페이지</AdminMenuLink>
            ) : null}
          </nav>
        </header>

        <div className="workflow-hero-content admin-shell-content">{children}</div>
      </main>

      <aside className="login-info" aria-label="이용 안내">
        <section className="login-info-card">
          <div className="login-info-card__header">
            <h2>공지사항</h2>
            <button type="button">더보기</button>
          </div>
          <p className="muted" style={{ margin: 0 }}>등록된 공지사항이 없습니다.</p>
        </section>

        <section className="login-info-card">
          <h2>이용안내</h2>
          <div className="login-guide-grid">
            <button type="button">공지사항</button>
            <button type="button">Q&A</button>
            <button type="button">FAQ</button>
            <button type="button">사용자가이드</button>
            <button type="button">원격지원</button>
          </div>
        </section>
      </aside>
    </div>
  );
}
