import { useNavigate } from "react-router-dom";
import { useState, type FormEvent } from "react";
import { apiFetch } from "../../api";
import AdminWorkflowShell from "../../components/AdminWorkflowShell";
import { emptyRules, rulesJsonFromForm, type RulesForm } from "./rulesForm";

export default function AdminProcessCreate() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [rules, setRules] = useState<RulesForm>(emptyRules);
  const [pending, setPending] = useState(false);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiFetch("/api/processes", {
        method: "POST",
        json: {
          title: title.trim(),
          description: description.trim() || undefined,
          active: true,
          startDate: startDate.trim() || undefined,
          endDate: endDate.trim() || undefined,
          rulesJson: rulesJsonFromForm(rules),
        },
      });
      setPending(false);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "생성 실패");
      setPending(false);
    }
  }

  return (
    <AdminWorkflowShell title="프로세스 생성" subtitle="새 업무 프로세스와 제출 규칙을 등록하세요." active="create">
      {error ? <p className="error">{error}</p> : null}

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>새 프로세스</h2>
        <form onSubmit={onCreate}>
          <label htmlFor="title">제목</label>
          <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required />

          <label htmlFor="desc" style={{ marginTop: "0.75rem" }}>
            설명 (선택)
          </label>
          <textarea id="desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />

          <p className="muted" style={{ margin: "0.75rem 0 0.25rem" }}>
            제출 기간 (선택, 비우면 항상 허용 — 서울 기준 달력 날짜)
          </p>
          <label htmlFor="startDate">시작일</label>
          <input
            id="startDate"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
          <label htmlFor="endDate" style={{ marginTop: "0.5rem" }}>
            종료일
          </label>
          <input id="endDate" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />

          <p className="muted" style={{ marginBottom: "0.25rem" }}>
            파일 규칙
          </p>
          <label htmlFor="ext">허용 확장자 (쉼표)</label>
          <input
            id="ext"
            value={rules.allowedExtensions}
            onChange={(e) => setRules((r) => ({ ...r, allowedExtensions: e.target.value }))}
          />
          <label htmlFor="maxf" style={{ marginTop: "0.5rem" }}>
            제출 파일 수
          </label>
          <input
            id="maxf"
            type="number"
            min={1}
            value={rules.submitFileCount}
            onChange={(e) => {
              const next = e.target.value;
              const n = next.trim() ? Number(next) : undefined;
              if (!n || !Number.isFinite(n) || n <= 0) {
                setRules((r) => ({ ...r, submitFileCount: next }));
                return;
              }
              setRules((r) => ({
                ...r,
                submitFileCount: next,
                fileFormNames: Array.from({ length: n }, (_, i) => r.fileFormNames[i] ?? ""),
              }));
            }}
          />

          {rules.submitFileCount.trim() && Number.isFinite(Number(rules.submitFileCount)) && Number(rules.submitFileCount) > 0 ? (
            <div style={{ marginTop: "0.75rem" }}>
              <p className="muted" style={{ margin: "0 0 0.35rem", fontSize: "0.85rem" }}>
                제출 파일별 양식명(표시용)
              </p>
              {rules.fileFormNames.map((name, idx) => (
                <div key={idx} className="row" style={{ gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center" }}>
                  <label style={{ margin: 0, minWidth: "8rem" }}>#{idx + 1}</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => {
                      const v = e.target.value;
                      setRules((r) => {
                        const nextNames = r.fileFormNames.slice();
                        nextNames[idx] = v;
                        return { ...r, fileFormNames: nextNames };
                      });
                    }}
                    placeholder="예: 신청서(1), 위임장(2) ..."
                    style={{ flex: 1 }}
                  />
                </div>
              ))}
            </div>
          ) : null}

          <label className="row" style={{ marginTop: "0.75rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={rules.llmEnabled}
              onChange={(e) => setRules((r) => ({ ...r, llmEnabled: e.target.checked }))}
            />
            LLM 분석 사용 (현재는 스텁)
          </label>
          {rules.llmEnabled ? (
            <>
              <label htmlFor="prompt" style={{ marginTop: "0.5rem" }}>
                LLM에 줄 지시 (프롬프트)
              </label>
              <textarea
                id="prompt"
                rows={4}
                value={rules.llmPrompt}
                onChange={(e) => setRules((r) => ({ ...r, llmPrompt: e.target.value }))}
                placeholder="예: 신청서에서 학번과 신청 장학명을 추출하세요."
              />
            </>
          ) : null}

          <div className="row" style={{ marginTop: "1rem" }}>
            <button type="submit" className="btn" disabled={pending}>
              등록
            </button>
          </div>
        </form>
      </div>
    </AdminWorkflowShell>
  );
}
