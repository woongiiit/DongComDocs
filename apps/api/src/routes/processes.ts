import { Router } from "express";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import archiver from "archiver";
import { Prisma } from "@prisma/client";
import multer from "multer";
import { prisma } from "../lib/prisma.js";
import { dateToYmdSeoul, isWithinDateWindow, todayYmdSeoul } from "../lib/processWindow.js";
import { decodeMultipartFilename } from "../lib/uploadFilename.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import {
  analyzeTemplateWithVllm,
  getVllmTemplateRenderScale,
  buildTemplateFieldBoxes,
  classifyWithVllm,
  extractFieldsForDocTypeWithVllm,
  extractFieldKeys,
  getLlmStudentId,
  getVllmPdfRenderOptions,
  normalizeDocTypesFromRulesJson,
  renderAllPagesToDataUris,
  renderFirstPageToDataUri,
  uniqueSheetName,
  type FieldBox,
  type SchemaSnapshot,
} from "../lib/reanalysis.js";

const router = Router();

function routeParamId(v: string | string[] | undefined): string | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function optionalYmd() {
  return z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().regex(YMD).optional()
  );
}

function optionalStartEndDates() {
  return { startDate: optionalYmd(), endDate: optionalYmd() };
}

const rulesSchema = z.object({
  fileRules: z
    .object({
      allowedExtensions: z.array(z.string()).optional(),
      maxFiles: z.number().int().positive().optional(),
      maxFileBytes: z.number().int().positive().optional(),
      fileFormNames: z.array(z.string()).optional(),
    })
    .optional(),
  llm: z
    .object({
      enabled: z.boolean().optional(),
      prompt: z.string().optional(),
    })
    .optional(),
});

const processBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  rulesJson: rulesSchema,
  active: z.boolean().optional(),
  ...optionalStartEndDates(),
});

const createSchema = processBody.superRefine((data, ctx) => {
  if (data.startDate && data.endDate && data.startDate > data.endDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "시작일은 종료일보다 늦을 수 없습니다.",
      path: ["endDate"],
    });
  }
});

const patchDateField = z.preprocess(
  (v) => (v === "" ? null : v),
  z.union([z.string().regex(YMD), z.null()]).optional()
);

const patchSchema = processBody
  .partial()
  .extend({
    startDate: patchDateField,
    endDate: patchDateField,
  })
  .superRefine((data, ctx) => {
    if (data.startDate && data.endDate && data.startDate > data.endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "시작일은 종료일보다 늦을 수 없습니다.",
        path: ["endDate"],
      });
    }
  });

/** XLSX 고정 컬럼 key와 스키마 필드명이 겹치면 ExcelJS 컬럼 key 중복으로 실패할 수 있음 */
const XLSX_FIXED_COLUMN_KEYS = new Set(["originalName", "studentId_db", "studentId_llm", "confidence"]);

/** 다운로드 파일명에 쓰는 프로세스명 구간(Windows 금지 문자 제거) */
function sanitizeReanalysisBasenameSegment(title: string): string {
  const s = title
    .replace(/[\\/:*?"<>|\[\]]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return s.slice(0, 120) || "process";
}

async function reanalysisDownloadFileBase(run: {
  id: string;
  processId: string;
  createdAt: Date;
  finishedAt: Date | null;
  process: { title: string };
}): Promise<string> {
  const ordinal =
    (await prisma.processReanalysisRun.count({
      where: {
        processId: run.processId,
        OR: [
          { createdAt: { lt: run.createdAt } },
          { AND: [{ createdAt: run.createdAt }, { id: { lt: run.id } }] },
        ],
      },
    })) + 1;
  const ymd = dateToYmdSeoul(run.finishedAt ?? run.createdAt);
  const titlePart = sanitizeReanalysisBasenameSegment(run.process.title);
  return `${titlePart}-${ymd}-${ordinal}`;
}

function xlsxExtractedFieldColumnKeys(allFields: string[]): Map<string, string> {
  const fieldToKey = new Map<string, string>();
  const used = new Set<string>(XLSX_FIXED_COLUMN_KEYS);
  for (const f of allFields) {
    let base = XLSX_FIXED_COLUMN_KEYS.has(f) ? `__field_${f}` : f;
    let key = base;
    let n = 2;
    while (used.has(key)) {
      key = `${base}__${n}`;
      n++;
    }
    used.add(key);
    fieldToKey.set(f, key);
  }
  return fieldToKey;
}

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const TEMPLATE_ROOT = path.join(UPLOAD_ROOT, "layout-templates");
if (!fs.existsSync(TEMPLATE_ROOT)) fs.mkdirSync(TEMPLATE_ROOT, { recursive: true });
const templateUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TEMPLATE_ROOT),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".pdf";
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

type RunRow = {
  docType: string;
  originalName: string;
  studentIdDb: string;
  studentIdLlm: string;
  confidence: number;
  extractedFields: Record<string, unknown>;
  absPath: string;
};

type SchemaEnvelope = {
  fields?: string[];
  _template?: { originalName?: string; storedPath?: string };
  _analysisSummary?: string;
};

function toSchemaEnvelope(schemaJson: unknown): SchemaEnvelope {
  if (!schemaJson || typeof schemaJson !== "object") return { fields: [] };
  return schemaJson as SchemaEnvelope;
}

function toSchemaSnapshot(docTypes: string[], rows: { docType: string; schemaJson: unknown }[]): SchemaSnapshot {
  const byType = new Map(rows.map((x) => [x.docType, x.schemaJson]));
  const out: SchemaSnapshot = {};
  for (const dt of docTypes) {
    const schema = byType.get(dt);
    out[dt] = extractFieldKeys(schema);
  }
  out.UNKNOWN = out.UNKNOWN ?? [];
  return out;
}

async function executeReanalysisRun(runId: string): Promise<void> {
  const run = await prisma.processReanalysisRun.findUnique({
    where: { id: runId },
    include: { process: true },
  });
  if (!run) return;

  const snapshot = (run.schemaSnapshotJson ?? {}) as SchemaSnapshot;
  const configuredDocTypes = Object.keys(snapshot).filter((dt) => dt !== "UNKNOWN" && dt.trim().length > 0);
  const forcedSingleDocType = configuredDocTypes.length === 1 ? configuredDocTypes[0] : null;
  const forcedSchemaFields = forcedSingleDocType ? snapshot[forcedSingleDocType] ?? [] : [];
  if (forcedSingleDocType) {
    console.info("[reanalysis-runs/execute] single-docType bypass enabled", {
      runId: run.id,
      processId: run.processId,
      forcedDocType: forcedSingleDocType,
      schemaFieldsCount: forcedSchemaFields.length,
    });
  }
  const vllmPdfOpts = getVllmPdfRenderOptions();
  console.info("[reanalysis-runs/execute] vllm-pdf-render", vllmPdfOpts);
  const files = await prisma.submissionFile.findMany({
    where: { submission: { processId: run.processId } },
    include: {
      submission: {
        include: {
          user: { select: { id: true, studentId: true } },
        },
      },
    },
    orderBy: [{ submission: { createdAt: "asc" } }, { formSlotIndex: "asc" }, { createdAt: "asc" }],
  });

  // 진행도 UI 표시용: total/processed를 RUNNING 상태에서 계속 갱신합니다.
  await prisma.processReanalysisRun.update({
    where: { id: run.id },
    data: { totalFiles: files.length, processedFiles: 0 },
  });

  const rows: {
    runId: string;
    submissionFileId: string;
    docType: string;
    confidence: number;
    extractedFieldsJson: Prisma.InputJsonValue;
  }[] = [];

  let processed = 0;
  let lastProgressUpdateAt = Date.now();
  for (const f of files) {
    const abs = path.join(UPLOAD_ROOT, f.storedPath);
    let docType = "UNKNOWN";
    let confidence = 0;
    let extractedFields: Record<string, unknown> = {};
    if (fs.existsSync(abs)) {
      try {
        const imageDataUris = renderAllPagesToDataUris(abs, vllmPdfOpts.scale, vllmPdfOpts.maxPages, {
          maxLongEdgePx: vllmPdfOpts.maxLongEdgePx,
          imageFormat: vllmPdfOpts.imageFormat,
          jpegQuality: vllmPdfOpts.jpegQuality,
        });
        if (forcedSingleDocType) {
          docType = forcedSingleDocType;
          confidence = 1;
          extractedFields = await extractFieldsForDocTypeWithVllm(imageDataUris, forcedSingleDocType, forcedSchemaFields);
        } else if (f.formDocType && configuredDocTypes.includes(f.formDocType)) {
          docType = f.formDocType;
          confidence = 1;
          extractedFields = await extractFieldsForDocTypeWithVllm(imageDataUris, docType, snapshot[docType] ?? []);
        } else {
          const result = await classifyWithVllm(imageDataUris, snapshot);
          docType = result.docType;
          confidence = result.confidence;
          extractedFields = result.extractedFields;
        }
      } catch {
        // 분류 실패 시 UNKNOWN으로 저장(단일 docType 구성에서는 해당 docType으로 강제)
        if (forcedSingleDocType) {
          docType = forcedSingleDocType;
          confidence = 1;
        }
      }
    }
    if (forcedSingleDocType) {
      const nonEmptyCount = forcedSchemaFields.filter((k) => {
        const v = extractedFields[k];
        if (v === null || v === undefined) return false;
        if (typeof v === "string") return v.trim().length > 0;
        if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
        return String(v).trim().length > 0;
      }).length;
      console.info("[reanalysis-runs/execute] extracted-fields", {
        runId: run.id,
        fileId: f.id,
        originalName: f.originalName,
        docType,
        schemaFieldsCount: forcedSchemaFields.length,
        nonEmptyExtractedFields: nonEmptyCount,
        extractedFieldKeysSample: Object.keys(extractedFields).slice(0, 10),
      });
    }
    rows.push({
      runId: run.id,
      submissionFileId: f.id,
      docType,
      confidence,
      extractedFieldsJson: extractedFields as Prisma.InputJsonValue,
    });

    processed += 1;
    // 너무 잦은 DB 업데이트를 피하기 위해 1.5초 단위로만 진행도를 갱신합니다.
    if (Date.now() - lastProgressUpdateAt > 1500 || processed === files.length) {
      await prisma.processReanalysisRun.update({
        where: { id: run.id },
        data: { processedFiles: processed },
      });
      lastProgressUpdateAt = Date.now();
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.submissionFileDocTypeResult.createMany({ data: rows });
    await tx.processReanalysisRun.update({
      where: { id: run.id },
      data: { status: "SUCCEEDED", finishedAt: new Date(), processedFiles: files.length, totalFiles: files.length },
    });
  });
}

/** 관리자: docType별 레이아웃 스키마 조회 */
router.get("/:id/layout-schemas", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = routeParamId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "잘못된 요청입니다." });
    return;
  }
  const process = await prisma.process.findUnique({ where: { id } });
  if (!process) {
    res.status(404).json({ error: "프로세스를 찾을 수 없습니다." });
    return;
  }
  const fromRules = normalizeDocTypesFromRulesJson(process.rulesJson);
  const rows = await prisma.processLayoutSchema.findMany({
    where: { processId: id },
    orderBy: { docType: "asc" },
  });
  const inDb = new Set(rows.map((r) => r.docType));
  const merged = [
    ...rows.map((r) => ({
      docType: r.docType,
      schemaJson: r.schemaJson,
      templateOriginalName: toSchemaEnvelope(r.schemaJson)._template?.originalName
        ? decodeMultipartFilename(toSchemaEnvelope(r.schemaJson)._template!.originalName!)
        : null,
      analysisSummary: toSchemaEnvelope(r.schemaJson)._analysisSummary ?? null,
    })),
    ...fromRules.filter((dt) => !inDb.has(dt)).map((dt) => ({ docType: dt, schemaJson: { fields: [] } })),
  ];
  res.json(merged);
});

/** 관리자: docType 스키마 생성/수정 */
router.put("/:id/layout-schemas/:docType", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = routeParamId(req.params.id);
  const docType = routeParamId(req.params.docType)?.trim();
  if (!id || !docType) {
    res.status(400).json({ error: "잘못된 요청입니다." });
    return;
  }
  const schema = z.object({ schemaJson: z.unknown() }).safeParse(req.body);
  if (!schema.success) {
    res.status(400).json({ error: "schemaJson이 필요합니다." });
    return;
  }
  const process = await prisma.process.findUnique({ where: { id } });
  if (!process) {
    res.status(404).json({ error: "프로세스를 찾을 수 없습니다." });
    return;
  }
  const existing = await prisma.processLayoutSchema.findUnique({
    where: { processId_docType: { processId: id, docType } },
  });
  const existingEnv = toSchemaEnvelope(existing?.schemaJson);
  const newFields = extractFieldKeys(schema.data.schemaJson);
  const nextSchema = {
    ...existingEnv,
    fields: newFields,
  };
  const row = await prisma.processLayoutSchema.upsert({
    where: { processId_docType: { processId: id, docType } },
    create: { processId: id, docType, schemaJson: nextSchema as Prisma.InputJsonValue },
    update: { schemaJson: nextSchema as Prisma.InputJsonValue },
  });
  res.json(row);
});

/** 관리자: docType 템플릿 PDF 업로드 */
router.post(
  "/:id/layout-schemas/:docType/template",
  requireAuth,
  requireAdmin,
  templateUpload.single("file"),
  async (req: AuthedRequest, res) => {
    const id = routeParamId(req.params.id);
    const docType = routeParamId(req.params.docType)?.trim();
    if (!id || !docType) {
      res.status(400).json({ error: "잘못된 요청입니다." });
      return;
    }
    const process = await prisma.process.findUnique({ where: { id } });
    if (!process) {
      res.status(404).json({ error: "프로세스를 찾을 수 없습니다." });
      return;
    }
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "PDF 파일이 필요합니다." });
      return;
    }
    const originalName = decodeMultipartFilename(file.originalname);
    const existing = await prisma.processLayoutSchema.findUnique({
      where: { processId_docType: { processId: id, docType } },
    });
    const oldEnv = toSchemaEnvelope(existing?.schemaJson);
    const nextSchema = {
      ...oldEnv,
      fields: Array.isArray(oldEnv.fields) ? oldEnv.fields : [],
      _template: {
        originalName,
        storedPath: path.join("layout-templates", file.filename),
      },
    };
    const row = await prisma.processLayoutSchema.upsert({
      where: { processId_docType: { processId: id, docType } },
      create: {
        processId: id,
        docType,
        schemaJson: nextSchema,
      },
      update: {
        schemaJson: nextSchema,
      },
    });
    res.status(201).json({
      id: row.id,
      docType: row.docType,
      templateOriginalName: originalName,
    });
  }
);

/** 관리자: 업로드된 템플릿 PDF를 분석해 스키마 초안 생성 */
router.post("/:id/layout-schemas/:docType/analyze-template", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = routeParamId(req.params.id);
  const docType = routeParamId(req.params.docType)?.trim();
  if (!id || !docType) {
    res.status(400).json({ error: "잘못된 요청입니다." });
    return;
  }

  const row = await prisma.processLayoutSchema.findUnique({
    where: { processId_docType: { processId: id, docType } },
  });
  if (!row) {
    res.status(400).json({ error: "먼저 docType 스키마를 생성하세요." });
    return;
  }
  const env = toSchemaEnvelope(row?.schemaJson);
  const stored = env._template?.storedPath;
  if (!stored) {
    res.status(400).json({ error: "먼저 템플릿 PDF를 업로드하세요." });
    return;
  }
  const abs = path.join(UPLOAD_ROOT, stored);
  if (!fs.existsSync(abs)) {
    res.status(404).json({ error: "템플릿 파일을 찾을 수 없습니다." });
    return;
  }

  try {
    const scale = getVllmTemplateRenderScale();
    const vllmOpts = getVllmPdfRenderOptions();
    const imageDataUris = renderAllPagesToDataUris(abs, scale, vllmOpts.maxPages, {
      maxLongEdgePx: vllmOpts.maxLongEdgePx,
      imageFormat: vllmOpts.imageFormat,
      jpegQuality: vllmOpts.jpegQuality,
    });
    const analyzed = await analyzeTemplateWithVllm(imageDataUris, docType, abs);

    // 템플릿 단계 bbox 미리보기(1페이지)용 데이터 생성
    const previewImageDataUri: string = renderFirstPageToDataUri(abs, scale);
    const fieldBoxes = buildTemplateFieldBoxes(abs, scale, analyzed.fields, analyzed.fieldBboxes ?? [], {
      pdfPageCount: imageDataUris.length,
    });

    const existingEnv = toSchemaEnvelope(row.schemaJson);
    const nextSchema = {
      ...existingEnv,
      fields: analyzed.fields,
      _analysisSummary: analyzed.summary || "",
    };
    const updated = await prisma.processLayoutSchema.update({
      where: { processId_docType: { processId: id, docType } },
      data: {
        schemaJson: nextSchema,
      },
    });
    const updatedEnv = toSchemaEnvelope(updated.schemaJson);
    res.json({
      docType: updated.docType,
      schemaJson: updated.schemaJson,
      analysisSummary: updatedEnv._analysisSummary ?? null,
      previewImageDataUri,
      fieldBoxes,
    });
  } catch (e) {
    console.error("[analyze-template] failed", {
      processId: id,
      docType,
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      cause:
        e instanceof Error && e.cause
          ? String(e.cause)
          : undefined,
    });
    res.status(500).json({ error: e instanceof Error ? e.message : "템플릿 분석 실패" });
  }
});

/** 관리자: 재분석 실행(run 생성 후 백그라운드 처리) */
router.post("/:id/reanalysis-runs", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = routeParamId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "잘못된 요청입니다." });
    return;
  }
  const process = await prisma.process.findUnique({ where: { id } });
  if (!process) {
    res.status(404).json({ error: "프로세스를 찾을 수 없습니다." });
    return;
  }
  const docTypes = normalizeDocTypesFromRulesJson(process.rulesJson);
  const schemaRows = await prisma.processLayoutSchema.findMany({ where: { processId: id } });
  const schemaByDocType = new Map(schemaRows.map((x) => [x.docType, x.schemaJson]));
  const debugRows = docTypes.map((dt) => {
    const schema = schemaByDocType.get(dt);
    const fieldCount = extractFieldKeys(schema).length;
    const conditionDocTypeExactMatch = schemaByDocType.has(dt);
    const conditionSavedFields = fieldCount > 0;
    return {
      docType: dt,
      conditionDocTypeExactMatch,
      conditionSavedFields,
      fieldCount,
    };
  });
  const dbOnlyDocTypes = schemaRows.map((x) => x.docType).filter((dt) => !docTypes.includes(dt));
  console.info("[reanalysis-runs/create] schema-conditions", {
    processId: id,
    processTitle: process.title,
    rulesDocTypes: docTypes,
    dbSchemaDocTypes: schemaRows.map((x) => x.docType),
    dbOnlyDocTypes,
    checks: debugRows,
  });
  const snapshot = toSchemaSnapshot(docTypes, schemaRows);

  const run = await prisma.processReanalysisRun.create({
    data: {
      processId: id,
      createdById: req.user!.id,
      schemaSnapshotJson: snapshot,
      status: "RUNNING",
    },
  });

  // 비동기 실행(요청은 즉시 반환)
  void executeReanalysisRun(run.id).catch(async (err) => {
    await prisma.processReanalysisRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : "reanalysis failed",
      },
    });
  });

  res.status(202).json({ runId: run.id, status: run.status });
});

/** 관리자: 프로세스 재분석 run 이력 */
router.get("/:id/reanalysis-runs", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = routeParamId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "잘못된 요청입니다." });
    return;
  }
  const runs = await prisma.processReanalysisRun.findMany({
    where: { processId: id },
    orderBy: { createdAt: "desc" },
    include: {
      createdBy: { select: { studentId: true } },
      _count: { select: { fileClassifications: true } },
    },
  });
  res.json(runs);
});

async function getRunRows(
  runId: string
): Promise<{
  run: {
    id: string;
    schemaSnapshotJson: unknown;
    processId: string;
    status: string;
    createdAt: Date;
    finishedAt: Date | null;
    process: { title: string };
  };
  rows: RunRow[];
}> {
  const run = await prisma.processReanalysisRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      schemaSnapshotJson: true,
      processId: true,
      status: true,
      createdAt: true,
      finishedAt: true,
      process: { select: { title: true } },
    },
  });
  if (!run) throw new Error("RUN_NOT_FOUND");

  const classifications = await prisma.submissionFileDocTypeResult.findMany({
    where: { runId },
    include: {
      submissionFile: {
        include: {
          submission: { include: { user: { select: { studentId: true } } } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const rows: RunRow[] = classifications.map((c) => {
    const ef = (c.extractedFieldsJson ?? {}) as Record<string, unknown>;
    return {
      docType: c.docType,
      originalName: c.submissionFile.originalName,
      studentIdDb: c.submissionFile.submission.user.studentId,
      studentIdLlm: getLlmStudentId(ef) ?? "",
      confidence: c.confidence,
      extractedFields: ef,
      absPath: path.join(UPLOAD_ROOT, c.submissionFile.storedPath),
    };
  });
  return { run, rows };
}

/** 관리자: run 결과 XLSX (A/B/C/UNKNOWN 시트) */
router.get("/reanalysis-runs/:runId/xlsx", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  try {
    const runId = routeParamId(req.params.runId);
    if (!runId) {
      res.status(400).json({ error: "잘못된 요청입니다." });
      return;
    }
    const { run, rows } = await getRunRows(runId);
    if (run.status !== "SUCCEEDED") {
      res.status(409).json({ error: `run 상태가 ${run.status} 입니다. SUCCEEDED 후 다운로드 가능합니다.` });
      return;
    }
    const snapshot = (run.schemaSnapshotJson ?? {}) as SchemaSnapshot;
    const docTypes = Object.keys(snapshot).length ? Object.keys(snapshot) : ["UNKNOWN"];
    console.info("[reanalysis-runs/xlsx] start", {
      runId: run.id,
      processId: run.processId,
      processTitle: run.process.title,
      snapshotDocTypes: docTypes,
      rowsCount: rows.length,
    });

    const wb = new ExcelJS.Workbook();
    const usedSheetNames = new Set<string>();
    for (const dt of docTypes) {
      const targetRows = rows.filter((r) => r.docType === dt);
      if (dt === "UNKNOWN" && targetRows.length === 0) {
        console.info("[reanalysis-runs/xlsx] skip-empty-unknown-sheet", { runId: run.id });
        continue;
      }
      const ws = wb.addWorksheet(uniqueSheetName(dt, usedSheetNames));
      const schemaFields = snapshot[dt] ?? [];

      // schemaFields(예: 인적사항/지도교수/...) 아래에 nested object가 들어오면, 내부 key를 컬럼으로 펼칩니다.
      const subFieldSet = new Set<string>();
      for (const r of targetRows) {
        for (const f of schemaFields) {
          const v = r.extractedFields[f];
          if (v && typeof v === "object" && !Array.isArray(v)) {
            for (const k of Object.keys(v as Record<string, unknown>)) subFieldSet.add(k);
          }
        }
      }

      const subFields = Array.from(subFieldSet);
      const allFields = [...schemaFields, ...subFields.filter((k) => !schemaFields.includes(k))];
      const extractedColKeys = xlsxExtractedFieldColumnKeys(allFields);
      console.info("[reanalysis-runs/xlsx] sheet-fields", {
        runId: run.id,
        docType: dt,
        targetRowsCount: targetRows.length,
        schemaFieldsCount: schemaFields.length,
        schemaFieldsSample: schemaFields.slice(0, 10),
        nestedSubFieldsCount: subFields.length,
        nestedSubFieldsSample: subFields.slice(0, 10),
        finalAllFieldsCount: allFields.length,
      });
      // columns는 setter로 한 번에만 지정해야 plain object가 Column으로 래핑됨(push만 하면 writeBuffer 시 equivalentTo 오류)
      ws.columns = [
        { header: "originalName", key: "originalName", width: 40 },
        { header: "studentId_db", key: "studentId_db", width: 18 },
        { header: "studentId_llm", key: "studentId_llm", width: 18 },
        { header: "confidence", key: "confidence", width: 12 },
        ...allFields.map((f) => ({ header: f, key: extractedColKeys.get(f)!, width: 22 })),
      ];

      for (const r of targetRows) {
        const row: Record<string, unknown> = {
          originalName: r.originalName,
          studentId_db: r.studentIdDb,
          studentId_llm: r.studentIdLlm,
          confidence: r.confidence,
        };

        const getValueForKey = (key: string): unknown => {
          const direct = r.extractedFields[key];
          if (direct !== undefined) return direct;
          for (const f of schemaFields) {
            const v = r.extractedFields[f];
            if (!v || typeof v !== "object" || Array.isArray(v)) continue;
            const obj = v as Record<string, unknown>;
            if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
          }
          return "";
        };

        for (const key of allFields) {
          const colKey = extractedColKeys.get(key)!;
          const v = getValueForKey(key);
          if (v === null || v === undefined) row[colKey] = "";
          else if (typeof v === "object") row[colKey] = JSON.stringify(v);
          else row[colKey] = String(v);
        }

        ws.addRow(row);
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    const fileBase = await reanalysisDownloadFileBase(run);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(`${fileBase}.xlsx`)}`
    );
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(Buffer.from(buf));
  } catch (e) {
    if (e instanceof Error && e.message === "RUN_NOT_FOUND") {
      res.status(404).json({ error: "run을 찾을 수 없습니다." });
      return;
    }
    console.error("[reanalysis-runs/xlsx]", e);
    res.status(500).json({ error: "xlsx 생성 실패" });
  }
});

/** 관리자: run 결과 ZIP (A/B/C/UNKNOWN 폴더) */
router.get("/reanalysis-runs/:runId/zip", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  try {
    const runId = routeParamId(req.params.runId);
    if (!runId) {
      res.status(400).json({ error: "잘못된 요청입니다." });
      return;
    }
    const { run, rows } = await getRunRows(runId);
    if (run.status !== "SUCCEEDED") {
      res.status(409).json({ error: `run 상태가 ${run.status} 입니다. SUCCEEDED 후 다운로드 가능합니다.` });
      return;
    }

    const pickMap = new Map<string, RunRow>();
    for (const r of rows) {
      const key = `${r.docType}::${r.studentIdDb}`;
      const prev = pickMap.get(key);
      if (!prev || r.confidence > prev.confidence) pickMap.set(key, r);
    }
    const selected = Array.from(pickMap.values());

    const fileBase = await reanalysisDownloadFileBase(run);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(`${fileBase}.zip`)}`
    );
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", () => {
      res.status(500).end();
    });
    archive.pipe(res);

    const nameCount = new Map<string, number>();
    for (const row of selected) {
      if (!fs.existsSync(row.absPath)) continue;
      const folder = row.docType || "UNKNOWN";
      const baseKey = `${folder}/${row.originalName}`;
      const n = (nameCount.get(baseKey) ?? 0) + 1;
      nameCount.set(baseKey, n);
      const entryName =
        n === 1
          ? `${folder}/${row.originalName}`
          : `${folder}/${path.parse(row.originalName).name}_${n}${path.extname(row.originalName)}`;
      archive.file(row.absPath, { name: entryName });
    }
    void archive.finalize();
  } catch (e) {
    if (e instanceof Error && e.message === "RUN_NOT_FOUND") {
      res.status(404).json({ error: "run을 찾을 수 없습니다." });
      return;
    }
    res.status(500).json({ error: "zip 생성 실패" });
  }
});

/** 관리자: 프로세스별 문서 제출 현황 요약 (파일 미포함) */
router.get("/submission-overview", requireAuth, requireAdmin, async (_req: AuthedRequest, res) => {
  const processes = await prisma.process.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      description: true,
      active: true,
      startDate: true,
      endDate: true,
      createdAt: true,
      _count: { select: { submissions: true } },
    },
  });

  const ids = processes.map((p) => p.id);
  if (!ids.length) {
    res.json([]);
    return;
  }

  // processId + status 기준 제출 개수 집계(파일 미포함)
  const groups = await prisma.submission.groupBy({
    by: ["processId", "status"],
    where: { processId: { in: ids } },
    _count: { _all: true },
  });

  const statusCountsByProcessId: Record<string, Record<string, number>> = {};
  for (const g of groups) {
    if (!statusCountsByProcessId[g.processId]) statusCountsByProcessId[g.processId] = {};
    statusCountsByProcessId[g.processId][g.status] = g._count._all;
  }

  res.json(
    processes.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      active: p.active,
      startDate: p.startDate,
      endDate: p.endDate,
      createdAt: p.createdAt,
      submissionsCount: p._count.submissions,
      statusCounts: statusCountsByProcessId[p.id] ?? {},
    }))
  );
});

/** 관리자: 특정 프로세스의 제출 + 제출 파일 목록 */
router.get("/:id/submissions", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = routeParamId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "잘못된 요청입니다." });
    return;
  }

  const process = await prisma.process.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      description: true,
      active: true,
      startDate: true,
      endDate: true,
      rulesJson: true,
      createdAt: true,
    },
  });

  if (!process) {
    res.status(404).json({ error: "프로세스를 찾을 수 없습니다." });
    return;
  }

  const submissions = await prisma.submission.findMany({
    where: { processId: id },
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { id: true, studentId: true } },
      files: {
        select: { id: true, originalName: true, mimeType: true, formSlotIndex: true, formDocType: true, createdAt: true },
        orderBy: [{ formSlotIndex: "asc" }, { createdAt: "asc" }],
      },
    },
  });

  res.json({ process, submissions });
});

router.get("/", requireAuth, async (req: AuthedRequest, res) => {
  if (req.user!.role === "ADMIN") {
    const list = await prisma.process.findMany({
      orderBy: { createdAt: "desc" },
      include: { createdBy: { select: { studentId: true } } },
    });
    res.json(list);
    return;
  }

  const today = todayYmdSeoul();
  const list = await prisma.process.findMany({
    where: {
      active: true,
      AND: [
        { OR: [{ startDate: null }, { startDate: { lte: today } }] },
        { OR: [{ endDate: null }, { endDate: { gte: today } }] },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      description: true,
      active: true,
      startDate: true,
      endDate: true,
      createdAt: true,
    },
  });
  res.json(list);
});

router.get("/:id", requireAuth, async (req: AuthedRequest, res) => {
  const id = routeParamId(req.params.id);
  const process = await prisma.process.findUnique({
    where: { id: id ?? "" },
  });
  if (!id || !process) {
    res.status(404).json({ error: "프로세스를 찾을 수 없습니다." });
    return;
  }
  if (req.user!.role !== "ADMIN" && !process.active) {
    res.status(404).json({ error: "프로세스를 찾을 수 없습니다." });
    return;
  }

  const today = todayYmdSeoul();
  if (
    req.user!.role !== "ADMIN" &&
    !isWithinDateWindow(today, process.startDate, process.endDate)
  ) {
    res.status(404).json({ error: "프로세스를 찾을 수 없습니다." });
    return;
  }

  if (req.user!.role === "ADMIN") {
    res.json(process);
    return;
  }

  const { rulesJson, ...rest } = process;
  res.json({
    ...rest,
    rulesJson: rulesJson ?? {},
  });
});

router.post("/", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다.", details: parsed.error.flatten() });
    return;
  }
  const body = parsed.data;
  const process = await prisma.process.create({
    data: {
      title: body.title,
      description: body.description ?? null,
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      rulesJson: body.rulesJson ?? {},
      active: body.active ?? true,
      createdById: req.user!.id,
    },
  });
  res.status(201).json(process);
});

router.patch("/:id", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = routeParamId(req.params.id);
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다.", details: parsed.error.flatten() });
    return;
  }
  const existing = await prisma.process.findUnique({ where: { id: id ?? "" } });
  if (!id || !existing) {
    res.status(404).json({ error: "프로세스를 찾을 수 없습니다." });
    return;
  }
  const data = parsed.data;
  const process = await prisma.process.update({
    where: { id },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.rulesJson !== undefined && { rulesJson: data.rulesJson }),
      ...(data.active !== undefined && { active: data.active }),
      ...(data.startDate !== undefined && { startDate: data.startDate }),
      ...(data.endDate !== undefined && { endDate: data.endDate }),
    },
  });
  res.json(process);
});

export default router;
