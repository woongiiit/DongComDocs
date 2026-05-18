import { useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { apiFetch, type ProcessDetail, type ProcessListItem } from "../../api";
import AdminWorkflowShell from "../../components/AdminWorkflowShell";
import { isWithinDateWindow, todayYmdSeoul } from "../../lib/processWindow";
import { emptyRules, rulesFromJson, rulesJsonFromForm, type RulesForm } from "./rulesForm";

export default function AdminProcessEdit() {
  const navigate = useNavigate();
  const [list, setList] = useState<ProcessListItem[]>([]);
  const [processId, setProcessId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [active, setActive] = useState(true);
  const [rules, setRules] = useState<RulesForm>(emptyRules);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loadListErr, setLoadListErr] = useState<string | null>(null);

  const today = todayYmdSeoul();

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const processes = await apiFetch<ProcessListItem[]>("/api/processes");
        if (!cancel) setList(processes);
      } catch (e) {
        if (!cancel) setLoadListErr(e instanceof Error ? e.message : "목록 실패");
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  const ongoingOptions = useMemo(
    () => list.filter((p) => isWithinDateWindow(today, p.startDate, p.endDate)),
    [list, today]
  );

  useEffect(() => {
    if (!processId) {
      setTitle("");
      setDescription("");
      setStartDate("");
      setEndDate("");
      setActive(true);
      setRules(emptyRules);
      return;
    }
    let cancel = false;
    (async () => {
      try {
        const p = await apiFetch<ProcessDetail>(`/api/processes/${processId}`);
        if (cancel) return;
        setTitle(p.title);
        setDescription(p.description ?? "");
        setStartDate(p.startDate ?? "");
        setEndDate(p.endDate ?? "");
        setActive(p.active);
        setRules(rulesFromJson(p.rulesJson));
        setError(null);
      } catch (e) {
        if (!cancel) setError(e instanceof Error ? e.message : "불러오기 실패");
      }
    })();
    return () => {
      cancel = true;
    };
  }, [processId]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!processId) return;
    setPending(true);
    setError(null);
    try {
      await apiFetch(`/api/processes/${processId}`, {
        method: "PATCH",
        json: {
          title: title.trim(),
          description: description.trim() || undefined,
          active,
          startDate: startDate.trim() || null,
          endDate: endDate.trim() || null,
          rulesJson: rulesJsonFromForm(rules),
        },
      });
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setPending(false);
    }
  }

  return (
    <AdminWorkflowShell title="프로세스 수정" subtitle="진행 중인 프로세스의 설정을 변경하세요." active="edit">
      <p className="muted">진행 중(제출 기간 내)인 프로세스만 선택할 수 있습니다.</p>
      {loadListErr ? <p className="error">{loadListErr}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <div className="card">
        <label htmlFor="pick">수정할 프로세스</label>
        <select
          id="pick"
          value={processId}
          onChange={(e) => setProcessId(e.target.value)}
          style={{ marginTop: "0.35rem", maxWidth: "100%" }}
        >
          <option value="">선택…</option>
          {ongoingOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        {!ongoingOptions.length && !loadListErr ? (
          <p className="muted" style={{ marginTop: "0.75rem" }}>
            진행 중인 프로세스가 없습니다.
          </p>
        ) : null}
      </div>

      {processId ? (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>내용 편집</h2>
          <form onSubmit={onSave}>
            <label htmlFor="title">제목</label>
            <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required />

            <label htmlFor="desc" style={{ marginTop: "0.75rem" }}>
              설명 (선택)
            </label>
            <textarea id="desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />

            <label className="row" style={{ marginTop: "0.75rem", cursor: "pointer" }}>
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              학생에게 공개 (active)
            </label>

            <p className="muted" style={{ margin: "0.75rem 0 0.25rem" }}>
              제출 기간 (비우면 제한 없음)
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

            <p className="muted" style={{ marginBottom: "0.25rem", marginTop: "0.75rem" }}>
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

          {rules.submitFileCount.trim() &&
          Number.isFinite(Number(rules.submitFileCount)) &&
          Number(rules.submitFileCount) > 0 ? (
            <div style={{ marginTop: "0.75rem" }}>
              <p className="muted" style={{ margin: "0 0 0.35rem", fontSize: "0.85rem" }}>
                제출 파일별 양식명(표시용)
              </p>
              {rules.fileFormNames.map((name, idx) => (
                <div
                  key={idx}
                  className="row"
                  style={{ gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center" }}
                >
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
                />
              </>
            ) : null}

            <div className="row" style={{ marginTop: "1rem" }}>
              <button type="submit" className="btn" disabled={pending}>
                저장
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </AdminWorkflowShell>
  );
}
