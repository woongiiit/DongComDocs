import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isWithinDateWindow, todayYmdSeoul } from "../lib/processWindow.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { decodeMultipartFilename } from "../lib/uploadFilename.js";

const router = Router();

function routeParamId(v: string | string[] | undefined): string | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureDir(UPLOAD_ROOT);
    cb(null, UPLOAD_ROOT);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
});

type RulesJson = {
  fileRules?: {
    allowedExtensions?: string[];
    maxFiles?: number;
    maxFileBytes?: number;
    fileFormNames?: string[];
  };
  llm?: { enabled?: boolean; prompt?: string };
};

type FileSlotMeta = {
  fileIndex: number;
  slotIndex: number;
};

function normalizeExt(name: string): string {
  const e = path.extname(name).toLowerCase();
  return e.startsWith(".") ? e.slice(1) : e;
}

function parseFileSlots(raw: unknown, fileCount: number): FileSlotMeta[] | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("fileSlots 형식이 올바르지 않습니다.");
  if (parsed.length !== fileCount) throw new Error("fileSlots 개수가 업로드 파일 수와 다릅니다.");

  return parsed.map((x, i) => {
    if (!x || typeof x !== "object") throw new Error("fileSlots 항목 형식이 올바르지 않습니다.");
    const obj = x as Record<string, unknown>;
    const fileIndex = Number(obj.fileIndex);
    const slotIndex = Number(obj.slotIndex);
    if (!Number.isInteger(fileIndex) || fileIndex !== i) {
      throw new Error("fileSlots의 fileIndex가 업로드 순서와 다릅니다.");
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0) {
      throw new Error("fileSlots의 slotIndex가 올바르지 않습니다.");
    }
    return { fileIndex, slotIndex };
  });
}

function validateFileSlotsAgainstRules(slots: FileSlotMeta[], rules: RulesJson): string | null {
  const maxFiles = rules.fileRules?.maxFiles;
  if (maxFiles == null) return null;
  const seen = new Set<number>();
  for (const s of slots) {
    if (s.slotIndex >= maxFiles) return `제출 슬롯 번호는 1~${maxFiles} 범위여야 합니다.`;
    if (seen.has(s.slotIndex)) return "같은 제출 문서 슬롯에 파일이 중복 지정되었습니다.";
    seen.add(s.slotIndex);
  }
  if (seen.size !== maxFiles) return `제출 파일 수는 ${maxFiles}개입니다. (${seen.size}개 업로드됨)`;
  return null;
}

function validateFilesAgainstRules(
  files: Express.Multer.File[],
  rules: RulesJson
): string | null {
  const fr = rules.fileRules;
  if (!fr) return null;
  if (fr.maxFiles != null) {
    if (files.length > fr.maxFiles) {
      return `제출 파일 수는 ${fr.maxFiles}개입니다. (${files.length}개 업로드됨)`;
    }
    if (files.length < fr.maxFiles) {
      return `제출 파일 수는 ${fr.maxFiles}개입니다. (${files.length}개 업로드됨)`;
    }
  }
  if (fr.allowedExtensions?.length) {
    const allowed = new Set(fr.allowedExtensions.map((x) => x.toLowerCase().replace(/^\./, "")));
    for (const f of files) {
      const ext = normalizeExt(f.originalname);
      if (!allowed.has(ext)) {
        return `허용되지 않은 확장자입니다: .${ext}`;
      }
    }
  }
  if (fr.maxFileBytes != null) {
    for (const f of files) {
      if (f.size > fr.maxFileBytes) {
        return `파일 크기는 ${fr.maxFileBytes}바이트 이하여야 합니다.`;
      }
    }
  }
  return null;
}

router.get("/files/:fileId", requireAuth, async (req: AuthedRequest, res) => {
  const fileId = routeParamId(req.params.fileId);
  if (!fileId) {
    res.status(400).json({ error: "잘못된 요청입니다." });
    return;
  }

  const row = await prisma.submissionFile.findUnique({
    where: { id: fileId },
    include: { submission: true },
  });
  if (!row) {
    res.status(404).json({ error: "파일을 찾을 수 없습니다." });
    return;
  }

  const sub = row.submission;
  if (req.user!.role !== "ADMIN" && sub.userId !== req.user!.id) {
    res.status(403).json({ error: "권한이 없습니다." });
    return;
  }

  const abs = path.join(UPLOAD_ROOT, row.storedPath);
  if (!fs.existsSync(abs)) {
    res.status(404).json({ error: "저장된 파일이 없습니다." });
    return;
  }

  const mime = row.mimeType ?? "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(row.originalName)}`);
  fs.createReadStream(abs).pipe(res);
});

router.get("/mine", requireAuth, async (req: AuthedRequest, res) => {
  const list = await prisma.submission.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    include: {
      process: { select: { id: true, title: true } },
      files: {
        select: { id: true, originalName: true, mimeType: true, formSlotIndex: true, formDocType: true, createdAt: true },
        orderBy: [{ formSlotIndex: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  res.json(list);
});

router.post(
  "/",
  requireAuth,
  upload.array("files", 20),
  async (req: AuthedRequest, res) => {
    const bodySchema = z.object({ processId: z.string().min(1), fileSlots: z.string().optional() });
    const parsedBody = bodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: "processId가 필요합니다." });
      return;
    }

    const process = await prisma.process.findUnique({
      where: { id: parsedBody.data.processId },
    });
    if (!process || !process.active) {
      res.status(404).json({ error: "프로세스를 찾을 수 없습니다." });
      return;
    }

    if (
      req.user!.role === "STUDENT" &&
      !isWithinDateWindow(todayYmdSeoul(), process.startDate, process.endDate)
    ) {
      res.status(400).json({ error: "제출 기간이 아닙니다." });
      return;
    }

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files?.length) {
      res.status(400).json({ error: "파일을 하나 이상 선택하세요." });
      return;
    }

    const existingSubmission = await prisma.submission.findFirst({
      where: { userId: req.user!.id, processId: process.id },
    });
    if (existingSubmission) {
      const dupMsg =
        "이미 제출한 이력이 있는 워크플로우입니다. 기존 제출을 취소한 뒤 제출해주세요.";
      for (const f of files) {
        try {
          fs.unlinkSync(f.path);
        } catch {
          /* ignore */
        }
      }
      res.status(409).json({ error: dupMsg });
      return;
    }

    for (const f of files) {
      f.originalname = decodeMultipartFilename(f.originalname);
    }

    const rules = (process.rulesJson ?? {}) as RulesJson;
    const err = validateFilesAgainstRules(files, rules);
    if (err) {
      for (const f of files) {
        try {
          fs.unlinkSync(f.path);
        } catch {
          /* ignore */
        }
      }
      res.status(400).json({ error: err });
      return;
    }

    let fileSlots: FileSlotMeta[];
    try {
      fileSlots = parseFileSlots(parsedBody.data.fileSlots, files.length) ?? files.map((_, i) => ({ fileIndex: i, slotIndex: i }));
    } catch (e) {
      for (const f of files) {
        try {
          fs.unlinkSync(f.path);
        } catch {
          /* ignore */
        }
      }
      res.status(400).json({ error: e instanceof Error ? e.message : "fileSlots 형식이 올바르지 않습니다." });
      return;
    }

    const slotErr = validateFileSlotsAgainstRules(fileSlots, rules);
    if (slotErr) {
      for (const f of files) {
        try {
          fs.unlinkSync(f.path);
        } catch {
          /* ignore */
        }
      }
      res.status(400).json({ error: slotErr });
      return;
    }

    const fileFormNames = rules.fileRules?.fileFormNames ?? [];

    const submission = await prisma.submission.create({
      data: {
        processId: process.id,
        userId: req.user!.id,
        status: "RECEIVED",
        files: {
          create: files.map((f, i) => {
            const slotIndex = fileSlots[i]?.slotIndex ?? i;
            const formDocType = String(fileFormNames[slotIndex] ?? "").trim() || null;
            return {
              originalName: f.originalname,
              storedPath: f.filename,
              mimeType: f.mimetype,
              formSlotIndex: slotIndex,
              formDocType,
            };
          }),
        },
      },
      include: { files: true, process: { select: { title: true } } },
    });

    res.status(201).json(submission);
  }
);

/** PROCESSED_STUB 제출만 취소 — 이력은 UploadCancleHistory에 남기고 제출·파일 DB 행은 삭제, 디스크 파일도 삭제 */
router.post("/:id/cancel", requireAuth, async (req: AuthedRequest, res) => {
  const id = routeParamId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "잘못된 요청입니다." });
    return;
  }

  const sub = await prisma.submission.findUnique({
    where: { id },
    include: {
      files: true,
      process: { select: { id: true, title: true } },
    },
  });

  if (!sub) {
    res.status(404).json({ error: "제출을 찾을 수 없습니다." });
    return;
  }
  if (req.user!.role !== "ADMIN" && sub.userId !== req.user!.id) {
    res.status(403).json({ error: "권한이 없습니다." });
    return;
  }
  if (sub.status !== "PROCESSED_STUB") {
    res.status(400).json({ error: "PROCESSED_STUB 상태인 제출만 취소할 수 있습니다." });
    return;
  }

  const snapshotJson = {
    processId: sub.processId,
    processTitle: sub.process.title,
    previousStatus: sub.status,
    submissionCreatedAt: sub.createdAt.toISOString(),
    files: sub.files.map((f) => ({
      id: f.id,
      originalName: f.originalName,
      storedPath: f.storedPath,
      mimeType: f.mimeType,
      formSlotIndex: f.formSlotIndex,
      formDocType: f.formDocType,
    })),
  };

  await prisma.$transaction(async (tx) => {
    await tx.uploadCancleHistory.create({
      data: {
        submissionId: sub.id,
        userId: sub.userId,
        previousStatus: sub.status,
        snapshotJson,
      },
    });
    await tx.submission.delete({ where: { id: sub.id } });
  });

  for (const f of sub.files) {
    const abs = path.join(UPLOAD_ROOT, f.storedPath);
    try {
      fs.unlinkSync(abs);
    } catch {
      /* ignore */
    }
  }

  res.json({ ok: true });
});

/** 프로세스 규칙 기반 처리 스텁 (추후 HF / vLLM 연동) */
router.post("/:id/run-rules", requireAuth, async (req: AuthedRequest, res) => {
  const id = routeParamId(req.params.id);
  const sub = await prisma.submission.findUnique({
    where: { id: id ?? "" },
    include: { process: true, files: true },
  });
  if (!id || !sub) {
    res.status(404).json({ error: "제출을 찾을 수 없습니다." });
    return;
  }
  if (req.user!.role !== "ADMIN" && sub.userId !== req.user!.id) {
    res.status(403).json({ error: "권한이 없습니다." });
    return;
  }

  const rules = (sub.process.rulesJson ?? {}) as RulesJson;
  const result = {
    submissionId: sub.id,
    fileCheck: { ok: true, fileCount: sub.files.length },
    llm: rules.llm?.enabled
      ? {
          status: "stub",
          message:
            "LLM 연동 전입니다. Hugging Face Inference API 또는 자체 vLLM 서비스를 여기에 연결하세요.",
          configuredPrompt: rules.llm.prompt ?? null,
        }
      : { status: "skipped", message: "이 프로세스는 LLM 분석이 비활성화되어 있습니다." },
  };

  await prisma.submission.update({
    where: { id: sub.id },
    data: { status: "PROCESSED_STUB" },
  });

  res.json(result);
});

export default router;
