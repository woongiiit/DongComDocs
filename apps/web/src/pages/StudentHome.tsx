import { Link } from "react-router-dom";
import ProcessManageMenu from "../components/ProcessManageMenu";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import { apiFetch, getToken, setToken, submitProcessFiles, type Announcement, type ProcessListItem } from "../api";
import { useAuth } from "../auth";

const DUPLICATE_SUBMIT_HINT = "이미 제출한 이력이 있는 워크플로우입니다";
const PROCESSES_PER_PAGE = 9;
type ProcessSort = "createdDesc" | "createdAsc" | "titleAsc" | "startDateAsc";

function formNamesForProcess(p: ProcessListItem): string[] {
  const rules = (p.rulesJson ?? {}) as {
    fileRules?: { maxFiles?: number; fileFormNames?: string[] };
  };
  const maxFiles = rules.fileRules?.maxFiles;
  const names = Array.isArray(rules.fileRules?.fileFormNames) ? rules.fileRules.fileFormNames : [];
  const count = Number.isFinite(maxFiles) && maxFiles && maxFiles > 0 ? maxFiles : Math.max(1, names.length);
  return Array.from({ length: count }, (_, i) => {
    const name = String(names[i] ?? "").trim();
    return name || `제출 문서 ${i + 1}`;
  });
}

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

export default function StudentHome() {
  const { me, logout } = useAuth();
  const [processes, setProcesses] = useState<ProcessListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [centerModal, setCenterModal] = useState<{ message: string; variant: "success" | "error" } | null>(
    null
  );

  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [uploadProcess, setUploadProcess] = useState<ProcessListItem | null>(null);
  const [slotFiles, setSlotFiles] = useState<Record<number, File | undefined>>({});
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sessionRemainingMs, setSessionRemainingMs] = useState<number | null>(null);
  const [sessionExpiresAtMs, setSessionExpiresAtMs] = useState<number | null>(() => tokenExpiresAtMs());
  const [extendingSession, setExtendingSession] = useState(false);
  const [processPage, setProcessPage] = useState(1);
  const [processSearch, setProcessSearch] = useState("");
  const [processSort, setProcessSort] = useState<ProcessSort>("createdDesc");
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [announcementsError, setAnnouncementsError] = useState<string | null>(null);
  const [activeAnnouncement, setActiveAnnouncement] = useState<Announcement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiFetch<ProcessListItem[]>("/api/processes");
        if (!cancelled) setProcesses(list);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "목록을 불러오지 못했습니다.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiFetch<Announcement[]>("/api/announcements");
        if (!cancelled) setAnnouncements(list);
      } catch (e) {
        if (!cancelled) setAnnouncementsError(e instanceof Error ? e.message : "공지사항을 불러오지 못했습니다.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!centerModal) return;
    const ms = centerModal.variant === "error" ? 5500 : 4000;
    const t = window.setTimeout(() => setCenterModal(null), ms);
    return () => clearTimeout(t);
  }, [centerModal]);

  useEffect(() => {
    setProcessPage(1);
  }, [processes.length, processSearch, processSort]);

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

  function openUploadModal(process: ProcessListItem) {
    if (uploadingId) return;
    setError(null);
    setCenterModal(null);
    setSlotFiles({});
    setUploadError(null);
    setUploadProcess(process);
  }

  function onTileKeyDown(e: KeyboardEvent, process: ProcessListItem) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openUploadModal(process);
    }
  }

  async function submitUploadModal() {
    if (!uploadProcess) return;
    const formNames = formNamesForProcess(uploadProcess);
    const picked = formNames.map((_, i) => slotFiles[i]);
    if (picked.some((f) => !f)) {
      setUploadError("필요한 문서를 모두 선택하세요.");
      return;
    }

    const files = picked as File[];
    const fileSlots = files.map((_, fileIndex) => ({ fileIndex, slotIndex: fileIndex }));
    setUploadingId(uploadProcess.id);
    setError(null);
    setUploadError(null);
    setCenterModal(null);
    try {
      await submitProcessFiles(uploadProcess.id, files, fileSlots);
      /* 알림은 브라우저 File.name(UTF-8) 기준 — 서버 복구 전에도 항상 올바른 표시 */
      const fileNames = files.map((f) => f.name);
      const notice =
        fileNames.length === 0
          ? "제출이 완료되었습니다."
          : fileNames.length === 1
            ? `제출이 완료되었습니다.\n\n${fileNames[0]}`
            : `제출이 완료되었습니다.\n\n${fileNames.map((name) => `- ${name}`).join("\n")}`;
      setUploadProcess(null);
      setSlotFiles({});
      setUploadError(null);
      setCenterModal({ message: notice, variant: "success" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "제출 실패";
      if (msg.includes(DUPLICATE_SUBMIT_HINT)) {
        setUploadProcess(null);
        setSlotFiles({});
        setCenterModal({ message: msg, variant: "error" });
      } else {
        setUploadError(msg);
      }
    } finally {
      setUploadingId(null);
    }
  }

  const noticeModal =
    centerModal &&
    createPortal(
      <div
        className="modal-overlay"
        role="alertdialog"
        aria-live="assertive"
        aria-modal="true"
        onClick={() => setCenterModal(null)}
      >
        <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
          <p
            className={
              centerModal.variant === "error" ? "modal-message modal-message--error" : "modal-message"
            }
          >
            {centerModal.message}
          </p>
          <button type="button" className="btn" onClick={() => setCenterModal(null)}>
            확인
          </button>
        </div>
      </div>,
      document.body
    );

  const uploadModal =
    uploadProcess &&
    createPortal(
      <div
        className="modal-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-modal-title"
        onClick={() => {
          if (!uploadingId) setUploadProcess(null);
        }}
      >
        <div className="modal-dialog modal-dialog--wide" onClick={(e) => e.stopPropagation()}>
          <h2 id="upload-modal-title" className="modal-title">
            {uploadProcess.title} 제출
          </h2>
          <p className="muted" style={{ marginTop: 0 }}>
            필요한 문서별로 파일을 하나씩 선택하세요.
          </p>
          {uploadError ? <p className="error">{uploadError}</p> : null}
          <div className="upload-slot-list">
            {formNamesForProcess(uploadProcess).map((name, idx) => {
              const file = slotFiles[idx];
              return (
                <div key={idx} className="upload-slot">
                  <div>
                    <strong>{name}</strong>
                    <p className="muted" style={{ margin: "0.2rem 0 0" }}>
                      {file ? file.name : "선택된 파일 없음"}
                    </p>
                  </div>
                  <label className="btn secondary upload-slot-button">
                    파일 선택
                    <input
                      type="file"
                      className="workflow-file-input"
                      onChange={(e) => {
                        const file = e.currentTarget.files?.[0];
                        e.currentTarget.value = "";
                        if (!file) return;
                        setUploadError(null);
                        setSlotFiles((prev) => ({ ...prev, [idx]: file }));
                      }}
                    />
                  </label>
                </div>
              );
            })}
          </div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: "1rem" }}>
            <button
              type="button"
              className="btn secondary"
              disabled={!!uploadingId}
              onClick={() => {
                setUploadProcess(null);
                setSlotFiles({});
                setUploadError(null);
              }}
            >
              취소
            </button>
            <button type="button" className="btn" disabled={!!uploadingId} onClick={() => void submitUploadModal()}>
              {uploadingId === uploadProcess.id ? "업로드 중…" : "제출"}
            </button>
          </div>
        </div>
      </div>,
      document.body
    );

  const filteredProcesses = useMemo(() => {
    const keyword = processSearch.trim().toLowerCase();
    const matched = keyword
      ? processes.filter((p) => {
          const target = [p.title, p.description ?? "", ...formNamesForProcess(p)].join(" ").toLowerCase();
          return target.includes(keyword);
        })
      : processes;

    return [...matched].sort((a, b) => {
      if (processSort === "titleAsc") return a.title.localeCompare(b.title, "ko");
      if (processSort === "startDateAsc") return (a.startDate ?? "9999-12-31").localeCompare(b.startDate ?? "9999-12-31");
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return processSort === "createdAsc" ? aTime - bTime : bTime - aTime;
    });
  }, [processSearch, processSort, processes]);

  const pageCount = Math.max(1, Math.ceil(filteredProcesses.length / PROCESSES_PER_PAGE));
  const currentPage = Math.min(processPage, pageCount);
  const visibleProcesses = filteredProcesses.slice(
    (currentPage - 1) * PROCESSES_PER_PAGE,
    currentPage * PROCESSES_PER_PAGE
  );

  const announcementModal =
    activeAnnouncement &&
    createPortal(
      <div
        className="modal-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="announcement-modal-title"
        onClick={() => setActiveAnnouncement(null)}
      >
        <div className="modal-dialog modal-dialog--wide" onClick={(e) => e.stopPropagation()}>
          <h2 id="announcement-modal-title" className="modal-title">
            {activeAnnouncement.pinned ? "[고정] " : ""}
            {activeAnnouncement.title}
          </h2>
          <p className="muted" style={{ marginTop: 0 }}>
            {new Date(activeAnnouncement.createdAt).toLocaleString("ko-KR")}
          </p>
          <div className="announcement-markdown">
            <ReactMarkdown>{activeAnnouncement.content}</ReactMarkdown>
          </div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: "1rem" }}>
            <button type="button" className="btn" onClick={() => setActiveAnnouncement(null)}>
              확인
            </button>
          </div>
        </div>
      </div>,
      document.body
    );

  return (
    <div className="login-page app-home-page">
      {noticeModal}
      {uploadModal}
      {announcementModal}

      <aside className="login-sidebar">
        <Link to="/" className="login-brand" aria-label="메인 화면으로 이동">
          <img className="login-brand__logo" src="/brand/login-logo.png" alt="Dongguk University" />
          <div className="login-brand__divider" aria-hidden />
          <span className="login-brand__service">Docs-AI</span>
        </Link>

        <section className="home-side-panel">
          <p className="workflow-eyebrow">Signed in</p>
          <h1>업무 프로세스</h1>
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
            {extendingSession ? "연장 중…" : "세션 연장"}
          </button>
        </section>

        <footer className="login-footer">
          <strong>서울 캠퍼스</strong>
          <span>업무 문서 자동화 시스템</span>
          <span>Copyright DongComDocs</span>
        </footer>
      </aside>

      <main className="login-hero workflow-hero" aria-label="업무 프로세스 목록">
        <header className="home-top-banner">
          <div>
            <p className="workflow-eyebrow">DongComDocs</p>
            <h1>업무 프로세스</h1>
            <p className="workflow-subtitle">제출할 워크플로우를 선택하세요.</p>
          </div>
          <div className="workflow-header-actions">
            <span className="workflow-header-menu-current">업무 프로세스</span>
            {me?.role === "ADMIN" ? <ProcessManageMenu /> : null}
            <Link to="/my-submissions" className="workflow-header-link">
              내 제출
            </Link>
            {me?.role === "ADMIN" ? (
              <Link to="/admin" className="workflow-header-link">
                관리자 페이지
              </Link>
            ) : null}
          </div>
        </header>

        <div className="workflow-hero-content">
          <section className="workflow-filter-bar" aria-label="프로세스 검색 및 정렬">
            <label className="workflow-filter-field">
              <span>검색</span>
              <input
                type="search"
                value={processSearch}
                placeholder="프로세스명, 설명, 문서명 검색"
                onChange={(e) => setProcessSearch(e.currentTarget.value)}
              />
            </label>
            <label className="workflow-filter-field workflow-filter-field--sort">
              <span>정렬</span>
              <select
                value={processSort}
                onChange={(e) => setProcessSort(e.currentTarget.value as ProcessSort)}
              >
                <option value="createdDesc">최신 등록순</option>
                <option value="createdAsc">오래된 등록순</option>
                <option value="titleAsc">이름순</option>
                <option value="startDateAsc">제출 시작일순</option>
              </select>
            </label>
            <p className="workflow-filter-count">
              {filteredProcesses.length}개 표시
            </p>
          </section>

          {error ? <p className="error workflow-error">{error}</p> : null}

          <div className="card workflow-card">
            <ul className="workflow-grid">
              {visibleProcesses.map((p) => (
                <li
                  key={p.id}
                  className={`workflow-tile${uploadingId === p.id ? " workflow-tile--uploading" : ""}`}
                  role="button"
                  tabIndex={uploadingId ? -1 : 0}
                  onClick={() => openUploadModal(p)}
                  onKeyDown={(e) => onTileKeyDown(e, p)}
                >
                  <div className="workflow-tile-body">
                    <strong className="workflow-tile-title">{p.title}</strong>
                    <p className="workflow-tile-period">
                      제출 기간: {p.startDate ?? "제한 없음"} ~ {p.endDate ?? "제한 없음"}
                    </p>
                    <div className="workflow-tile-divider" aria-hidden />
                    {p.description ? <p className="workflow-tile-desc">{p.description}</p> : null}
                  </div>
                  {uploadingId === p.id ? (
                    <p className="workflow-tile-hint muted">업로드 중…</p>
                  ) : (
                    <p className="workflow-tile-hint muted">클릭하여 문서별 업로드</p>
                  )}
                </li>
              ))}
            </ul>
            {!processes.length && !error ? (
              <p className="muted" style={{ marginTop: "0.75rem" }}>
                등록된 프로세스가 없습니다. 관리자에게 문의하세요.
              </p>
            ) : null}
            {processes.length > 0 && !filteredProcesses.length ? (
              <p className="muted" style={{ marginTop: "0.75rem" }}>
                검색 조건에 맞는 프로세스가 없습니다.
              </p>
            ) : null}
            {filteredProcesses.length > PROCESSES_PER_PAGE ? (
              <div className="workflow-pagination" aria-label="프로세스 페이지 이동">
                <button
                  type="button"
                  className="workflow-pagination__button"
                  disabled={currentPage <= 1}
                  onClick={() => setProcessPage((p) => Math.max(1, p - 1))}
                >
                  이전
                </button>
                <span className="workflow-pagination__status">
                  {currentPage} / {pageCount}
                </span>
                <button
                  type="button"
                  className="workflow-pagination__button"
                  disabled={currentPage >= pageCount}
                  onClick={() => setProcessPage((p) => Math.min(pageCount, p + 1))}
                >
                  다음
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </main>

      <aside className="login-info" aria-label="이용 안내">
        <section className="login-info-card">
          <div className="login-info-card__header">
            <h2>공지사항</h2>
          </div>
          {announcementsError ? (
            <p className="error" style={{ margin: 0 }}>{announcementsError}</p>
          ) : announcements.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>등록된 공지사항이 없습니다.</p>
          ) : (
            <ul className="login-notice-list">
              {announcements.slice(0, 6).map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className="notice-link-button"
                    onClick={() => setActiveAnnouncement(a)}
                  >
                    {a.pinned ? "[고정] " : ""}
                    {a.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
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
