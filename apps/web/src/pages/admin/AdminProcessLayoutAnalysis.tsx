import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  apiFetch,
  getApiBase,
  getToken,
  type ProcessLayoutSchema,
  type ProcessListItem,
} from "../../api";
import AdminWorkflowShell from "../../components/AdminWorkflowShell";

type EditableSchema = {
  docType: string;
  fields: string[];
  newField: string;
  templateOriginalName?: string | null;
  analysisSummary?: string | null;
};

type FieldBox = {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  matchCount: number;
  bboxSource?: "pdf_word" | "vlm" | "none";
  matchedWord?: string | null;
};
type TemplateAnalyzeResponse = {
  docType: string;
  schemaJson: unknown;
  analysisSummary: string | null;
  previewImageDataUri: string | null;
  fieldBoxes: FieldBox[];
};

/** 스키마/LLM이 fields에 객체를 넣은 경우(레거시) UI 표시용 */
function fieldLabelFromSchemaEntry(x: unknown): string | null {
  if (x == null) return null;
  if (typeof x === "string") {
    const s = x.trim();
    if (!s || s === "[object Object]") return null;
    return s;
  }
  if (typeof x === "object" && !Array.isArray(x)) {
    const o = x as Record<string, unknown>;
    for (const k of ["key", "label", "name", "text", "field", "value", "title"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

function fieldsFromSchema(schemaJson: unknown): string[] {
  if (Array.isArray(schemaJson)) {
    return schemaJson.map(fieldLabelFromSchemaEntry).filter((s): s is string => Boolean(s));
  }
  if (schemaJson && typeof schemaJson === "object") {
    const obj = schemaJson as Record<string, unknown>;
    if (Array.isArray(obj.fields)) {
      return obj.fields.map(fieldLabelFromSchemaEntry).filter((s): s is string => Boolean(s));
    }
    return Object.keys(obj);
  }
  return [];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function rectShort(r: DOMRectReadOnly): { w: number; h: number } {
  return { w: round2(r.width), h: round2(r.height) };
}

/** 정규화 박스가 0~1 밖으로 나가는지·극단 비율인지 요약 (모델/좌표 이상 탐지) */
function summarizeNormBoxes(boxes: FieldBox[]) {
  const vis = boxes.filter((b) => b.w > 0.001 && b.h > 0.001);
  const rightEdges = vis.map((b) => b.x + b.w);
  const bottomEdges = vis.map((b) => b.y + b.h);
  const aspects = vis.map((b) => {
    const M = Math.max(b.w, b.h, 1e-9);
    return Math.min(b.w, b.h) / M;
  });
  return {
    total: boxes.length,
    drawn: vis.length,
    xMax: vis.length ? round2(Math.max(...rightEdges)) : null,
    yMax: vis.length ? round2(Math.max(...bottomEdges)) : null,
    anyPastRight: vis.some((b) => b.x + b.w > 1.001),
    anyPastBottom: vis.some((b) => b.y + b.h > 1.001),
    minAspect: vis.length ? round2(Math.min(...aspects)) : null,
  };
}

/**
 * bbox 미리보기: 이미지 vs SVG 픽셀 정렬, 정규화 좌표 요약.
 * DEV에서만 콘솔 출력. `localStorage.DEBUG_TEMPLATE_BBOX_UI=1` 이면 프로덕션 빌드에서도 켤 수 있음.
 */
function isTemplateBboxUiDebug(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return globalThis.localStorage?.getItem("DEBUG_TEMPLATE_BBOX_UI") === "1";
  } catch {
    return false;
  }
}

function TemplateBboxPreview(props: { docType: string; imageDataUri: string; fieldBoxes: FieldBox[] }) {
  const { docType, imageDataUri, fieldBoxes } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fieldBoxesRef = useRef(fieldBoxes);
  fieldBoxesRef.current = fieldBoxes;

  const logLayout = () => {
    if (!isTemplateBboxUiDebug()) return;
    const wrap = wrapRef.current;
    const img = imgRef.current;
    const svg = svgRef.current;
    if (!wrap || !img || !svg) return;

    const wr = wrap.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    const sr = svg.getBoundingClientRect();
    const dW = Math.abs(ir.width - sr.width);
    const dH = Math.abs(ir.height - sr.height);
    const tolPx = 1.5;
    const aligned = dW <= tolPx && dH <= tolPx;
    const imgStyle = getComputedStyle(img);
    const boxes = fieldBoxesRef.current;

    const payload = {
      docType,
      alignedOverlay: aligned,
      deltaPx: { w: round2(dW), h: round2(dH) },
      wrapClient: { w: wrap.clientWidth, h: wrap.clientHeight },
      wrapRectCss: rectShort(wr),
      img: {
        natural: { w: img.naturalWidth, h: img.naturalHeight },
        clientWH: { w: img.clientWidth, h: img.clientHeight },
        rectCss: rectShort(ir),
        computed: { width: imgStyle.width, maxWidth: imgStyle.maxWidth, objectFit: imgStyle.objectFit },
      },
      svgRectCss: rectShort(sr),
      normSummary: summarizeNormBoxes(boxes),
      fieldBoxesSample: boxes.slice(0, 5).map((b) => ({
        key: b.key,
        source: b.bboxSource,
        x: round2(b.x),
        y: round2(b.y),
        w: round2(b.w),
        h: round2(b.h),
      })),
      hint: aligned
        ? "이미지와 SVG rect 크기가 일치함. 박스가 틀리면 API 좌표(0~1)·모델 순서·페이지 불일치를 의심."
        : "이미지 rect와 SVG rect 너비/높이 차이 → 오버레이 스케일 불일치. 부모 CSS·object-fit·래퍼 width 확인.",
    };

    if (aligned) console.log("[template-bbox-layout]", payload);
    else console.warn("[template-bbox-mismatch]", payload);
  };

  useLayoutEffect(() => {
    if (!isTemplateBboxUiDebug()) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => logLayout());
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [docType, imageDataUri]);

  useLayoutEffect(() => {
    if (!isTemplateBboxUiDebug()) return;
    requestAnimationFrame(() => requestAnimationFrame(() => logLayout()));
  }, [fieldBoxes, imageDataUri, docType]);

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        display: "inline-block",
        maxWidth: "100%",
        lineHeight: 0,
        verticalAlign: "top",
      }}
    >
      <img
        ref={imgRef}
        src={imageDataUri}
        alt="template preview"
        style={{
          display: "block",
          width: "auto",
          maxWidth: "100%",
          height: "auto",
        }}
        onLoad={() => {
          requestAnimationFrame(() => requestAnimationFrame(() => logLayout()));
        }}
      />
      <svg
        ref={svgRef}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
        aria-hidden
      >
        {fieldBoxes
          .filter((b) => b.w > 0.001 && b.h > 0.001)
          .map((b, idx) => {
            const colors = ["#2563eb", "#16a34a", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];
            const color = colors[idx % colors.length];
            const tip = `${b.key} · ${b.bboxSource ?? "?"} · matchCount=${b.matchCount}${b.matchedWord ? ` · 단어:${b.matchedWord}` : ""}`;
            return (
              <rect
                key={`${b.key}-${idx}`}
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                fill="rgba(37,99,235,0.08)"
                stroke={color}
                strokeWidth={0.004}
                style={{ pointerEvents: "auto" }}
              >
                <title>{tip}</title>
              </rect>
            );
          })}
      </svg>
    </div>
  );
}

export default function AdminProcessLayoutAnalysis() {
  const [processes, setProcesses] = useState<ProcessListItem[]>([]);
  const [processId, setProcessId] = useState("");
  const [schemas, setSchemas] = useState<EditableSchema[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingDocType, setSavingDocType] = useState<string | null>(null);
  const [templateUploading, setTemplateUploading] = useState<string | null>(null);
  const [templateAnalyzing, setTemplateAnalyzing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedDocType, setSavedDocType] = useState<string | null>(null);

  const [templatePreviews, setTemplatePreviews] = useState<Record<string, { imageDataUri: string; fieldBoxes: FieldBox[] }>>(
    {}
  );

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

  async function loadSchemas(targetId: string): Promise<void> {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const sc = await apiFetch<ProcessLayoutSchema[]>(`/api/processes/${targetId}/layout-schemas`);
      setSchemas(
        sc.map((x) => ({
          docType: x.docType,
          fields: fieldsFromSchema(x.schemaJson),
          newField: "",
          templateOriginalName: x.templateOriginalName ?? null,
          analysisSummary: x.analysisSummary ?? null,
        }))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!processId) {
      setSchemas([]);
      return;
    }
    void loadSchemas(processId);
  }, [processId]);

  async function saveSchema(docType: string): Promise<void> {
    if (!processId) return;
    const item = schemas.find((x) => x.docType === docType);
    if (!item) return;
    setSavingDocType(docType);
    setError(null);
    setNotice(null);
    try {
      const fields = item.fields.map((s) => s.trim()).filter(Boolean);
      await apiFetch(`/api/processes/${processId}/layout-schemas/${encodeURIComponent(docType)}`, {
        method: "PUT",
        json: { schemaJson: { fields } },
      });
      await loadSchemas(processId);
      setNotice(`${docType} 스키마 저장 완료`);
      setSavedDocType(docType);
      window.setTimeout(() => {
        setSavedDocType((prev) => (prev === docType ? null : prev));
      }, 2200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "스키마 저장 실패");
    } finally {
      setSavingDocType(null);
    }
  }

  async function uploadTemplate(docType: string, file: File): Promise<void> {
    if (!processId) return;
    setTemplateUploading(docType);
    setError(null);
    setNotice(null);
    try {
      const token = getToken();
      const base = getApiBase();
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(
        `${base}/api/processes/${processId}/layout-schemas/${encodeURIComponent(docType)}/template`,
        {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: fd,
        }
      );
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? "템플릿 업로드 실패");
      }
      setTemplatePreviews((prev) => {
        const next = { ...prev };
        delete next[docType];
        return next;
      });
      await loadSchemas(processId);
      setNotice(`${docType} 템플릿 업로드 완료: ${file.name}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "템플릿 업로드 실패");
    } finally {
      setTemplateUploading(null);
    }
  }

  async function analyzeTemplate(docType: string): Promise<void> {
    if (!processId) return;
    setTemplateAnalyzing(docType);
    setError(null);
    setNotice(null);
    try {
      const resp = await apiFetch<TemplateAnalyzeResponse>(
        `/api/processes/${processId}/layout-schemas/${encodeURIComponent(docType)}/analyze-template`,
        {
          method: "POST",
        }
      );
      const previewUri = resp.previewImageDataUri;
      if (previewUri) {
        setTemplatePreviews((prev) => ({
          ...prev,
          [docType]: { imageDataUri: previewUri, fieldBoxes: resp.fieldBoxes ?? [] },
        }));
      } else {
        setTemplatePreviews((prev) => {
          const next = { ...prev };
          delete next[docType];
          return next;
        });
      }
      await loadSchemas(processId);
      setNotice(`${docType} 템플릿 분석 완료`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "템플릿 분석 실패");
    } finally {
      setTemplateAnalyzing(null);
    }
  }

  function updateNewField(docType: string, value: string): void {
    setSchemas((prev) => prev.map((x) => (x.docType === docType ? { ...x, newField: value } : x)));
  }

  function addField(docType: string): void {
    setSchemas((prev) =>
      prev.map((x) => {
        if (x.docType !== docType) return x;
        const v = x.newField.trim();
        if (!v || x.fields.includes(v)) return x;
        return { ...x, fields: [...x.fields, v], newField: "" };
      })
    );
  }

  function removeField(docType: string, idx: number): void {
    setSchemas((prev) =>
      prev.map((x) =>
        x.docType === docType ? { ...x, fields: x.fields.filter((_, i) => i !== idx) } : x
      )
    );
  }

  const selectedTitle = useMemo(
    () => processes.find((p) => p.id === processId)?.title ?? "",
    [processes, processId]
  );

  return (
    <AdminWorkflowShell title="레이아웃 분석" subtitle="문서 양식별 필드와 템플릿 분석 결과를 관리하세요." active="layout">
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p style={{ color: "#15803d", marginTop: "-0.25rem" }}>{notice}</p> : null}

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
        <>
          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>확정 스키마 편집 ({selectedTitle})</h2>
            {loading ? <p className="muted">불러오는 중…</p> : null}
            {!schemas.length && !loading ? (
              <p className="muted">등록된 docType이 없습니다. 프로세스 생성 시 양식명을 먼저 입력하세요.</p>
            ) : null}
            {schemas.map((s, idx) => (
              <div key={s.docType} style={{ marginBottom: "1rem", borderTop: "1px solid #e4e4e7", paddingTop: "0.8rem" }}>
                <label htmlFor={`field-add-${idx}`}>{s.docType} 필드 목록</label>
                <div className="row" style={{ marginBottom: "0.5rem" }}>
                  <input
                    id={`field-add-${idx}`}
                    type="text"
                    placeholder="필드명 입력 후 추가 (예: studentId)"
                    value={s.newField}
                    onChange={(e) => updateNewField(s.docType, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addField(s.docType);
                      }
                    }}
                    style={{ flex: 1, minWidth: "260px" }}
                  />
                  <button type="button" className="btn secondary" onClick={() => addField(s.docType)}>
                    필드 추가
                  </button>
                </div>
                {s.fields.length ? (
                  <div className="row" style={{ gap: "0.5rem", marginBottom: "0.5rem" }}>
                    {s.fields.map((f, fIdx) => (
                      <span
                        key={`${s.docType}-${f}-${fIdx}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.4rem",
                          padding: "0.2rem 0.5rem",
                          border: "1px solid #d4d4d8",
                          borderRadius: "999px",
                          background: "#fafafa",
                          fontSize: "0.84rem",
                        }}
                      >
                        {f}
                        <button
                          type="button"
                          className="btn secondary"
                          style={{ padding: "0.1rem 0.4rem", borderRadius: "999px" }}
                          onClick={() => removeField(s.docType, fIdx)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="muted" style={{ marginTop: 0, marginBottom: "0.5rem", fontSize: "0.82rem" }}>
                    아직 필드가 없습니다.
                  </p>
                )}
                <div className="row" style={{ marginTop: "0.35rem" }}>
                  <label className="btn secondary" style={{ cursor: "pointer" }}>
                    템플릿 PDF 업로드
                    <input
                      type="file"
                      accept="application/pdf"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadTemplate(s.docType, f);
                        e.currentTarget.value = "";
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => void analyzeTemplate(s.docType)}
                    disabled={templateAnalyzing === s.docType}
                  >
                    {templateAnalyzing === s.docType ? "분석 중…" : "템플릿 분석"}
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => void saveSchema(s.docType)}
                    disabled={savingDocType === s.docType || templateUploading === s.docType}
                  >
                    {savingDocType === s.docType
                      ? "저장 중…"
                      : savedDocType === s.docType
                        ? "저장됨 ✓"
                        : `${s.docType} 저장`}
                  </button>
                </div>
                {savedDocType === s.docType ? (
                  <p style={{ margin: "0.35rem 0 0", color: "#15803d", fontSize: "0.83rem" }}>
                    저장 완료: 이 스키마로 재분석을 실행할 수 있습니다.
                  </p>
                ) : null}
                {templateUploading === s.docType ? (
                  <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.82rem" }}>
                    템플릿 업로드 중…
                  </p>
                ) : null}
                {s.templateOriginalName ? (
                  <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.82rem" }}>
                    템플릿 업로드됨: <strong>{s.templateOriginalName}</strong>
                  </p>
                ) : null}
                {s.analysisSummary ? (
                  <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.82rem" }}>
                    분석 요약: {s.analysisSummary}
                  </p>
                ) : null}

                {templatePreviews[s.docType] ? (
                  <div style={{ marginTop: "0.65rem" }}>
                    <div className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.25rem" }}>
                      bbox 미리보기(템플릿)
                      {import.meta.env.DEV ? (
                        <span style={{ display: "block", marginTop: "0.2rem", opacity: 0.85 }}>
                          콘솔: <code>[template-bbox-layout]</code> 정렬 OK · <code>[template-bbox-mismatch]</code> 이미지≠SVG
                          픽셀. 프로덕션은 <code>localStorage.DEBUG_TEMPLATE_BBOX_UI=1</code> 후 새로고침.
                        </span>
                      ) : null}
                    </div>
                    {/* 테두리는 바깥만: 안쪽은 이미지+오버레이가 같은 박스를 쓰도록 해 % 기준 어긋남을 줄임 */}
                    <div
                      style={{
                        border: "1px solid #e4e4e7",
                        borderRadius: 10,
                        overflow: "hidden",
                        maxWidth: "100%",
                        width: "fit-content",
                      }}
                    >
                      {/* viewBox 0~1: strokeWidth는 사용자 단위(전체=1). 2면 선만으로 화면 전체를 덮음 → 0.003~0.006 수준 */}
                      <TemplateBboxPreview
                        docType={s.docType}
                        imageDataUri={templatePreviews[s.docType].imageDataUri}
                        fieldBoxes={templatePreviews[s.docType].fieldBoxes}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

        </>
      ) : null}
    </AdminWorkflowShell>
  );
}

