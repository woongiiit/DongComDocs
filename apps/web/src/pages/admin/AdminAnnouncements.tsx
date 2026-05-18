import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import { apiFetch, uploadAnnouncementImage, type Announcement } from "../../api";
import AdminWorkflowShell from "../../components/AdminWorkflowShell";

type Draft = {
  title: string;
  content: string;
  pinned: boolean;
};

const EMPTY_DRAFT: Draft = { title: "", content: "", pinned: false };

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ko-KR");
}

export default function AdminAnnouncements() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await apiFetch<Announcement[]>("/api/announcements");
      setItems(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function startNew() {
    setSelectedId(null);
    setDraft(EMPTY_DRAFT);
    setError(null);
  }

  function selectItem(a: Announcement) {
    setSelectedId(a.id);
    setDraft({ title: a.title, content: a.content, pinned: a.pinned });
    setError(null);
  }

  function insertAtCursor(text: string) {
    const ta = textareaRef.current;
    if (!ta) {
      setDraft((d) => ({ ...d, content: d.content + text }));
      return;
    }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const next = `${before}${text}${after}`;
    setDraft((d) => ({ ...d, content: next }));
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + text.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  async function handleImagePicked(file: File) {
    setError(null);
    setUploadingImage(true);
    try {
      const url = await uploadAnnouncementImage(file);
      const alt = file.name.replace(/\.[^.]+$/, "");
      insertAtCursor(`\n\n![${alt}](${url})\n\n`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "이미지 업로드 실패");
    } finally {
      setUploadingImage(false);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!draft.title.trim() || !draft.content.trim()) {
      setError("제목과 내용을 입력하세요.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (selectedId) {
        const updated = await apiFetch<Announcement>(`/api/announcements/${selectedId}`, {
          method: "PATCH",
          json: {
            title: draft.title.trim(),
            content: draft.content.trim(),
            pinned: draft.pinned,
          },
        });
        setItems((list) => list.map((a) => (a.id === updated.id ? updated : a)));
      } else {
        const created = await apiFetch<Announcement>("/api/announcements", {
          method: "POST",
          json: {
            title: draft.title.trim(),
            content: draft.content.trim(),
            pinned: draft.pinned,
          },
        });
        setItems((list) => [created, ...list]);
        setSelectedId(created.id);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("이 공지사항을 삭제할까요? 되돌릴 수 없습니다.")) return;
    setDeletingId(id);
    setError(null);
    try {
      await apiFetch<{ ok: boolean }>(`/api/announcements/${id}`, { method: "DELETE" });
      if (selectedId === id) startNew();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <AdminWorkflowShell
      title="공지사항 관리"
      subtitle="공지사항을 작성하고 본문에 이미지를 삽입할 수 있습니다."
      active="dashboard"
    >
      {error ? <p className="error">{error}</p> : null}

      <div className="card" style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: "1rem" }}>
        <aside style={{ borderRight: "1px solid #eee", paddingRight: "1rem" }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <strong>목록</strong>
            <button type="button" className="btn" onClick={startNew}>
              새 공지
            </button>
          </div>
          {loading ? (
            <p className="muted">불러오는 중…</p>
          ) : items.length === 0 ? (
            <p className="muted">등록된 공지사항이 없습니다.</p>
          ) : (
            <ul className="list" style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {items.map((a) => {
                const active = a.id === selectedId;
                return (
                  <li key={a.id} style={{ marginBottom: "0.4rem" }}>
                    <button
                      type="button"
                      onClick={() => selectItem(a)}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "0.5rem 0.6rem",
                        borderRadius: "6px",
                        border: active ? "1px solid #444" : "1px solid #eee",
                        background: active ? "#f5f5f5" : "#fff",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>
                        {a.pinned ? "[고정] " : ""}
                        {a.title}
                      </span>
                      <span className="muted" style={{ display: "block", fontSize: "0.75rem", marginTop: "0.2rem" }}>
                        {formatDateTime(a.createdAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section>
          <form onSubmit={handleSave}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <strong>{selectedId ? "공지사항 수정" : "새 공지사항"}</strong>
              {selectedId ? (
                <button
                  type="button"
                  className="btn secondary"
                  disabled={deletingId === selectedId}
                  onClick={() => void handleDelete(selectedId)}
                >
                  {deletingId === selectedId ? "삭제 중…" : "삭제"}
                </button>
              ) : null}
            </div>

            <label htmlFor="ann-title" style={{ marginTop: "0.5rem" }}>
              제목
            </label>
            <input
              id="ann-title"
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              maxLength={200}
              required
            />

            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginTop: "0.75rem" }}>
              <label htmlFor="ann-content">내용 (마크다운)</label>
              <div className="row" style={{ gap: "0.4rem" }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    e.currentTarget.value = "";
                    if (file) void handleImagePicked(file);
                  }}
                />
                <button
                  type="button"
                  className="btn secondary"
                  disabled={uploadingImage}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploadingImage ? "업로드 중…" : "이미지 삽입"}
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
              <textarea
                id="ann-content"
                ref={textareaRef}
                rows={18}
                value={draft.content}
                onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
                placeholder="마크다운 문법을 사용할 수 있습니다. 이미지 삽입 버튼으로 본문 내에 이미지를 넣을 수 있습니다."
                maxLength={50000}
                required
                style={{ fontFamily: "monospace" }}
              />
              <div
                style={{
                  border: "1px solid #eee",
                  borderRadius: "6px",
                  padding: "0.75rem",
                  minHeight: "12rem",
                  background: "#fafafa",
                  overflow: "auto",
                }}
                aria-label="미리보기"
              >
                {draft.content.trim() ? (
                  <div className="announcement-markdown">
                    <ReactMarkdown>{draft.content}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="muted" style={{ margin: 0 }}>미리보기 영역</p>
                )}
              </div>
            </div>

            <label style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", marginTop: "0.75rem" }}>
              <input
                type="checkbox"
                checked={draft.pinned}
                onChange={(e) => setDraft((d) => ({ ...d, pinned: e.target.checked }))}
              />
              상단 고정
            </label>

            <div className="row" style={{ marginTop: "0.75rem", gap: "0.4rem" }}>
              <button type="submit" className="btn" disabled={saving}>
                {saving ? "저장 중…" : selectedId ? "수정 저장" : "공지사항 등록"}
              </button>
              {selectedId ? (
                <button type="button" className="btn secondary" onClick={startNew} disabled={saving}>
                  새로 작성
                </button>
              ) : null}
            </div>
          </form>
        </section>
      </div>
    </AdminWorkflowShell>
  );
}
