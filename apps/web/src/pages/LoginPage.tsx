import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { apiFetch, setToken } from "../api";
import { useAuth } from "../auth";

export default function LoginPage() {
  const { me, refresh } = useAuth();
  const [studentId, setStudentId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (me) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await apiFetch<{ token: string }>("/api/auth/login", {
        method: "POST",
        json: { studentId: studentId.trim(), password },
      });
      setToken(res.token);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인 실패");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="login-page">
      <aside className="login-sidebar">
        <Link to="/" className="login-brand" aria-label="메인 화면으로 이동">
          <img className="login-brand__logo" src="/brand/login-logo.png" alt="Dongguk University" />
          <div className="login-brand__divider" aria-hidden />
          <span className="login-brand__service">Docs-AI</span>
        </Link>

        <section className="login-panel" aria-labelledby="login-title">
          <h1 id="login-title">LOGIN</h1>
          <form onSubmit={onSubmit}>
            <input
              id="studentId"
              type="text"
              autoComplete="username"
              placeholder="학번"
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              required
            />
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="비밀번호"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <label className="login-remember">
              <input type="checkbox" />
              사용자정보 저장
            </label>
            {error ? <p className="error login-error">{error}</p> : null}
            <button type="submit" className="login-submit" disabled={pending}>
              {pending ? "처리 중…" : "로그인"}
            </button>
          </form>
        </section>

        <footer className="login-footer">
          <strong>서울 캠퍼스</strong>
          <span>업무 문서 자동화 시스템</span>
          <span>Copyright DongComDocs</span>
        </footer>
      </aside>

      <main className="login-hero" aria-label="캠퍼스 이미지 영역" />

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

        <section className="login-info-card">
          <h2>관련사이트</h2>
          <div className="login-link-grid">
            <a href="https://www.dongguk.edu" target="_blank" rel="noreferrer">
              동국대학교
            </a>
            <a href="https://eclass.dongguk.edu" target="_blank" rel="noreferrer">
              e-Class
            </a>
            <a href="https://lib.dongguk.edu" target="_blank" rel="noreferrer">
              중앙도서관
            </a>
            <a href="https://github.com" target="_blank" rel="noreferrer">
              지원센터
            </a>
          </div>
        </section>
      </aside>
    </div>
  );
}
