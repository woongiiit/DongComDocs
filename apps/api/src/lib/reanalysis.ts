import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

function pythonCmd(): string {
  return process.env.PYTHON_BIN?.trim() || (process.platform === "win32" ? "python" : "python3");
}

export type SchemaSnapshot = Record<string, string[]>;

export type LlmClassification = {
  docType: string;
  confidence: number;
  extractedFields: Record<string, unknown>;
};

/** VLM/계층에서 온 박스. page는 1부터(첫 번째로 보낸 이미지=1). 미리보기는 1페이지만 보여줄 때 필터에 사용 */
export type TemplateFieldBBox = {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  page?: number;
};

export type TemplateAnalysisResult = {
  fields: string[];
  summary: string;
  fieldBboxes?: TemplateFieldBBox[];
};

/** 스키마/추출값 공통 상한 (범용 정형문서용) */
const MAX_FIELD_KEY_LEN = 80;
const SOFT_FIELD_KEY_LEN = 48;
const MAX_SCHEMA_FIELDS = 120;
const MAX_EXTRACTED_STRING_LEN = 500;
const MAX_NESTED_LABEL_LEN = 60;

const BOILERPLATE_KEY_RE =
  /(다음을\s*확인|확인\s*후|체크|※|주의\s*사항|위\s*사항|본인은|아래의|신청\s*후|취소|불가|확인합니다|확인\s*후\s*['']?V['']?|V\s*표시|해당시에만|필요시만|작성\s*필요시|이하\s*생략)/;
const INSTRUCTION_LIKE_KEY_RE =
  /(졸업요건|따름|경우|가능|불가능|확인사항|신청인\s*:|승인|완료됨|취소가|불가함|수정불가|신청합니다)/;

export type FieldKeyPostprocessLog = { raw: string; reason: string; replacement?: string };

function isProbableSentenceFieldKey(s: string): boolean {
  if (/※|해당시에만|필요시만|이하\s*생략|작성\s*필요/.test(s)) return true;
  if (BOILERPLATE_KEY_RE.test(s)) return true;
  if (s.length > SOFT_FIELD_KEY_LEN && /[.。?？!！]/.test(s)) return true;
  if (/(습니다|합니다|입니다)(\s|[.。!?]|$)/.test(s) && s.length > 24) return true;
  if (s.length > 20 && INSTRUCTION_LIKE_KEY_RE.test(s)) return true;
  return false;
}

/** 괄호·※·조건부 안내 접미사 등 필드 키 노이즈 제거 */
function stripFieldKeyNoise(s: string): string {
  let t = s.replace(/\s+/g, " ").trim();
  t = t.replace(/\([^)]{0,120}\)/g, "").replace(/（[^）]{0,120}）/g, "");
  t = t.replace(/※.*/g, "");
  const parts = t.split("_").map((part) => {
    let seg = part.trim();
    if (!seg) return "";
    seg = seg.replace(/해당시에만.*/g, "");
    seg = seg.replace(/필요시(만)?.*/g, "");
    seg = seg.replace(/작성\s*필요.*/g, "");
    seg = seg.replace(/이하\s*생략.*/g, "");
    seg = seg.replace(/진학전공까지확정.*/g, "");
    seg = seg.replace(/등$/g, "");
    if (/(발급|서약서|성적증명|별지|귀하|\d+부)/.test(seg) && seg.length > 10) return "";
    return seg.trim();
  });
  return parts.filter(Boolean).join("_").replace(/_+/g, "_").replace(/^_|_$/g, "").trim();
}

/**
 * 레이아웃 스키마 필드명 후보 정리. 장문·안내 문장형 키는 제거하거나 짧은 키로 치환.
 */
export function sanitizeFieldKeyCandidate(raw: string): string | null {
  let s = stripFieldKeyNoise(raw);
  s = s.replace(/^[\s._]+|[\s._]+$/g, "");
  if (!s) return null;
  if (s.length > MAX_FIELD_KEY_LEN) return null;
  if (/^[\d\s\-_.,:;]+$/.test(s)) return null;
  return s;
}

/**
 * 중복·포함 관계 필드 정리. 예: `학과`+`지원학과` → `지원학과`만, `현소속`+`현소속_2` → `현소속`만.
 */
export function collapseOverlappingFieldKeys(fields: string[]): string[] {
  const list = [...fields];
  const drop = new Set<string>();

  for (const f of list) {
    if (drop.has(f)) continue;
    const tail = fieldKeyTailForMatch(f).replace(/\s+/g, "");
    if (!tail) continue;

    for (const g of list) {
      if (f === g || drop.has(f)) continue;
      const gt = fieldKeyTailForMatch(g).replace(/\s+/g, "");
      if (!gt) continue;

      if (tail === gt) {
        if (/_\d+$/.test(f) && !/_\d+$/.test(g)) drop.add(f);
        else if (/_\d+$/.test(g) && !/_\d+$/.test(f)) drop.add(g);
        continue;
      }

      if (tail.length >= 2 && tail.length <= 10 && gt.length > tail.length && gt.includes(tail)) {
        const fBare = !f.includes("_") || /_\d+$/.test(f);
        if (fBare && (gt.endsWith(tail) || tail.length <= 4)) {
          drop.add(f);
        }
      }
    }
  }

  return list.filter((f) => !drop.has(f));
}

export function normalizeSchemaFieldKeys(
  input: string[],
  context: string
): { fields: string[]; log: FieldKeyPostprocessLog[] } {
  const log: FieldKeyPostprocessLog[] = [];
  const seen = new Set<string>();
  const out: string[] = [];
  let confirmCounter = 0;

  for (const raw of collapseOverlappingFieldKeys(input)) {
    if (out.length >= MAX_SCHEMA_FIELDS) break;
    const base = normalizeFieldListItem(raw);
    if (!base) {
      log.push({ raw: String(raw).slice(0, 120), reason: "normalize_null" });
      continue;
    }
    let candidate = sanitizeFieldKeyCandidate(base);
    if (!candidate) {
      log.push({ raw: base, reason: "sanitize_reject" });
      continue;
    }

    let finalKey = candidate;
    if (candidate.length > SOFT_FIELD_KEY_LEN && base.includes("확인사항")) {
      confirmCounter += 1;
      finalKey = `섹션_확인사항_${String(confirmCounter).padStart(2, "0")}`;
      log.push({ raw: base, reason: "long_confirm_rewrite", replacement: finalKey });
    } else if (isProbableSentenceFieldKey(candidate)) {
      log.push({ raw: base, reason: "sentence_like_reject" });
      continue;
    } else if (shouldSkipFieldBboxPreview(candidate)) {
      log.push({ raw: base, reason: "non_input_label_reject" });
      continue;
    } else if (isTitleOrHeaderNoiseField(candidate)) {
      log.push({ raw: base, reason: "title_header_noise_reject" });
      continue;
    } else if (fieldKeyStrictEnabled() && !isLikelyInputFieldLabel(candidate)) {
      log.push({ raw: base, reason: "unlikely_input_label_reject" });
      continue;
    }

    let key = finalKey;
    let n = 2;
    while (seen.has(key)) {
      key = `${finalKey}_${n}`;
      n += 1;
    }
    if (key !== finalKey) log.push({ raw: finalKey, reason: "dedup_suffix", replacement: key });
    seen.add(key);
    out.push(key);
  }

  if (log.length) {
    console.info(`[field-key-postprocess:${context}]`, {
      kept: out.length,
      events: log.length,
      sample: log.slice(0, 25),
    });
  }
  return { fields: out, log };
}

/** LLM 추출값 후처리: 문자열 길이 제한, 중첩 라벨 길이 제한, 빈 객체는 "" */
export function postProcessLlmExtractedValue(v: unknown): unknown {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > MAX_EXTRACTED_STRING_LEN ? t.slice(0, MAX_EXTRACTED_STRING_LEN) : t;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v).trim();
  if (Array.isArray(v)) {
    return v.map((x) => postProcessLlmExtractedValue(x)).map(String).join(", ");
  }
  if (typeof v === "object" && v && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(obj)) {
      const kk = k.length > MAX_NESTED_LABEL_LEN ? `${k.slice(0, MAX_NESTED_LABEL_LEN)}…` : k;
      out[kk] = postProcessLlmExtractedValue(vv);
    }
    const has = Object.values(out).some((x) => {
      if (typeof x === "string") return x.trim().length > 0;
      if (x && typeof x === "object" && !Array.isArray(x)) {
        return Object.values(x as Record<string, unknown>).some((y) => {
          if (typeof y === "string") return y.trim().length > 0;
          return y != null && y !== "";
        });
      }
      return false;
    });
    return has ? out : "";
  }
  const s = String(v).trim();
  return s.length > MAX_EXTRACTED_STRING_LEN ? s.slice(0, MAX_EXTRACTED_STRING_LEN) : s;
}

/** VLM이 fields에 객체({ key, label, name, ... })를 넣을 때 문자열로 복원. String(obj)는 [object Object]가 됨 */
export function normalizeFieldListItem(x: unknown): string | null {
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

export function extractFieldKeys(schemaJson: unknown): string[] {
  let raw: string[] = [];
  if (Array.isArray(schemaJson)) {
    raw = schemaJson.map(normalizeFieldListItem).filter((s): s is string => Boolean(s));
  } else if (schemaJson && typeof schemaJson === "object") {
    const obj = schemaJson as Record<string, unknown>;
    if (Array.isArray(obj.fields)) {
      raw = obj.fields.map(normalizeFieldListItem).filter((s): s is string => Boolean(s));
    } else {
      raw = Object.keys(obj).filter(Boolean);
    }
  }
  return normalizeSchemaFieldKeys(raw, "extractFieldKeys").fields;
}

export function normalizeDocTypesFromRulesJson(rulesJson: unknown): string[] {
  const r = (rulesJson ?? {}) as { fileRules?: { fileFormNames?: string[] } };
  const names = Array.isArray(r.fileRules?.fileFormNames) ? r.fileRules!.fileFormNames : [];
  return names.map((x) => String(x ?? "").trim()).filter(Boolean);
}

export function sanitizeSheetName(name: string): string {
  const stripped = name.replace(/[\\/*?:\[\]]/g, "_").trim();
  return stripped.slice(0, 31) || "Sheet";
}

/** Excel 시트명 31자 제한 + sanitize 후에도 서로 다른 docType이 같아질 때 중복 방지 */
export function uniqueSheetName(rawName: string, usedNames: Set<string>): string {
  const base = rawName.replace(/[\\/*?:\[\]]/g, "_").trim() || "Sheet";
  for (let i = 0; i < 1000; i++) {
    const suffix = i === 0 ? "" : ` (${i + 1})`;
    const maxBase = Math.max(1, 31 - suffix.length);
    const truncatedBase = base.slice(0, maxBase);
    const candidate = (truncatedBase + suffix).slice(0, 31);
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
  const fallback = `S${usedNames.size}`.slice(0, 31);
  usedNames.add(fallback);
  return fallback;
}

export function getLlmStudentId(extractedFields: Record<string, unknown>): string | null {
  const normalized = extractedFields as unknown as Record<string, unknown>;

  const findInObject = (obj: Record<string, unknown>): string | null => {
    for (const [k, v] of Object.entries(obj)) {
      const n = k.toLowerCase();
      const isStudentIdKey = n === "studentid" || n === "student_id" || n.includes("학번");
      if (isStudentIdKey) {
        if (typeof v === "string" && v.trim()) return v.trim();
        if (typeof v === "number" || typeof v === "boolean") return String(v).trim();
      }

      if (v && typeof v === "object" && !Array.isArray(v)) {
        const inner = findInObject(v as Record<string, unknown>);
        if (inner) return inner;
      }
    }
    return null;
  };

  return findInObject(normalized);
}

export function renderFirstPageToDataUri(pdfAbsPath: string, scale = 2): string {
  const tmpPng = path.join(os.tmpdir(), `reanalysis-${randomUUID()}.png`);
  try {
    const script = [
      "import fitz,sys",
      "doc=fitz.open(sys.argv[1])",
      `pix=doc[0].get_pixmap(matrix=fitz.Matrix(${scale},${scale}))`,
      "pix.save(sys.argv[2])",
    ].join(";");
    const out = spawnSync(pythonCmd(), ["-c", script, pdfAbsPath, tmpPng], {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (out.status !== 0) {
      throw new Error(out.stderr || out.stdout || "PDF 렌더링 실패");
    }
    const b64 = fs.readFileSync(tmpPng).toString("base64");
    return `data:image/png;base64,${b64}`;
  } finally {
    try {
      if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng);
    } catch {
      // noop
    }
  }
}

export function extractFirstPageWordBboxesNormalized(
  pdfAbsPath: string,
  scale = 3
): { text: string; x: number; y: number; w: number; h: number }[] {
  const script = [
    "import fitz,sys,os,json",
    "sys.stdout.reconfigure(encoding='utf-8')",
    "doc = fitz.open(sys.argv[1])",
    "page = doc[0]",
    "scale = float(sys.argv[2])",
    "pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))",
    "img_w, img_h = pix.width, pix.height",
    "page_h = page.rect.height",
    "words = page.get_text('words')",
    "out = []",
    "for w in words:",
    "    x0,y0,x1,y1,word = w[0],w[1],w[2],w[3],w[4]",
    "    x0p = x0 * scale",
    "    x1p = x1 * scale",
    // PyMuPDF word coordinates are already in a top-left origin space.
    "    y0p = y0 * scale",
    "    y1p = y1 * scale",
    "    if img_w <= 0 or img_h <= 0:",
    "        continue",
    "    x = x0p / img_w",
    "    y = y0p / img_h",
    "    ww = max(0.0, (x1p - x0p) / img_w)",
    "    hh = max(0.0, (y1p - y0p) / img_h)",
    "    out.append({'text': word, 'x': x, 'y': y, 'w': ww, 'h': hh})",
    "print(json.dumps(out, ensure_ascii=False))",
  ].join("\n");

  const out = spawnSync(pythonCmd(), ["-c", script, pdfAbsPath, String(scale)], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
    },
  });
  if (out.status !== 0) {
    throw new Error(out.stderr || out.stdout || "PDF word bbox 추출 실패");
  }
  return JSON.parse(out.stdout) as { text: string; x: number; y: number; w: number; h: number }[];
}

export type BboxSource = "pdf_word" | "vlm" | "none";

/** 템플릿 1페이지 미리보기용. bboxSource·matchedWord는 추적용(선택). */
export type FieldBox = {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  matchCount: number;
  bboxSource?: BboxSource;
  matchedWord?: string | null;
  /** VLM이 알려준 페이지(1~). pdf_word는 항상 1페이지 */
  page?: number;
};

function normalizeLabelForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[.,;:()[\]{}]/g, "")
    .replace(/[-_–—]/g, "")
    .trim();
}

function readingOrderSort(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  const dy = a.y - b.y;
  if (Math.abs(dy) > 0.02) return dy;
  return a.x - b.x;
}

/**
 * PDF 단어 매칭용 라벨 꼬리.
 * `인적사항_대학교` → `대학교`
 * `1대학교_1.1.1.학교명` → `학교명` (번호 경로 뒤의 셀 라벨만)
 */
function fieldKeyTailForMatch(key: string): string {
  const i = key.indexOf("_");
  if (i < 0) return key;
  const tail = key.slice(i + 1);
  const parts = tail.split(".");
  if (parts.length >= 2 && /^\d+$/.test((parts[0] ?? "").trim())) {
    return (parts[parts.length - 1] ?? tail).trim() || tail;
  }
  return tail;
}

/** 이 길이를 넘는 꼬리는 문장형 필드로 보고, PDF 단어와 **완전 일치**만 허용한다(부분 문자열 오매칭 방지). */
const FIELD_TAIL_LONG_FOR_EXACT_MATCH = 36;

/**
 * PyMuPDF `words`가 "성 명", "전 공"처럼 한 글자씩 쪼개진 경우, 같은 행에서 가로로 이어 붙여
 * normalize 꼬리와 정확히 같아질 때의 인덱스 열을 찾는다.
 */
function findConsecutiveRowMatchIndices(
  indexed: { text: string; x: number; y: number; w: number; h: number; idx: number }[],
  usedWordIndices: Set<number>,
  nk: string
): number[] | null {
  const avail = indexed.filter((w) => !usedWordIndices.has(w.idx));
  if (!avail.length) return null;
  const buckets = new Map<number, typeof avail>();
  for (const w of avail) {
    const yc = w.y + w.h * 0.28;
    const key = Math.round(yc * 420);
    const list = buckets.get(key) ?? [];
    list.push(w);
    buckets.set(key, list);
  }
  const sortedBucketKeys = [...buckets.keys()].sort((a, b) => a - b);
  const MAX_H_GAP = 0.072;
  for (const bk of sortedBucketKeys) {
    const rowWords = buckets.get(bk)!;
    rowWords.sort((a, b) => a.x - b.x);
    const n = rowWords.length;
    for (let i = 0; i < n; i++) {
      let acc = "";
      const chain: number[] = [];
      for (let j = i; j < n && j < i + 16; j++) {
        const w = rowWords[j]!;
        if (chain.length) {
          const prev = rowWords[j - 1]!;
          if (w.x - (prev.x + prev.w) > MAX_H_GAP) break;
        }
        acc += normalizeLabelForMatch(w.text);
        chain.push(w.idx);
        if (acc === nk) return chain;
        if (acc.length > nk.length || !nk.startsWith(acc)) break;
      }
    }
  }
  return null;
}

/** `matchFieldKeysToWordBboxes`와 동일하되, 매칭에 쓰인 단어 인덱스를 함께 반환한다. */
export function matchFieldKeysToWordBboxesWithUsed(
  fields: string[],
  words: { text: string; x: number; y: number; w: number; h: number }[]
): { boxes: FieldBox[]; usedWordIndices: Set<number> } {
  const indexed = words.map((w, idx) => ({ ...w, idx }));
  const usedWordIndices = new Set<number>();
  const out: FieldBox[] = [];

  const clamp = (v: number) => Math.max(0, Math.min(1, v));

  for (const key of fields) {
    const tailRaw = fieldKeyTailForMatch(key);
    const nk = normalizeLabelForMatch(tailRaw);
    if (!nk) continue;

    const longTail = nk.length > FIELD_TAIL_LONG_FOR_EXACT_MATCH;

    if (!longTail) {
      const chain = findConsecutiveRowMatchIndices(indexed, usedWordIndices, nk);
      if (chain?.length) {
        for (const idx of chain) usedWordIndices.add(idx);
        const ws = chain.map((i) => indexed[i]!);
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const w of ws) {
          minX = Math.min(minX, w.x);
          minY = Math.min(minY, w.y);
          maxX = Math.max(maxX, w.x + w.w);
          maxY = Math.max(maxY, w.y + w.h);
        }
        out.push({
          key,
          x: clamp(minX),
          y: clamp(minY),
          w: clamp(maxX - minX),
          h: clamp(maxY - minY),
          matchCount: 1,
          matchedWord: ws.map((z) => z.text).join(""),
        });
        continue;
      }
    }

    const pool = indexed.filter((w) => !usedWordIndices.has(w.idx));
    const candidates = pool.filter((w) => normalizeLabelForMatch(w.text) === nk);
    if (!candidates.length) continue;

    const chosen = [...candidates].sort(readingOrderSort)[0]!;
    usedWordIndices.add(chosen.idx);
    out.push({
      key,
      x: clamp(chosen.x),
      y: clamp(chosen.y),
      w: clamp(chosen.w),
      h: clamp(chosen.h),
      matchCount: 1,
      matchedWord: chosen.text,
    });
  }

  return { boxes: out, usedWordIndices };
}

export function matchFieldKeysToWordBboxes(
  fields: string[],
  words: { text: string; x: number; y: number; w: number; h: number }[]
): FieldBox[] {
  return matchFieldKeysToWordBboxesWithUsed(fields, words).boxes;
}

function isTemplateBboxDebugEnabled(): boolean {
  const v = process.env.DEBUG_TEMPLATE_BBOX?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function remapFieldKeyByWords(key: string, wordNormSet: Set<string>): string {
  const i = key.indexOf("_");
  if (i < 0) return key;
  const sec = key.slice(0, i);
  const cell = key.slice(i + 1);
  const nCell = normalizeLabelForMatch(cell);
  if (
    nCell === normalizeLabelForMatch("대학원") &&
    wordNormSet.has(normalizeLabelForMatch("대학교")) &&
    !wordNormSet.has(normalizeLabelForMatch("대학원"))
  ) {
    return `${sec}_대학교`;
  }
  if (
    nCell === normalizeLabelForMatch("학교명") &&
    wordNormSet.has(normalizeLabelForMatch("대학교")) &&
    !wordNormSet.has(normalizeLabelForMatch("학교명"))
  ) {
    return key.replace(/\.학교명$/u, ".대학교").replace(/_학교명$/u, "_대학교");
  }
  return key;
}

function fieldKeyStrictEnabled(): boolean {
  const v = process.env.VLLM_FIELD_KEY_STRICT?.trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** 표·입력란 옆 짧은 라벨로 보이는지 (범용 정형문서) */
function isLikelyInputFieldLabel(key: string): boolean {
  if (shouldSkipFieldBboxPreview(key)) return false;
  if (isProbableSentenceFieldKey(key)) return false;
  const tail = fieldKeyTailForMatch(key).replace(/\s+/g, "");
  if (!tail || tail.length < 2 || tail.length > 28) return false;
  if (/[,，;；]/.test(tail)) return false;
  if (/등$/.test(tail) && tail.length > 5) return false;
  if (/^\d{3,}/.test(tail)) return false;
  if (/^(본인은|다음을|위와같이|첨부|학업계획|연구계획)/.test(tail)) return false;
  if (/^[A-Za-z0-9][A-Za-z0-9.@+\-]{0,18}$/.test(tail)) return true;
  const hangul = (tail.match(/[\uac00-\ud7a3]/g) || []).length;
  if (hangul >= 2 && hangul >= tail.length * 0.45) return true;
  return false;
}

/** VLM이 반환한 0~1 bbox가 입력란 라벨보다 큰 빈 칸·본문 블록인지 */
function isOversizedTemplateVlmBBox(w: number, h: number): boolean {
  const area = w * h;
  return area > 0.04 || h > 0.1 || w > 0.55;
}

/** 미리보기 bbox를 그리지 않을 필드 키(첨부 안내·서명·귀하 등) */
function shouldSkipFieldBboxPreview(key: string): boolean {
  const tail = fieldKeyTailForMatch(key).replace(/\s+/g, "");
  if (!tail || tail.length < 2) return true;
  if (/^\d+부$/.test(tail)) return true;
  if (/(귀하|서명|지원자|발급분|발급본|별지|서약|추천서|학과장|대학원장|이하생략|필요시)/.test(tail)) return true;
  if (/^(첨부|학업계획|연구계획)$/.test(tail)) return true;
  if (tail.includes("동국대학교") && tail.includes("귀하")) return true;
  return false;
}

/**
 * PDF 단어 보강 시 필드 그룹 키.
 * `인적사항_대학교` → `인적사항`
 * `3성명_1.3.1.성명` → `3성명_1.3.1` (첫 `_`만 쓰면 `3성명`으로 묶여 표 전체가 한 밴드가 되는 버그 방지)
 */
function augmentGroupKeyForField(key: string): string | null {
  const lastUnd = key.lastIndexOf("_");
  if (lastUnd <= 0) return null;
  const rhs = key.slice(lastUnd + 1);
  if (!rhs) return null;
  const segments = rhs.split(".");
  if (segments.length >= 2 && /^\d+$/.test((segments[0] ?? "").trim())) {
    return `${key.slice(0, lastUnd + 1)}${segments.slice(0, -1).join(".")}`;
  }
  return key.slice(0, lastUnd);
}

/** VLM이 빠뜨린 표 라벨을 PDF 단어로 보강할 때 노이즈·절 번호를 걸러낸다. */
function isLikelyAugmentTableLabel(text: string): boolean {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 40) return false;
  if (/^[\d.\s\-–—/]+$/.test(s)) return false;
  if (/^\d+\.$/.test(s)) return false;
  if (/^\d+부$/.test(s)) return false;
  if (/(귀하|서명|지원자|발급|이후|필요시|※|별지|학과장|추천|서약|첨부|본인은)/.test(s)) return false;
  const n = normalizeLabelForMatch(s);
  if (n.length < 2) return false;
  if (["인적사항", "지도교수", "연구계획", "연구계획서", "학업계획"].includes(n)) return false;
  return true;
}

/**
 * VLM 필드 목록이 잘리거나 누락된 경우, 같은 `augmentGroupKey` 안에서 이미 잡힌 bbox 세로 밴드에 있는
 * **아직 매칭에 쓰이지 않은** PDF 단어를 짧은 라벨로 간주해 필드 키를 덧붙인다.
 * `1대학교_1.1.1.학교명`처럼 그룹당 필드가 하나뿐이어도, 그 행의 좁은 밴드로 같은 줄의 과정·학과·전공 등을 보강한다.
 * pdf_word가 없을 때는 해당 키의 VLM bbox로 밴드를 잡는다.
 */
export function augmentTemplateFieldsFromPdfWordLayer(
  pdfAbsPath: string | null | undefined,
  scale: number,
  result: TemplateAnalysisResult
): TemplateAnalysisResult {
  if (!pdfAbsPath || !fs.existsSync(pdfAbsPath)) return result;
  let words: { text: string; x: number; y: number; w: number; h: number }[] = [];
  try {
    words = extractFirstPageWordBboxesNormalized(pdfAbsPath, scale);
  } catch {
    return result;
  }
  if (!words.length) return result;

  const wordNormSet = new Set(words.map((w) => normalizeLabelForMatch(w.text)));
  const baseFields = Array.from(new Set(result.fields.map((k) => remapFieldKeyByWords(k, wordNormSet))));
  const { boxes, usedWordIndices } = matchFieldKeysToWordBboxesWithUsed(baseFields, words);

  const fieldSet = new Set(baseFields);
  const Y_MARGIN = 0.022;
  /** 그룹에 필드가 1개뿐일 때(예: `1대학교_1.1.1.학교명`): 같은 표 행만 보강하도록 밴드를 좁힌다. */
  const Y_MARGIN_SINGLETON = 0.006;
  const MAX_BAND = 0.18;
  const augRows: { key: string; y: number; x: number }[] = [];

  const vlmByKey = new Map((result.fieldBboxes ?? []).map((b) => [b.key, b]));

  const groupKeys = [
    ...new Set(baseFields.map(augmentGroupKeyForField).filter((g): g is string => Boolean(g))),
  ];

  for (const G of groupKeys) {
    const keysForG = baseFields.filter((k) => augmentGroupKeyForField(k) === G);
    if (keysForG.length < 1) continue;

    const matchedBoxes = boxes.filter(
      (b) => augmentGroupKeyForField(b.key) === G && b.matchCount > 0
    );

    let ymin = Infinity;
    let ymax = -Infinity;
    for (const b of matchedBoxes) {
      ymin = Math.min(ymin, b.y);
      ymax = Math.max(ymax, b.y + b.h);
    }
    if (!Number.isFinite(ymin) || !Number.isFinite(ymax)) {
      for (const k of keysForG) {
        const vb = vlmByKey.get(k);
        if (!vb) continue;
        const san = sanitizeTemplateBBoxNorm(vb.x, vb.y, vb.w, vb.h);
        if (!san) continue;
        ymin = Math.min(ymin, san.y);
        ymax = Math.max(ymax, san.y + san.h);
      }
    }
    if (!Number.isFinite(ymin) || !Number.isFinite(ymax)) continue;

    const multiKey = keysForG.length >= 2 || matchedBoxes.length >= 2;
    const yMargin = multiKey ? Y_MARGIN : Y_MARGIN_SINGLETON;
    ymin -= yMargin;
    ymax += yMargin;
    if (!(ymax > ymin) || ymax - ymin > MAX_BAND) continue;

    const tailsNorm = new Set(
      keysForG.map((k) => normalizeLabelForMatch(fieldKeyTailForMatch(k))).filter(Boolean)
    );

    const undG = G.indexOf("_");
    const hasNumericHierarchy = undG >= 0 && G.slice(undG + 1).includes(".");

    for (let wi = 0; wi < words.length; wi++) {
      if (usedWordIndices.has(wi)) continue;
      const w = words[wi]!;
      if (w.y > 0.68) continue;
      if (!isLikelyAugmentTableLabel(w.text)) continue;
      const cy = w.y + w.h / 2;
      if (cy < ymin || cy > ymax) continue;
      const nw = normalizeLabelForMatch(w.text);
      if (!nw || nw.length < 2) continue;

      let overlapsExisting = false;
      for (const t of tailsNorm) {
        if (nw === t || nw.includes(t) || t.includes(nw)) {
          overlapsExisting = true;
          break;
        }
      }
      if (overlapsExisting) continue;

      const cell = w.text.trim().replace(/\s+/g, "");
      const newKey = sanitizeFieldKeyCandidate(
        hasNumericHierarchy ? `${G}.${cell}` : `${G}_${cell}`
      );
      if (!newKey || fieldSet.has(newKey)) continue;

      fieldSet.add(newKey);
      tailsNorm.add(nw);
      usedWordIndices.add(wi);
      augRows.push({ key: newKey, y: w.y, x: w.x });
    }
  }

  if (!augRows.length) return result;

  augRows.sort(readingOrderSort);
  const merged = [...baseFields, ...augRows.map((r) => r.key)];
  const { fields } = normalizeSchemaFieldKeys(merged, "pdfWordAugment");
  return { ...result, fields };
}

/**
 * 템플릿 1페이지 미리보기: PyMuPDF 단어 bbox 우선, 없으면 VLM bbox 폴백.
 * PDF가 여러 페이지이면 VLM 박스는 `page===1`일 때만 사용(나머지는 1페이지 PNG와 좌표계가 다름).
 * `DEBUG_TEMPLATE_BBOX=1` 이면 서버 콘솔에 좌표·출처·샘플 단어를 JSON으로 남긴다.
 */
export function buildTemplateFieldBoxes(
  pdfAbsPath: string,
  scale: number,
  fields: string[],
  vlmBboxes: TemplateFieldBBox[],
  options?: { pdfPageCount?: number }
): FieldBox[] {
  const pdfPageCount = Math.max(1, Math.floor(options?.pdfPageCount ?? 1));
  let words: { text: string; x: number; y: number; w: number; h: number }[] = [];
  try {
    words = extractFirstPageWordBboxesNormalized(pdfAbsPath, scale);
  } catch {
    words = [];
  }
  const wordNormSet = new Set(words.map((w) => normalizeLabelForMatch(w.text)));
  const normalizedFields = Array.from(new Set(fields.map((k) => remapFieldKeyByWords(k, wordNormSet))));
  const normalizedVlmBboxes = vlmBboxes.map((b) => ({ ...b, key: remapFieldKeyByWords(b.key, wordNormSet) }));
  const vlmByKey = new Map(normalizedVlmBboxes.map((b) => [b.key, b]));
  const matched = matchFieldKeysToWordBboxes(normalizedFields, words);
  const matchedByKey = new Map(matched.map((m) => [m.key, m]));

  const fieldBoxes: FieldBox[] = normalizedFields.map((key) => {
    if (shouldSkipFieldBboxPreview(key)) {
      return {
        key,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        matchCount: 0,
        bboxSource: "none" as const,
        matchedWord: null,
      };
    }
    const m = matchedByKey.get(key);
    if (m && m.matchCount > 0) {
      // 매칭이 되더라도 점/숫자 조각처럼 너무 작은 bbox는 입력칸이 아닐 가능성이 커서
      // VLM/none으로 폴백한다.
      const mw = (m.matchedWord ?? "").trim();
      const area = m.w * m.h;
      const tooSmallPdfWord = area < 0.0002 && mw.length <= 3;
      const san = sanitizeTemplateBBoxNorm(m.x, m.y, m.w, m.h);
      const geom = san ?? { x: m.x, y: m.y, w: m.w, h: m.h };
      if (!tooSmallPdfWord) {
        return {
          ...m,
          ...geom,
          bboxSource: "pdf_word" as const,
          page: 1,
        };
      }
    }
    const v = vlmByKey.get(key);
    if (v) {
      if (pdfPageCount > 1 && v.page !== 1) {
        return {
          key,
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          matchCount: 0,
          bboxSource: "none" as const,
          matchedWord: null,
          page: v.page,
        };
      }
      const san = sanitizeTemplateBBoxNorm(v.x, v.y, v.w, v.h);
      if (!san || isOversizedTemplateVlmBBox(san.w, san.h)) {
        return {
          key,
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          matchCount: 0,
          bboxSource: "none" as const,
          matchedWord: null,
          page: v.page ?? 1,
        };
      }
      return {
        key,
        ...san,
        matchCount: 0,
        bboxSource: "vlm" as const,
        matchedWord: null,
        page: v.page ?? 1,
      };
    }
    return {
      key,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      matchCount: 0,
      bboxSource: "none" as const,
      matchedWord: null,
    };
  });

  if (isTemplateBboxDebugEnabled()) {
    const bySource = { pdf_word: 0, vlm: 0, none: 0 } as Record<BboxSource, number>;
    for (const b of fieldBoxes) {
      const s = b.bboxSource ?? "none";
      bySource[s]++;
    }
    const payload = {
      tag: "template-bbox-debug",
      pdf: path.basename(pdfAbsPath),
      scale,
      coordinateSpace:
        "0~1 정규화: x,y,w,h 는 미리보기 PNG(1페이지, scale 적용) 픽셀 너비·높이 기준 비율. 다중 페이지 PDF면 VLM page≠1 박스는 미리보기에서 제외.",
      pdfPageCount,
      fieldCount: normalizedFields.length,
      bboxSourceCounts: bySource,
      vlmBboxInput: normalizedVlmBboxes.map((b) => ({
        key: b.key,
        page: b.page ?? 1,
        x: round4(b.x),
        y: round4(b.y),
        w: round4(b.w),
        h: round4(b.h),
      })),
      page1WordSample: words.slice(0, 20).map((w) => ({
        text: w.text,
        x: round4(w.x),
        y: round4(w.y),
        w: round4(w.w),
        h: round4(w.h),
      })),
      page1WordCount: words.length,
      finalBoxes: fieldBoxes.map((b) => ({
        key: b.key,
        bboxSource: b.bboxSource,
        x: round4(b.x),
        y: round4(b.y),
        w: round4(b.w),
        h: round4(b.h),
        matchCount: b.matchCount,
        matchedWord: b.matchedWord ?? null,
        page: b.page,
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
  }

  return fieldBoxes;
}

export type VllmPdfRenderOptions = {
  scale: number;
  maxPages: number;
  /** 렌더 결과 픽셀에서 긴 변 상한(0이면 비활성). 컨텍스트 한도 대응용 */
  maxLongEdgePx: number;
  /** vLLM 요청용 페이지 이미지: jpeg 권장(용량↓) */
  imageFormat: "png" | "jpeg";
  jpegQuality: number;
};

/**
 * vLLM에 넣을 PDF 페이지 렌더 옵션(토큰/컨텍스트 한도 대응).
 * 기본: scale 1.5, maxPages 2, maxLongEdgePx 960, jpeg q=78
 */
export function getVllmPdfRenderOptions(): VllmPdfRenderOptions {
  const scaleRaw = process.env.VLLM_RENDER_SCALE;
  const pagesRaw = process.env.VLLM_MAX_PDF_PAGES;
  const edgeRaw = process.env.VLLM_PAGE_MAX_LONG_EDGE_PX;
  const fmtRaw = process.env.VLLM_PAGE_IMAGE_FORMAT?.trim().toLowerCase();
  const qRaw = process.env.VLLM_JPEG_QUALITY;

  let scale = scaleRaw == null || scaleRaw === "" ? 1.5 : Number(scaleRaw);
  let maxPages = pagesRaw == null || pagesRaw === "" ? 2 : Number(pagesRaw);
  let maxLongEdgePx = edgeRaw == null || edgeRaw === "" ? 960 : Number(edgeRaw);
  let jpegQuality = qRaw == null || qRaw === "" ? 78 : Number(qRaw);

  if (!Number.isFinite(scale) || scale < 0.4) scale = 1.5;
  if (scale > 4) scale = 4;
  if (!Number.isFinite(maxPages) || maxPages < 1) maxPages = 2;
  maxPages = Math.min(50, Math.floor(maxPages));
  if (!Number.isFinite(maxLongEdgePx) || maxLongEdgePx < 0) maxLongEdgePx = 960;
  if (maxLongEdgePx > 4096) maxLongEdgePx = 4096;
  if (!Number.isFinite(jpegQuality) || jpegQuality < 40) jpegQuality = 78;
  if (jpegQuality > 95) jpegQuality = 95;

  const imageFormat = fmtRaw === "png" ? "png" : "jpeg";

  return { scale, maxPages, maxLongEdgePx, imageFormat, jpegQuality };
}

/** `VLLM_MAX_OUTPUT_TOKENS` 환경 변수 상한(과도한 값 방지). */
const VLLM_MAX_OUTPUT_TOKENS_CAP = 32_768;

/**
 * vLLM `/v1/chat/completions`의 `max_tokens`.
 * 입력(시스템·스키마·PDF 텍스트 힌트·이미지)과 합산되어 모델 컨텍스트 한도를 넘으면 400이 난다.
 * 기본 8192(복잡한 layout_hierarchy JSON용). 컨텍스트가 작은 모델(예: 10k)이면 `VLLM_MAX_OUTPUT_TOKENS=4096` 등으로 낮춘다.
 */
export function getVllmMaxOutputTokens(): number {
  const raw = process.env.VLLM_MAX_OUTPUT_TOKENS?.trim();
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  const v = Number.isFinite(n) && n >= 64 ? Math.floor(n) : 8192;
  return Math.min(Math.max(64, v), VLLM_MAX_OUTPUT_TOKENS_CAP);
}

/** Cloudflare quick tunnel 등 프록시 뒤 vLLM URL 여부 */
export function isVllmTunnelBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host.endsWith(".trycloudflare.com") || host.includes("ngrok");
  } catch {
    return false;
  }
}

/** 템플릿 분석 VLM용 PDF 렌더 스케일(기본: VLLM_RENDER_SCALE, 상한 3). */
export function getVllmTemplateRenderScale(): number {
  const raw = process.env.VLLM_TEMPLATE_RENDER_SCALE?.trim();
  if (raw !== undefined && raw !== "") {
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0.4) return Math.min(v, 4);
  }
  const base = Math.min(Math.max(getVllmPdfRenderOptions().scale, 1.2), 3);
  const vllmBase = (process.env.VLLM_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");
  if (isVllmTunnelBaseUrl(vllmBase)) return Math.min(base, 1.35);
  return base;
}

/** 템플릿 분석 전용 PDF→이미지 옵션(터널 시 페이지·해상도·JPEG 자동 축소). */
export function getVllmTemplatePdfRenderOptions(): VllmPdfRenderOptions {
  const base = getVllmPdfRenderOptions();
  const scale = getVllmTemplateRenderScale();
  const vllmBase = (process.env.VLLM_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");
  if (!isVllmTunnelBaseUrl(vllmBase)) {
    return { ...base, scale };
  }
  return {
    scale,
    maxPages: Math.min(base.maxPages, 1),
    maxLongEdgePx: Math.min(base.maxLongEdgePx > 0 ? base.maxLongEdgePx : 960, 720),
    imageFormat: "jpeg",
    jpegQuality: Math.min(base.jpegQuality, 70),
  };
}

function getVllmTemplateMaxOutputTokens(baseUrl: string): number {
  const cap = getVllmMaxOutputTokens();
  if (!isVllmTunnelBaseUrl(baseUrl)) return cap;
  return Math.min(cap, 3072);
}

function shouldSkipTemplateCoarseRetry(baseUrl: string): boolean {
  const flag = process.env.VLLM_SKIP_COARSE_RETRY?.trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  return isVllmTunnelBaseUrl(baseUrl);
}

/** 1단계 섹션 구조 → 2단계 leaf (기본 off, VLLM_TEMPLATE_TWO_STAGE=1 일 때만) */
function shouldUseTemplateTwoStage(_baseUrl: string): boolean {
  const flag = process.env.VLLM_TEMPLATE_TWO_STAGE?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
}

/** 템플릿 분석: text_first(PDF텍스트+LLM) | vision(이미지) | auto */
export type TemplateAnalysisMode = "text_first" | "vision" | "auto";

export function getTemplateAnalysisMode(): TemplateAnalysisMode {
  const raw = process.env.VLLM_TEMPLATE_MODE?.trim().toLowerCase();
  if (raw === "vision" || raw === "vlm" || raw === "image") return "vision";
  if (raw === "auto") return "auto";
  return "text_first";
}

/** text_first·auto(텍스트 경로) 성공 후 PDF 단어 레이어로 필드 추가. 기본 off, vision은 on. */
export function pdfWordAugmentEnabled(opts?: { fromTextFirst?: boolean }): boolean {
  const v = process.env.PDF_WORD_AUGMENT?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  if (opts?.fromTextFirst) return false;
  return getTemplateAnalysisMode() !== "text_first";
}

/** 문서 제목·양식명이 필드로 잘못 들어온 `섹션_*` 조각 */
function isTitleOrHeaderNoiseField(key: string): boolean {
  const k = key.replace(/\s+/g, "");
  const tail = fieldKeyTailForMatch(key).replace(/\s+/g, "");
  if (/^섹션_지원구분(_\d+)?$/.test(k)) return true;
  if (/^섹션_(학|석|박)/.test(k) && /(연계|통합|지원서|과정|프로그램)/.test(k)) return true;
  if (tail.length > 12 && /(연계과정|통합연계|지원서|양식\d)/.test(tail)) return true;
  if (/^(학|석|박).*(연계|통합).*(지원서|과정)/.test(tail) && tail.length > 10) return true;
  return false;
}

function getVllmFetchTimeoutMs(baseUrl: string): number {
  const raw = process.env.VLLM_FETCH_TIMEOUT_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n >= 30_000) return Math.min(Math.floor(n), 900_000);
  return isVllmTunnelBaseUrl(baseUrl) ? 120_000 : 600_000;
}

function formatVllmHttpError(status: number, txt: string, baseUrl: string): Error {
  const isHtml = /^\s*<!DOCTYPE/i.test(txt) || /<html/i.test(txt);
  if (status === 524 || (isHtml && status >= 500)) {
    const tunnel = isVllmTunnelBaseUrl(baseUrl);
    const hint =
      "응답 대기 중 프록시(Cloudflare Tunnel 등)가 연결을 끊었습니다. " +
      "VLLM_MAX_PDF_PAGES=1, VLLM_TEMPLATE_RENDER_SCALE=2, VLLM_SKIP_COARSE_RETRY=1 로 부하를 줄이거나, " +
      "타임아웃이 긴 전용 터널/직접 연결을 사용하세요.";
    return new Error(`vLLM 호출 실패 (${status}): ${tunnel || isHtml ? hint : txt.slice(0, 200)}`);
  }
  return new Error(`vLLM 호출 실패 (${status}): ${txt.slice(0, 300)}`);
}

type VllmChatCompletionJson = {
  choices?: { message?: { content?: unknown }; finish_reason?: string }[];
};

async function vllmChatCompletions(baseUrl: string, body: object): Promise<VllmChatCompletionJson> {
  const timeoutMs = getVllmFetchTimeoutMs(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw formatVllmHttpError(res.status, txt, baseUrl);
    }
    return (await res.json()) as VllmChatCompletionJson;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      const tunnel = isVllmTunnelBaseUrl(baseUrl);
      throw new Error(
        tunnel
          ? `vLLM 호출 시간 초과 (약 ${Math.round(timeoutMs / 1000)}초). trycloudflare 터널은 응답 대기가 약 100초로 제한됩니다. Railway에 VLLM_MAX_PDF_PAGES=1, VLLM_TEMPLATE_RENDER_SCALE=1.2, PDF_TEXT_HINTS=0 을 설정한 뒤 재시도하세요.`
          : `vLLM 호출 시간 초과 (${Math.round(timeoutMs / 1000)}초). VLLM_MAX_PDF_PAGES·렌더 스케일을 낮추거나 VLLM_FETCH_TIMEOUT_MS를 늘리세요.`
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export type RenderAllPagesExtra = Pick<VllmPdfRenderOptions, "maxLongEdgePx" | "imageFormat" | "jpegQuality">;

/** PDF를 data URI 배열로 렌더. maxPages·긴 변 상한·JPEG로 vLLM 입력을 줄인다. */
export function renderAllPagesToDataUris(
  pdfAbsPath: string,
  scale = 2,
  maxPages?: number,
  extra?: RenderAllPagesExtra
): string[] {
  const pageLimit = maxPages == null || maxPages <= 0 ? 9999 : Math.min(9999, Math.floor(maxPages));
  const maxEdge = extra?.maxLongEdgePx ?? 0;
  const imgFmt = extra?.imageFormat ?? "png";
  const jpegQ = extra?.jpegQuality ?? 82;
  const tmpRoot = path.join(os.tmpdir(), `reanalysis-pages-${randomUUID()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  try {
    const outJson = path.join(tmpRoot, "pages.json");
    const script = [
      "import fitz,sys,os,json",
      "doc = fitz.open(sys.argv[1])",
      "out_dir = sys.argv[2]",
      "max_p = int(sys.argv[4])",
      "scale = float(sys.argv[5])",
      "max_edge = int(sys.argv[6])",
      "fmt = sys.argv[7].lower()",
      "jpg_q = int(sys.argv[8])",
      "paths = []",
      "for i, p in enumerate(doc):",
      "    if i >= max_p:",
      "        break",
      "    r = p.rect",
      "    z = float(scale)",
      "    if max_edge > 0:",
      "        wpx = r.width * z",
      "        hpx = r.height * z",
      "        m = max(wpx, hpx)",
      "        if m > max_edge:",
      "            z = z * (max_edge / m)",
      "    mat = fitz.Matrix(z, z)",
      "    pix = p.get_pixmap(matrix=mat, alpha=False)",
      "    if fmt == 'jpeg':",
      "        fp = os.path.join(out_dir, f'page_{i+1:03d}.jpg')",
      "        pix.save(fp, output='jpg', jpg_quality=jpg_q)",
      "    else:",
      "        fp = os.path.join(out_dir, f'page_{i+1:03d}.png')",
      "        pix.save(fp)",
      "    paths.append(fp)",
      "with open(sys.argv[3], 'w', encoding='utf-8') as f:",
      "    f.write(json.dumps(paths, ensure_ascii=False))",
    ].join("\n");
    const out = spawnSync(pythonCmd(), [
      "-c",
      script,
      pdfAbsPath,
      tmpRoot,
      outJson,
      String(pageLimit),
      String(scale),
      String(maxEdge),
      imgFmt,
      String(jpegQ),
    ], {
      encoding: "utf8",
      timeout: 120_000,
    });
    if (out.status !== 0) {
      throw new Error(out.stderr || out.stdout || "PDF 페이지 렌더링 실패");
    }
    const pagePaths = JSON.parse(fs.readFileSync(outJson, "utf8")) as string[];
    return pagePaths.map((fp) => {
      const mime = fp.toLowerCase().endsWith(".jpg") || fp.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png";
      return `data:${mime};base64,${fs.readFileSync(fp).toString("base64")}`;
    });
  } finally {
    try {
      if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // noop
    }
  }
}

/** 첫 `{`부터 괄호 균형으로 잘라낸 JSON 오브젝트 문자열 (VL이 앞뒤에 설명을 붙일 때) */
function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** vLLM/OpenAI 호환: assistant message.content가 문자열이 아닌 멀티모달 파트 배열일 수 있음 */
export function chatCompletionContentToString(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") parts.push(p.text);
      }
    }
    return parts.join("");
  }
  return String(content);
}

function stripVlNoise(s: string): string {
  let t = s.trim();
  t = t.replace(/`\s*`<redacted_thinking>[\s\S]*?`<\/redacted_thinking>/gi, "");
  t = t.replace(/<redacted_thinking>[\s\S]*?<\/redacted_thinking>/gi, "");
  return t.trim();
}

/** JSON.parse 직후: 단일 요소 배열 `[{...}]` 또는 문자열만 있는 배열을 오브젝트로 맞춤 */
function normalizeParsedJsonRoot(parsed: unknown): Record<string, unknown> | null {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  if (Array.isArray(parsed)) {
    if (
      parsed.length === 1 &&
      parsed[0] &&
      typeof parsed[0] === "object" &&
      !Array.isArray(parsed[0])
    ) {
      return parsed[0] as Record<string, unknown>;
    }
    if (parsed.length > 0 && parsed.every((x) => typeof x === "string")) {
      return { fields: parsed };
    }
  }
  return null;
}

/** 템플릿 분석 JSON에서 필드 목록 후보 추출(fields가 객체/다른 키명인 경우 포함) */
function extractRawFieldsArrayFromParsed(parsed: Record<string, unknown>): unknown[] {
  const keys = ["fields", "field_list", "fieldList", "labels", "keys", "field_names", "fieldNames"];
  for (const k of keys) {
    const v = parsed[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>);
    }
  }
  return [];
}

function slugHierarchySectionLabel(s: string): string {
  return s
    .trim()
    .replace(/^\d+\.?\s*/, "")
    .replace(/\s+/g, "")
    .replace(/[()[\].]/g, "");
}

function isNumberedMajorSectionLabel(s: string): boolean {
  const t = s.trim();
  return /^\d+\s*\.?\s*\S+/.test(t);
}

function shouldPromoteContainerLabel(sectionLabel: string, label: string): boolean {
  const raw = label.trim();
  if (!raw) return false;
  if (isNumberedMajorSectionLabel(raw)) return false;
  const t = raw.replace(/\s+/g, "");
  if (!t) return false;
  if (t.length > 18) return false;
  const sectionSlug = slugHierarchySectionLabel(sectionLabel);
  const labelSlug = slugHierarchySectionLabel(raw);
  if (sectionSlug && sectionSlug === labelSlug) return false;
  if (t === "문서" || t === "표" || t === "항목") return false;
  return true;
}

/**
 * layout_hierarchy bbox: 표준 [xmin, ymin, xmax, ymax] (이미지 좌상단 기준, 스케일 0~1000 또는 0~1).
 * Qwen/vLLM 일부 응답은 [ymin, xmin, ymax, xmax] 순으로 나오기도 해, 첫 해석이 퇴화 박스면 둘째 순서를 시도한다.
 */
function cornersToNormWh(
  xminRaw: number,
  yminRaw: number,
  xmaxRaw: number,
  ymaxRaw: number,
  scale: number
): { x: number; y: number; w: number; h: number } | null {
  const xmin = xminRaw / scale;
  const ymin = yminRaw / scale;
  const xmax = xmaxRaw / scale;
  const ymax = ymaxRaw / scale;
  const x = Math.max(0, Math.min(1, xmin));
  const y = Math.max(0, Math.min(1, ymin));
  const w = Math.max(0, Math.min(1, xmax - xmin));
  const h = Math.max(0, Math.min(1, ymax - ymin));
  if (w < 1e-5 || h < 1e-5) return null;
  return { x, y, w, h };
}

function isTemplateBboxYminFirstCorners(): boolean {
  const v = process.env.TEMPLATE_BBOX_TRY_YMIN_FIRST?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function bboxXminYminXmaxYmaxToNorm(arr: unknown): { x: number; y: number; w: number; h: number } | null {
  if (!Array.isArray(arr) || arr.length < 4) return null;
  const n = arr.slice(0, 4).map((v) => (typeof v === "number" ? v : Number(v)));
  if (!n.every((x) => Number.isFinite(x))) return null;
  const scale = n.every((x) => x >= 0 && x <= 1.001) ? 1 : 1000;
  const [a, b, c, d] = n as [number, number, number, number];
  const asXy = () => cornersToNormWh(a, b, c, d, scale);
  const asYx = () => cornersToNormWh(b, a, d, c, scale);
  if (isTemplateBboxYminFirstCorners()) {
    const yx = asYx();
    if (yx) return yx;
    return asXy();
  }
  const xy = asXy();
  if (xy) return xy;
  return asYx();
}

function readFiniteNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const x = Number(v);
    if (Number.isFinite(x)) return x;
  }
  return undefined;
}

/** fieldBboxes 항목: x,y,w,h 외 bbox 배열·xmin/ymin/xmax/ymax 키(Qwen 코너 형식) 수용 */
function templateBBoxFromFlatObject(obj: Record<string, unknown>): { x: number; y: number; w: number; h: number } | null {
  const arr = obj.bbox ?? obj.box;
  if (Array.isArray(arr)) {
    const raw = bboxXminYminXmaxYmaxToNorm(arr);
    return raw ? sanitizeTemplateBBoxNorm(raw.x, raw.y, raw.w, raw.h) : null;
  }
  const xmin = readFiniteNumber(obj.xmin ?? obj.x_min ?? obj.left);
  const ymin = readFiniteNumber(obj.ymin ?? obj.y_min ?? obj.top);
  const xmax = readFiniteNumber(obj.xmax ?? obj.x_max ?? obj.right);
  const ymax = readFiniteNumber(obj.ymax ?? obj.y_max ?? obj.bottom);
  if (
    xmin !== undefined &&
    ymin !== undefined &&
    xmax !== undefined &&
    ymax !== undefined
  ) {
    const raw = bboxXminYminXmaxYmaxToNorm([xmin, ymin, xmax, ymax]);
    return raw ? sanitizeTemplateBBoxNorm(raw.x, raw.y, raw.w, raw.h) : null;
  }
  const x = readFiniteNumber(obj.x);
  const y = readFiniteNumber(obj.y);
  const w = readFiniteNumber(obj.w ?? obj.width);
  const h = readFiniteNumber(obj.h ?? obj.height);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  return sanitizeTemplateBBoxNorm(x, y, w, h);
}

/**
 * 미리보기용 0~1 bbox 보정: 모델이 0~1000을 한 번 더 안 나눈 값, 범위 초과 등 흔한 오류 완화.
 */
export function sanitizeTemplateBBoxNorm(
  x: number,
  y: number,
  w: number,
  h: number
): { x: number; y: number; w: number; h: number } | null {
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  let X = x;
  let Y = y;
  let W = w;
  let H = h;
  const peak = Math.max(X, Y, W, H);
  if (peak > 1.02 && peak <= 2000) {
    X /= 1000;
    Y /= 1000;
    W /= 1000;
    H /= 1000;
  }
  X = Math.max(0, Math.min(1, X));
  Y = Math.max(0, Math.min(1, Y));
  W = Math.min(1 - X, Math.max(0, W));
  H = Math.min(1 - Y, Math.max(0, H));
  if (W < 1e-5 || H < 1e-5) return null;
  return { x: X, y: Y, w: W, h: H };
}

function parseNodePageOptional(node: Record<string, unknown>): number | undefined {
  const p = node.page ?? node.page_index ?? node.pageIndex;
  if (p == null || p === "") return undefined;
  const n = Math.floor(Number(p));
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

/**
 * 사용자 정의 계층 스키마(layout_hierarchy) → 내부 템플릿 분석 형식(fields + fieldBboxes 0~1).
 * leaf는 children이 없는 노드로 보고, 필드 키는 `섹션슬러그_셀라벨`(content 우선, 없으면 label).
 */
function templateResultFromLayoutHierarchy(parsed: Record<string, unknown>): TemplateAnalysisResult | null {
  const raw = parsed.layout_hierarchy ?? parsed.layoutHierarchy;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const fields: string[] = [];
  const fieldBboxes: TemplateFieldBBox[] = [];
  const seenKeys = new Map<string, number>();

  function makeFieldKey(section: string, cellLabel: string): string {
    const sec = slugHierarchySectionLabel(section) || "섹션";
    const cell = cellLabel.trim().replace(/\s+/g, "");
    if (!cell) return "";
    const base = `${sec}_${cell}`;
    const n = (seenKeys.get(base) ?? 0) + 1;
    seenKeys.set(base, n);
    return n > 1 ? `${base}_${n}` : base;
  }

  function pushField(section: string, cellLabel: string, bbox: unknown, node: Record<string, unknown>): void {
    const cell = stripFieldKeyNoise(cellLabel.trim());
    if (!cell) return;
    const key = makeFieldKey(section, cell.replace(/\s+/g, ""));
    if (!key) return;
    const sk = sanitizeFieldKeyCandidate(key);
    if (!sk) return;
    if (fieldKeyStrictEnabled() && !isLikelyInputFieldLabel(sk)) return;
    fields.push(sk);
    const raw = bboxXminYminXmaxYmaxToNorm(bbox);
    const bb = raw ? sanitizeTemplateBBoxNorm(raw.x, raw.y, raw.w, raw.h) : null;
    const pg = parseNodePageOptional(node);
    if (bb && !isOversizedTemplateVlmBBox(bb.w, bb.h)) {
      fieldBboxes.push({ key: sk, ...bb, ...(pg !== undefined ? { page: pg } : {}) });
    }
  }

  function walk(nodes: unknown[], sectionLabel: string, depth: number): void {
    if (depth > 24) return;
    for (const item of nodes) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const node = item as Record<string, unknown>;
      const label = String(node.label ?? "").trim();
      const content = String(node.content ?? "").trim();
      const kids = node.children;
      const hasKids = Array.isArray(kids) && kids.length > 0;

      if (hasKids) {
        const keepParentMajor = isNumberedMajorSectionLabel(sectionLabel) && !isNumberedMajorSectionLabel(label);
        if (keepParentMajor && shouldPromoteContainerLabel(sectionLabel, label)) {
          // 대분류 아래 표 헤더(container) 라벨도 필드 후보로 승격한다.
          // 예: "1. 인적사항" 아래 "대학교"가 children을 가진 노드로 나오는 케이스.
          pushField(sectionLabel, label, node.bbox, node);
        }
        const sec = keepParentMajor ? sectionLabel : label || sectionLabel || "문서";
        walk(kids as unknown[], sec, depth + 1);
        continue;
      }

      const cellPart = content || label;
      if (!cellPart) continue;
      pushField(sectionLabel, cellPart, node.bbox, node);
    }
  }

  walk(raw, "", 0);
  if (!fields.length) return null;

  const docTypeGuess = String(parsed.document_type ?? "").trim();
  const summary =
    docTypeGuess || String(parsed.summary ?? "").trim() || "계층 레이아웃 추출";

  return { fields, summary, fieldBboxes };
}

const TEMPLATE_LEAF_DEFINITION = [
  "# leaf(입력 항목) 정의 — 반드시 준수",
  "- **leaf**: 사용자가 값을 적거나 선택하는 칸 **바로 옆·위**에 인쇄된 **짧은 항목명**(2~12자 내외)만.",
  "- **leaf 금지**: 빈 사각형 전체, 학업계획·연구계획 본문 칸, 첨부 목록 문장, 날짜·서명란, 「○○ 귀하」, 법적 고지·확인 문장 전체.",
  "- 표에서는 **열 헤더·행 라벨**(성명, 학번, E-mail, 지원학과)만 leaf. 셀 안 안내 문구·'1부'·'발급본'은 leaf 아님.",
].join("\n");

const TEMPLATE_FEW_SHOT_EXAMPLES = [
  "# 올바른/잘못된 예 (한국어 지원·신청서)",
  "- 좋음: content=\"성명\", label=\"인적사항\", children 아래 leaf, bbox는 '성명' 글자만 타이트.",
  "- 좋음: content=\"지원학과\", content=\"학번\" — 서로 다른 leaf.",
  "- 나쁨: content=\"해당시에만 기재\", content=\"※ 필요시 별지 사용\" — 안내 문구.",
  "- 나쁨: bbox가 학업계획 빈 칸 전체나 첨부 블록 전체를 덮음.",
  "- 나쁨: 섹션 제목만 leaf로 두고 표 안 라벨(생년월일, 전공) 누락.",
].join("\n");

const TEMPLATE_BBOX_PIPELINE_NOTE = [
  "# bbox (좌표) 규칙",
  "- 최종 위치는 서버가 PDF 텍스트 레이어로 보정한다. 그래도 **라벨 글자**에 맞는 작은 bbox를 주는 것이 좋다.",
  "- 빈 입력 칸·본문 영역 전체를 bbox로 넣지 마라.",
].join("\n");

/** 1단계: 섹션·표 블록만 (leaf 없음) */
const TEMPLATE_SECTIONS_PHASE_SCHEMA = [
  "# 1단계 과제",
  "이미지에서 **섹션·표 블록 제목만** 추출한다. 입력 항목(leaf) 라벨은 이 단계에서 넣지 않는다.",
  "",
  "# 1단계 출력 (JSON만)",
  "- document_type: 문자열",
  "- sections: 배열. 각 원소 객체:",
  "  - title: 문자열 (예: '1. 인적사항', '지원구분', '첨부')",
  "  - page: 정수 (첫 이미지=1)",
  "  - kind: 문자열 — table | form_block | text_block | attachment 중 하나",
  "layout_hierarchy는 이 단계에서 **비우거나 생략**한다.",
].join("\n");

/** 템플릿 분석 1차·재시도 공통: 계층 JSON 스키마 안내 (내부에서 layout_hierarchy → fields 변환) */
const TEMPLATE_LAYOUT_HIERARCHY_SCHEMA = [
  "# 역할",
  "너는 복잡한 정형 문서의 레이아웃을 분석하고, 시각적 정보와 텍스트 정보를 결합하여 데이터 스키마를 설계하는 전문가다.",
  "문서가 한국어이면 보이는 글자를 한국어 그대로 옮기고, 번역하지 않는다.",
  "",
  TEMPLATE_LEAF_DEFINITION,
  "",
  TEMPLATE_FEW_SHOT_EXAMPLES,
  "",
  TEMPLATE_BBOX_PIPELINE_NOTE,
  "",
  "# 과제",
  "제공된 이미지에서 문서 구조를 분석하여, 요소 간 계층 관계가 담긴 JSON 스키마를 추출한다.",
  "",
  "# 출력 형식 (JSON)",
  "아래 키 이름은 영문 그대로 쓴다. 반드시 이 키들만 갖는 JSON 객체 하나만 출력한다.",
  "- document_type: 문자열 (문서 종류, 한국어로 적어도 된다)",
  "- layout_hierarchy: 배열. 각 원소는 다음 필드를 가진 객체:",
  "  - element_id: 숫자",
  "  - label: 문자열 (섹션 제목 또는 셀·항목 제목)",
  "  - bbox: 숫자 배열 네 개 [xmin, ymin, xmax, ymax]. 값은 0 이상 1000 이하로 정규화. 좌표는 이미지 픽셀 기준(0~1000)이다. [ymin,xmin,ymax,xmax] 순서 절대 금지.",
  "    **중요 (박스 범위 규칙)**: 빈 입력 칸(Blank Box) 전체를 잡지 말고, 오직 '텍스트 글자 자체(Label Text)'만 아주 정밀하고 타이트하게(Tight) 감싸는 최소한의 사각형 좌표를 제공하라. 여백(Padding/Margin)을 남기지 마라.",
  "  - page: 정수 (필수에 가깝게). bbox가 어느 이미지(페이지) 기준인지. 첫 번째로 제공된 이미지=1, 두 번째=2, …",
  "  - content: 문자열 (해당 요소에 보이는 텍스트; 입력 칸 옆 라벨이면 그 라벨 문구)",
  "  - value: 문자열 (빈 서식이면 빈 문자열 \"\" 가능)",
  "  - children: 같은 형태의 객체 배열 (없으면 생략하거나 [])",
  "JSON 안에 // 주석, 설명 문장, 마크다운 코드 펜스를 넣지 않는다.",
  "",
  "# 지시사항",
  "1. 문서의 논리적 흐름에 따라 위→아래, 왼쪽→오른쪽 순서로 분석한다.",
  "2. 표가 있으면 행·열 관계를 유지하도록 섹션 아래 children으로 중첩한다.",
  "3. 테두리, 배경색, 글자 크기 차이 등으로 시각적으로 구분된 구역을 섹션으로 나눈다.",
  "4. 빈 서식의 입력란 옆 라벨(예: 성명, 학번)은 leaf 노드로 넣고, content에 라벨 문자열을 넣는다. value는 비워도 된다.",
  "5. 같은 글자의 라벨이 다른 섹션에 있으면 서로 다른 상위 label 아래에 두어 구분한다.",
  "6. 이미지가 여러 장이면 leaf마다 bbox의 page를 반드시 맞게 넣는다. 한 장뿐이면 page는 1.",
].join("\n");

/** 템플릿 분석 시 fields로 이어질 키의 품질(범용 정형문서) */
const TEMPLATE_FIELD_KEY_GUIDANCE = [
  "",
  "# 필드 키 품질 및 노이즈 제거 규칙 (엄격)",
  "- **입력 항목(Key)만 추출**: 사용자가 실제로 값을 기입하거나 체크해야 하는 유효한 '입력란의 핵심 제목'만 추출한다. 기입 공간이 없는 단순 텍스트는 제외한다.",
  "- **안내/지시 문구 추출 절대 금지**: '※ 필요시 사용 가능', '해당시에만 기재', '지원자가 작성 필요시만', '이하 생략' 등 지시사항이나 조건부 안내글은 절대 `label`이나 `content`로 추출하지 마라.",
  "- **부연 설명 및 괄호 제거**: 항목명 뒤나 밑에 붙은 자잘한 부연 설명용 괄호 문구(예: '(양식 1~3)', '(해당시에만)', '(새내기)')는 과감히 버리고 핵심 명사형 키만 남겨라. (예: '지원구분(해당시에만 기재)' -> '지원구분')",
  "- **텍스트 정제**: 오타나 깨진 글자(예: '시원이가', '교교시별시지용')처럼 보인다면 문맥상 올바른 단어로 교정하거나, 식별이 불가능하다면 스키마에서 제외하라.",
  "- layout_hierarchy의 라벨·content는 **짧은 입력 항목 식별자**로만 쓴다. 한 필드 키는 가급적 40자 이내, **절대 80자 초과 금지**.",
  "- 인쇄된 **법적 고지·주의문·확인사항 본문 전체**를 키로 넣지 않는다. 체크리스트가 길면 상위 섹션만 짧게 잡고, 세부 줄은 children으로 나눈다.",
  "- `...인 경우`, `...을 따름`, `...불가/가능`, `신청인 : ...` 같이 문장형·확인형 표현은 필드 키 금지. 이런 줄은 children 설명으로만 둔다.",
  "- 확인 체크 구역은 짧은 키만 허용한다. 예: `섹션_확인사항_01`, `섹션_확인사항_여부`",
  "- \"다음을 확인\", \"※\", \"주의\", \"본인은\", \"확인 후\" 등으로 시작하는 **장문**은 필드 키 후보에서 제외한다.",
  "- 표에서 **짧은 열 헤더·항목 라벨**(예: 성명, 학번, E-mail)을 우선한다. 빈 입력칸이면 value는 \"\"로 둔다.",
].join("\n");

function buildTemplateDocTypeHint(docType: string): string {
  const dt = docType.trim();
  if (!dt) return "";
  return [
    "",
    "# 문서 맥락 (시스템)",
    `이 양식의 종류/코드: ${dt}`,
    "대학·기관의 지원서·신청서·계획서·확인서 등 정형 PDF일 가능성이 높다. 표·입력란 중심으로 leaf를 찾는다.",
  ].join("\n");
}

function buildTemplateSectionsBlock(sections: string[]): string {
  if (!sections.length) return "";
  return [
    "",
    "# 확정된 섹션 구조 (1단계 결과)",
    "아래 제목을 layout_hierarchy의 **상위 섹션 label**로 그대로 사용하고, 각 섹션 children 아래에만 leaf를 넣는다.",
    ...sections.map((s) => `- ${s}`),
    "위 목록에 없는 이름으로 임의 섹션을 새로 만들지 마라.",
  ].join("\n");
}

function parseSectionsFromVlmParsed(parsed: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const s = t.replace(/\s+/g, " ").trim();
    if (!s || s.length > 80 || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  const rawSections = parsed.sections;
  if (Array.isArray(rawSections)) {
    for (const item of rawSections) {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        push(String(o.title ?? o.label ?? o.name ?? ""));
      }
    }
  }

  if (!out.length) {
    const lh = parsed.layout_hierarchy ?? parsed.layoutHierarchy;
    if (Array.isArray(lh)) {
      for (const item of lh) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        const kids = o.children;
        if (Array.isArray(kids) && kids.length > 0) {
          push(String(o.label ?? o.content ?? ""));
        }
      }
    }
  }
  return out;
}

function tryParseJsonContent(text: string): Record<string, unknown> | null {
  const raw = stripVlNoise(text).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? raw;
  const candidates: string[] = [];
  if (fenced !== raw) candidates.push(fenced);
  const balanced = extractBalancedJsonObject(fenced);
  if (balanced) candidates.push(balanced);
  const greedy = fenced.match(/\{[\s\S]*\}/)?.[0];
  if (greedy) candidates.push(greedy);
  if (fenced.startsWith("{")) candidates.push(fenced);

  const tried = new Set<string>();
  for (const c of candidates) {
    if (!c || tried.has(c)) continue;
    tried.add(c);
    try {
      const parsed = JSON.parse(c) as unknown;
      const obj = normalizeParsedJsonRoot(parsed);
      if (obj) return obj;
    } catch {
      // next candidate
    }
  }
  return null;
}

export async function classifyWithVllm(
  imageDataUris: string[],
  schemaSnapshot: SchemaSnapshot
): Promise<LlmClassification> {
  function normalizeExtractedValue(v: unknown): unknown {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v).trim();
    if (Array.isArray(v)) {
      return v.map((x) => normalizeExtractedValue(x)).map(String).join(", ");
    }
    if (typeof v === "object") {
      if (v && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, vv] of Object.entries(obj)) {
          out[k] = normalizeExtractedValue(vv);
        }
        return out;
      }
    }
    return String(v).trim();
  }

  const baseUrl = (process.env.VLLM_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");
  const model = process.env.VLLM_MODEL;
  const modelId = model
    ? model
    : await fetch(`${baseUrl}/v1/models`).then((r) => r.json()).then((j) => j.data?.[0]?.id as string);
  if (!modelId) {
    throw new Error("vLLM 모델을 찾을 수 없습니다.");
  }

  const docTypes = Object.keys(schemaSnapshot);
  const schemaText = docTypes
    .map((dt) => `- ${dt}: [${(schemaSnapshot[dt] ?? []).join(", ")}]`)
    .join("\n");
  const systemPrompt =
    "너는 한 장(또는 여러 페이지)의 문서 이미지를 분류하고, 스키마에 맞는 항목 값을 뽑는다. " +
    "반드시 JSON만 출력한다. 키 이름은 docType, confidence, extractedFields 세 가지로 고정한다. " +
    "스키마에 없는 키를 extractedFields에 만들면 안 된다.";
  const userPrompt = [
    "허용되는 docType 값:",
    docTypes.join(", "),
    "",
    "docType별로 채워야 할 필드 목록:",
    schemaText,
    "",
    "애매하면 docType은 반드시 \"UNKNOWN\"으로 한다.",
    "confidence는 0 이상 1 이하 숫자다.",
    "extractedFields는 객체이며, 키는 선택한 docType에 대해 위에 나열한 스키마 필드와 정확히 일치해야 한다. 스키마에 없는 키는 절대 넣지 않는다.",
    "각 스키마 필드에 대해:",
    "- 그 구역에 입력 칸이 여러 개(여러 라벨)이면, extractedFields[필드명] 값을 { \"라벨문구\": \"추출값\", ... } 형태의 객체로 넣는다.",
    "- 객체의 라벨 키는 60자 이내로 짧게 쓴다.",
    "- 여러 값을 쉼표로 한 문자열에 몰아넣지 않는다.",
    "- 구역에 진짜 입력이 하나뿐이면 문자열 하나만 넣어도 된다.",
    "- 인쇄된 안내 문장·법적 고지 전체를 값으로 복사하지 말고, 실제 기입값만 넣는다.",
    "문서에 보이는 텍스트가 한국어면 한국어 그대로 추출한다.",
  ].join("\n");

  const promptContent = [
    { type: "text", text: userPrompt },
    ...imageDataUris.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
  const body = {
    model: modelId,
    temperature: 0.01,
    max_tokens: getVllmMaxOutputTokens(),
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: promptContent,
      },
    ],
  };
  const data = await vllmChatCompletions(baseUrl, body);
  const responseText = chatCompletionContentToString(data.choices?.[0]?.message?.content);
  const parsed = tryParseJsonContent(responseText) ?? {};
  const docTypeRaw = String(parsed.docType ?? "UNKNOWN").trim();
  const confidenceRaw = Number(parsed.confidence ?? 0);
  const ef = parsed.extractedFields;
  const extractedRaw: Record<string, unknown> =
    ef && typeof ef === "object"
      ? Object.fromEntries(
          Object.entries(ef as Record<string, unknown>).map(([k, v]) => [k, normalizeExtractedValue(v)])
        )
      : {};

  const docType = docTypes.includes(docTypeRaw) ? docTypeRaw : "UNKNOWN";
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;

  const allowedKeys = schemaSnapshot[docType] ?? [];
  let extractedFields: Record<string, unknown>;
  if (allowedKeys.length === 0) {
    extractedFields = Object.fromEntries(
      Object.entries(extractedRaw).map(([k, v]) => [k, postProcessLlmExtractedValue(v)])
    );
  } else {
    extractedFields = {};
    const extra = Object.keys(extractedRaw).filter((k) => !allowedKeys.includes(k));
    for (const k of allowedKeys) {
      extractedFields[k] = postProcessLlmExtractedValue(extractedRaw[k] ?? "");
    }
    if (extra.length) {
      console.info("[classifyWithVllm] dropped-extra-keys", { docType, count: extra.length, sample: extra.slice(0, 30) });
    }
  }

  return { docType, confidence, extractedFields };
}

/** 단일 docType에서 분류를 생략하고 필드 추출만 수행 */
export async function extractFieldsForDocTypeWithVllm(
  imageDataUris: string[],
  docType: string,
  schemaFields: string[]
): Promise<Record<string, unknown>> {
  function normalizeExtractedValue(v: unknown): unknown {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v).trim();
    if (Array.isArray(v)) return v.map((x) => normalizeExtractedValue(x)).map(String).join(", ");
    if (typeof v === "object" && v && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) out[k] = normalizeExtractedValue(vv);
      return out;
    }
    return String(v).trim();
  }

  const baseUrl = (process.env.VLLM_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");
  const model = process.env.VLLM_MODEL;
  const modelId = model
    ? model
    : await fetch(`${baseUrl}/v1/models`).then((r) => r.json()).then((j) => j.data?.[0]?.id as string);
  if (!modelId) throw new Error("vLLM 모델을 찾을 수 없습니다.");

  const fieldsText = schemaFields.join(", ");
  const systemPrompt =
    "너는 문서 이미지에서 지정된 스키마 필드 값을 추출한다. 반드시 JSON만 출력하고, 설명 문장을 쓰지 않는다. " +
    "스키마에 없는 키는 절대 만들지 마라.";
  const userPrompt = [
    `문서 종류: ${docType}`,
    "",
    "아래 필드들만 추출한다.",
    `[${fieldsText}]`,
    "",
    "출력 형식:",
    `{"extractedFields":{"필드명":"값 또는 객체", ...}}`,
    "",
    "규칙:",
    "- extractedFields의 키는 위 필드명과 정확히 일치한다. 추가 키·변형 키 금지.",
    "- 값이 비어도 키는 유지(빈 문자열 허용)",
    "- 입력 칸이 여러 개인 구역은 객체({라벨:값})로 출력 가능. 라벨 키는 60자 이내로 짧게.",
    "- 인쇄된 안내 문장·법적 고지 전체를 값으로 복사하지 말고, 실제 기입값만 넣는다.",
  ].join("\n");

  const body = {
    model: modelId,
    temperature: 0.01,
    max_tokens: getVllmMaxOutputTokens(),
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [{ type: "text", text: userPrompt }, ...imageDataUris.map((url) => ({ type: "image_url", image_url: { url } }))],
      },
    ],
  };

  const data = await vllmChatCompletions(baseUrl, body);
  const responseText = chatCompletionContentToString(data.choices?.[0]?.message?.content);
  const parsed = tryParseJsonContent(responseText) ?? {};
  const root = parsed.extractedFields && typeof parsed.extractedFields === "object" ? parsed.extractedFields : parsed;

  const src = root as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of schemaFields) {
    const v = src[key];
    out[key] = postProcessLlmExtractedValue(v === undefined ? "" : normalizeExtractedValue(v));
  }
  return out;
}

function pdfTextHintsEnabled(): boolean {
  const v = process.env.PDF_TEXT_HINTS?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  const vllmBase = (process.env.VLLM_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");
  if (isVllmTunnelBaseUrl(vllmBase)) return false;
  return true;
}

/**
 * PDF 텍스트 레이어(dict spans)에서 짧은 문자열 후보를 뽑아 VLM에 주입한다.
 * 특정 양식명을 하드코딩하지 않으며, 표 헤더·짧은 라벨 보강에 쓴다.
 */
export function extractPdfTextLabelCandidates(pdfAbsPath: string): string[] {
  if (!pdfAbsPath || !fs.existsSync(pdfAbsPath)) return [];
  const maxPagesRaw = process.env.PDF_TEXT_LAYER_MAX_PAGES;
  const maxItemsRaw = process.env.PDF_TEXT_HINT_MAX_ITEMS;
  let maxPages = maxPagesRaw == null || maxPagesRaw === "" ? 8 : Number(maxPagesRaw);
  let maxItems = maxItemsRaw == null || maxItemsRaw === "" ? 220 : Number(maxItemsRaw);
  if (!Number.isFinite(maxPages) || maxPages < 1) maxPages = 8;
  if (maxPages > 50) maxPages = 50;
  if (!Number.isFinite(maxItems) || maxItems < 20) maxItems = 220;
  if (maxItems > 500) maxItems = 500;

  const script = [
    "import fitz,sys,json,re",
    "path=sys.argv[1]",
    "max_pages=int(sys.argv[2])",
    "max_out=int(sys.argv[3])",
    "MINL,MAXL=1,72",
    "NOISE=re.compile(r'^[\\d\\s\\-–—/:.]+$')",
    "def ok(t):",
    "    t=t.strip()",
    "    if not t or len(t)<MINL or len(t)>MAXL: return False",
    "    if '\\n' in t: return False",
    "    if NOISE.fullmatch(t): return False",
    "    return True",
    "doc=fitz.open(path)",
    "seen=set(); out=[]",
    "for pi in range(min(len(doc), max_pages)):",
    "    page=doc[pi]",
    "    d=page.get_text('dict')",
    "    items=[]",
    "    for b in d.get('blocks',[]) or []:",
    "        if b.get('type')!=0: continue",
    "        for line in b.get('lines',[]) or []:",
    "            for sp in line.get('spans',[]) or []:",
    "                t=(sp.get('text') or '').replace('\\n',' ').strip()",
    "                if not ok(t): continue",
    "                bbox=sp.get('bbox')",
    "                x,y=(bbox[0],bbox[1]) if bbox else (0.0,0.0)",
    "                items.append((y,x,t))",
    "    items.sort(key=lambda z:(z[0],z[1]))",
    "    for y,x,t in items:",
    "        if t in seen: continue",
    "        seen.add(t); out.append(t)",
    "        if len(out)>=max_out: break",
    "    if len(out)>=max_out: break",
    "print(json.dumps(out[:max_out], ensure_ascii=False))",
  ].join("\n");

  const out = spawnSync(pythonCmd(), ["-c", script, pdfAbsPath, String(maxPages), String(maxItems)], {
    encoding: "utf8",
    timeout: 90_000,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
    },
  });
  if (out.status !== 0) {
    console.warn("[pdf-text-hints] 추출 실패", (out.stderr || out.stdout || "").slice(0, 400));
    return [];
  }
  try {
    const arr = JSON.parse((out.stdout || "").trim() || "[]") as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => String(x ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** PDF 텍스트 레이어를 읽기 순서로 이어 붙임 (text_first 모드용) */
export function extractPdfPagePlainText(pdfAbsPath: string): string {
  if (!pdfAbsPath || !fs.existsSync(pdfAbsPath)) return "";
  const maxPagesRaw = process.env.PDF_TEXT_LAYER_MAX_PAGES;
  const maxCharsRaw = process.env.PDF_TEXT_FIRST_MAX_CHARS;
  let maxPages = maxPagesRaw == null || maxPagesRaw === "" ? 4 : Number(maxPagesRaw);
  let maxChars = maxCharsRaw == null || maxCharsRaw === "" ? 14_000 : Number(maxCharsRaw);
  if (!Number.isFinite(maxPages) || maxPages < 1) maxPages = 4;
  if (maxPages > 20) maxPages = 20;
  if (!Number.isFinite(maxChars) || maxChars < 2000) maxChars = 14_000;
  if (maxChars > 40_000) maxChars = 40_000;

  const script = [
    "import fitz,sys,json",
    "doc=fitz.open(sys.argv[1])",
    "max_pages=int(sys.argv[2])",
    "max_chars=int(sys.argv[3])",
    "parts=[]",
    "for pi in range(min(len(doc), max_pages)):",
    "    page=doc[pi]",
    "    blocks=page.get_text('blocks') or []",
    "    blocks.sort(key=lambda b:(round(b[1],1), round(b[0],1)))",
    "    for b in blocks:",
    "        t=(b[4] or '').strip()",
    "        if t: parts.append(t)",
    "text='\\n'.join(parts)",
    "print(json.dumps({'text': text[:max_chars]}, ensure_ascii=False))",
  ].join("\n");

  const out = spawnSync(pythonCmd(), ["-c", script, pdfAbsPath, String(maxPages), String(maxChars)], {
    encoding: "utf8",
    timeout: 90_000,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  if (out.status !== 0) return "";
  try {
    const parsed = JSON.parse((out.stdout || "").trim() || "{}") as { text?: string };
    return String(parsed.text ?? "").trim();
  } catch {
    return "";
  }
}

const TEMPLATE_TEXT_FIRST_SCHEMA = [
  "# 출력 (JSON만)",
  "- document_type: 문자열 (문서 종류)",
  "- summary: 문자열 (한 줄 요약, 선택)",
  "- fields: 문자열 배열 — **입력란 옆 짧은 라벨만** (예: 성명, 학번, 지원학과, E-mail)",
  "",
  "# 규칙",
  "- fields는 표·입력란의 **항목명**만. 문서 제목·양식 이름·법적 고지·첨부 안내·서명·귀하 문구는 넣지 않는다.",
  "- `섹션_` 접두사를 붙이지 않는다. 같은 라벨이 여러 구역에 있을 때만 `구역명_라벨` 형태(예: 지원구분_성명).",
  "- 괄호 안 부연·※·'해당시에만'·'1부'·'발급본'은 제외한다.",
  "- layout_hierarchy·bbox는 출력하지 않는다.",
  "",
  "# 표·한 행 라벨",
  "- 표 한 칸(셀)의 라벨을 **하나의 필드**로 쓴다. '현 소속'·'단과대학'·'학과'처럼 한 행에 나란히 있는 짧은 라벨은 각각 별도 필드로 나열한다.",
  "- 본문에서 띄어쓴 한 라벨(예: '현 소속')은 필드명에서 공백 없이 붙여 쓴다(예: 현소속).",
  "- 같은 의미의 짧은 꼬리만 다른 필드는 넣지 않는다. 이미 '지원학과'가 있으면 '학과'만 단독으로 넣지 않는다.",
  "- 동일 라벨의 `_2`, `_3` 접미사는 만들지 않는다.",
].join("\n");

const TEMPLATE_SIMPLE_VISION_SCHEMA = [
  "# 출력 (JSON만)",
  "- document_type: 문자열",
  "- summary: 문자열 (선택)",
  "- fields: 문자열 배열 — 입력란·표의 짧은 항목 라벨만",
  "",
  "# 규칙",
  "- layout_hierarchy·bbox·children은 **출력하지 않는다**.",
  "- 문서 제목 전체, 양식 번호 문구, 첨부 목록 문장, 서명·귀하는 fields에 넣지 않는다.",
  "- `섹션_` 접두사 금지. 필요 시에만 `표이름_라벨`로 구분.",
].join("\n");

function buildPdfTextHintsBlock(candidates: string[]): string {
  if (!candidates.length) return "";
  const lines = candidates.map((t) => t.replace(/\s+/g, " ").trim().slice(0, 80)).filter(Boolean);
  return [
    "",
    "# PDF 텍스트 레이어 후보 (참고)",
    "아래 문자열은 PDF에서 추출한 짧은 텍스트 스팬이다. 특정 양식을 가리키는 고정 목록이 아니다.",
    "이미지에서 동일·유사 문구가 보이면 layout_hierarchy의 leaf에 반영하고, 표 헤더·항목 라벨이 빠지지 않게 한다.",
    "장문·법적 고지 전체는 필드 키로 쓰지 말고, 짧은 라벨 단위로 나눈다.",
    "",
    ...lines.map((t) => `- ${t}`),
  ].join("\n");
}

function templateResultFromFieldsParsed(
  parsed: Record<string, unknown>,
  context: string
): TemplateAnalysisResult {
  const rawFieldItems = extractRawFieldsArrayFromParsed(parsed);
  let fields = collapseOverlappingFieldKeys(
    rawFieldItems.map(normalizeFieldListItem).filter((s): s is string => Boolean(s))
  );
  const summary =
    String(parsed.summary ?? "").trim() ||
    String(parsed.document_type ?? "").trim() ||
    "텍스트 기반 필드 추출";
  const { fields: normFields } = normalizeSchemaFieldKeys(fields, context);
  return { fields: normFields, summary, fieldBboxes: [] };
}

export async function analyzeTemplateWithVllm(
  imageDataUris: string[],
  docType: string,
  pdfAbsPath?: string | null
): Promise<TemplateAnalysisResult> {
  const baseUrl = (process.env.VLLM_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");
  const model = process.env.VLLM_MODEL;
  const modelId = model
    ? model
    : await fetch(`${baseUrl}/v1/models`).then((r) => r.json()).then((j) => j.data?.[0]?.id as string);
  if (!modelId) throw new Error("vLLM 모델을 찾을 수 없습니다.");

  const mode = getTemplateAnalysisMode();
  const docTypeHint = buildTemplateDocTypeHint(docType);
  const finish = (r: TemplateAnalysisResult, fromTextFirst = false) =>
    pdfWordAugmentEnabled({ fromTextFirst })
      ? augmentTemplateFieldsFromPdfWordLayer(pdfAbsPath, getVllmTemplateRenderScale(), r)
      : r;

  const minFieldsRaw = process.env.TEXT_FIRST_MIN_FIELDS?.trim();
  const minFields = minFieldsRaw ? Math.max(3, Number(minFieldsRaw) || 6) : 6;
  let resolvedImages = [...imageDataUris];

  async function ensureImages(): Promise<string[]> {
    if (resolvedImages.length) return resolvedImages;
    if (!pdfAbsPath) return [];
    const opts = getVllmTemplatePdfRenderOptions();
    resolvedImages = renderAllPagesToDataUris(pdfAbsPath, opts.scale, opts.maxPages, {
      maxLongEdgePx: opts.maxLongEdgePx,
      imageFormat: opts.imageFormat,
      jpegQuality: opts.jpegQuality,
    });
    return resolvedImages;
  }

  async function callLlm(userText: string, maxTokens: number, withImages: boolean): Promise<Record<string, unknown>> {
    const userContent: { type: string; text?: string; image_url?: { url: string } }[] = [
      { type: "text", text: userText },
    ];
    if (withImages) {
      const urls = await ensureImages();
      for (const url of urls) {
        userContent.push({ type: "image_url", image_url: { url } });
      }
    }
    const body = {
      model: modelId,
      temperature: 0.01,
      max_tokens: maxTokens,
      messages: [
        {
          role: "system",
          content:
            "너는 정형 문서(지원서·신청서)에서 입력 항목 필드명만 추출한다. " +
            "반드시 JSON만 출력한다. 설명·마크다운·주석 금지.",
        },
        { role: "user", content: userContent },
      ],
    };
    const data = await vllmChatCompletions(baseUrl, body);
    const responseText = chatCompletionContentToString(data.choices?.[0]?.message?.content);
    return tryParseJsonContent(responseText) ?? {};
  }

  async function runTextFirst(): Promise<TemplateAnalysisResult | null> {
    if (!pdfAbsPath) return null;
    const plain = extractPdfPagePlainText(pdfAbsPath);
    if (plain.length < 80) {
      console.warn("[template-analyze] text_first: PDF 텍스트 부족", { len: plain.length });
      return null;
    }
    const userText = [
      docTypeHint,
      "",
      TEMPLATE_TEXT_FIRST_SCHEMA,
      TEMPLATE_FIELD_KEY_GUIDANCE,
      "",
      "# PDF에서 추출한 본문 (읽기 순서)",
      plain.slice(0, 14_000),
      "",
      "# 이번 요청",
      "위 본문만 보고 입력란·표의 항목 라벨을 fields 배열로 나열한다.",
      "표 한 행의 '현 소속·단과대학·학과'처럼 나란히 있는 라벨은 각각 하나씩, 공백은 제거해 필드명으로 쓴다.",
      "지원학과·지원전공 등 구체적인 이름이 있으면 짧은 '학과'만 단독으로 넣지 않는다.",
      "일반적인 지원서에는 보통 8개 이상의 서로 다른 항목명이 있다.",
    ].join("\n");
    const maxTok = Math.min(4096, getVllmTemplateMaxOutputTokens(baseUrl));
    const parsed = await callLlm(userText, maxTok, false);
    const result = templateResultFromFieldsParsed(parsed, "textFirst");
    if (result.fields.length < minFields) {
      console.warn("[template-analyze] text_first: 필드 수 부족", {
        got: result.fields.length,
        need: minFields,
      });
      return null;
    }
    console.info("[template-analyze] text_first ok", {
      docType,
      fieldCount: result.fields.length,
      sample: result.fields.slice(0, 16),
    });
    return result;
  }

  async function runVisionSimple(): Promise<TemplateAnalysisResult> {
    const textHints =
      pdfAbsPath && pdfTextHintsEnabled() ? extractPdfTextLabelCandidates(pdfAbsPath) : [];
    const hintsBlock = buildPdfTextHintsBlock(textHints);

    const userText = [
      docTypeHint,
      "",
      TEMPLATE_SIMPLE_VISION_SCHEMA,
      TEMPLATE_FIELD_KEY_GUIDANCE,
      hintsBlock,
      "",
      "# 이번 요청",
      "이미지에서 표·입력란의 짧은 항목 라벨만 fields 배열로 추출한다.",
      "layout_hierarchy·bbox는 출력하지 않는다.",
    ].join("\n");

    const parsed = await callLlm(userText, getVllmTemplateMaxOutputTokens(baseUrl), true);
    let result = templateResultFromFieldsParsed(parsed, "visionSimple");

    if (result.fields.length < minFields) {
      const legacy = templateResultFromLayoutHierarchy(parsed);
      if (legacy && legacy.fields.length > result.fields.length) {
        const { fields } = normalizeSchemaFieldKeys(legacy.fields, "visionHierarchyFallback");
        result = { fields, summary: legacy.summary, fieldBboxes: legacy.fieldBboxes ?? [] };
      }
    }

    console.info("[template-analyze] vision simple", {
      docType,
      fieldCount: result.fields.length,
      mode,
    });
    return result;
  }

  if (mode === "text_first" || mode === "auto") {
    try {
      const textResult = await runTextFirst();
      if (textResult) return finish(textResult, true);
    } catch (e) {
      console.warn("[template-analyze] text_first failed", e);
    }
    if (mode === "text_first") {
      console.info("[template-analyze] text_first → vision fallback");
    }
  }

  return finish(await runVisionSimple());
}

