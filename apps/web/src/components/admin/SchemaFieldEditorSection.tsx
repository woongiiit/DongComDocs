import { type CSSProperties, type ReactNode } from "react";

export type SchemaFieldBox = {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

const BBOX_CHIP_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

function fieldHasBbox(key: string, boxes: SchemaFieldBox[]): boolean {
  const b = boxes.find((x) => x.key === key);
  return Boolean(b && b.w > 0.001 && b.h > 0.001);
}

function chipColorForField(key: string, fields: string[], boxes: SchemaFieldBox[]): string {
  const boxIdx = boxes.findIndex((b) => b.key === key && b.w > 0.001 && b.h > 0.001);
  const idx = boxIdx >= 0 ? boxIdx : fields.indexOf(key);
  return BBOX_CHIP_COLORS[(idx >= 0 ? idx : 0) % BBOX_CHIP_COLORS.length];
}

export type SchemaFieldEditorSectionProps = {
  docType: string;
  sectionId: string;
  fields: string[];
  newField: string;
  isDirty: boolean;
  previewBoxes: SchemaFieldBox[];
  hasPreview: boolean;
  hoveredField: string | null;
  saving: boolean;
  uploading: boolean;
  analyzing: boolean;
  savedFlash: boolean;
  templateOriginalName?: string | null;
  analysisSummary?: string | null;
  onNewFieldChange: (value: string) => void;
  onAddField: () => void;
  onRemoveField: (index: number) => void;
  onHoverField: (field: string | null) => void;
  onUploadTemplate: (file: File) => void;
  onAnalyzeTemplate: () => void;
  onSave: () => void;
  children?: ReactNode;
};

export default function SchemaFieldEditorSection(props: SchemaFieldEditorSectionProps) {
  const {
    docType,
    sectionId,
    fields,
    newField,
    isDirty,
    previewBoxes,
    hasPreview,
    hoveredField,
    saving,
    uploading,
    analyzing,
    savedFlash,
    templateOriginalName,
    analysisSummary,
    onNewFieldChange,
    onAddField,
    onRemoveField,
    onHoverField,
    onUploadTemplate,
    onAnalyzeTemplate,
    onSave,
    children,
  } = props;

  const noBboxCount = hasPreview ? fields.filter((f) => !fieldHasBbox(f, previewBoxes)).length : 0;

  return (
    <section className="schema-doctype-section" aria-labelledby={sectionId}>
      <div className="schema-field-panel">
        <div className="schema-field-panel__header">
          <h3 id={sectionId} className="schema-field-panel__title">
            {docType}
          </h3>
          <span className="schema-field-panel__meta">필드 {fields.length}개</span>
          {isDirty ? <span className="schema-field-badge schema-field-badge--dirty">저장 필요</span> : null}
          {noBboxCount > 0 ? (
            <span className="schema-field-badge schema-field-badge--warn" title="bbox 미리보기에 표시되지 않는 필드">
              미리보기 없음 {noBboxCount}
            </span>
          ) : null}
        </div>

        <div className="schema-field-panel__add-row">
          <input
            id={`${sectionId}-add`}
            type="text"
            placeholder="필드명 입력 후 추가 (예: 성명, studentId)"
            value={newField}
            onChange={(e) => onNewFieldChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onAddField();
              }
            }}
          />
          <button type="button" className="btn secondary" onClick={onAddField}>
            필드 추가
          </button>
        </div>

        {fields.length ? (
          <div className="schema-field-chips" role="list" aria-label={`${docType} 필드 목록`}>
            {fields.map((f, fIdx) => {
              const accent = chipColorForField(f, fields, previewBoxes);
              const hasBbox = fieldHasBbox(f, previewBoxes);
              const isHovered = hoveredField === f;
              const chipStyle = { "--chip-accent": accent } as CSSProperties;
              return (
                <div
                  key={`${docType}-${f}-${fIdx}`}
                  role="listitem"
                  className={[
                    "schema-field-chip",
                    !hasBbox && hasPreview ? "schema-field-chip--no-bbox" : "",
                    isHovered ? "schema-field-chip--hovered" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={chipStyle}
                  onMouseEnter={() => onHoverField(f)}
                  onMouseLeave={() => onHoverField(null)}
                >
                  <span className="schema-field-chip__accent" aria-hidden />
                  <span className="schema-field-chip__label">{f}</span>
                  {!hasBbox && hasPreview ? (
                    <span className="schema-field-chip__warn" title="bbox 미리보기 없음">
                      !
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="schema-field-chip__remove"
                    aria-label={`${f} 필드 삭제`}
                    onClick={() => onRemoveField(fIdx)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="schema-field-panel__empty">아직 필드가 없습니다. 분석 후 수정하거나 직접 추가하세요.</p>
        )}
      </div>

      <div className="schema-field-actions">
        <label className="btn secondary" style={{ cursor: "pointer" }}>
          템플릿 PDF 업로드
          <input
            type="file"
            accept="application/pdf"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUploadTemplate(file);
              e.currentTarget.value = "";
            }}
          />
        </label>
        <button type="button" className="btn secondary" onClick={onAnalyzeTemplate} disabled={analyzing}>
          {analyzing ? "분석 중…" : "템플릿 분석"}
        </button>
        <button
          type="button"
          className={isDirty ? "btn primary" : "btn secondary"}
          onClick={onSave}
          disabled={saving || uploading}
        >
          {saving ? "저장 중…" : savedFlash ? "저장됨 ✓" : `${docType} 저장`}
        </button>
      </div>

      {savedFlash ? (
        <p style={{ margin: "0.35rem 0 0", color: "#15803d", fontSize: "0.83rem" }}>
          저장 완료: 이 스키마로 재분석을 실행할 수 있습니다.
        </p>
      ) : null}
      {uploading ? (
        <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.82rem" }}>
          템플릿 업로드 중…
        </p>
      ) : null}
      {templateOriginalName ? (
        <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.82rem" }}>
          템플릿 업로드됨: <strong>{templateOriginalName}</strong>
        </p>
      ) : null}
      {analysisSummary ? (
        <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.82rem" }}>
          분석 요약: {analysisSummary}
        </p>
      ) : null}

      {children}
    </section>
  );
}

