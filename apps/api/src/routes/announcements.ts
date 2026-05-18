import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

function routeParamId(v: string | string[] | undefined): string | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

const ANNOUNCEMENT_UPLOAD_ROOT = path.join(process.cwd(), "uploads", "announcements");

function ensureAnnouncementUploadDir() {
  if (!fs.existsSync(ANNOUNCEMENT_UPLOAD_ROOT)) {
    fs.mkdirSync(ANNOUNCEMENT_UPLOAD_ROOT, { recursive: true });
  }
}

const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureAnnouncementUploadDir();
      cb(null, ANNOUNCEMENT_UPLOAD_ROOT);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || "";
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      cb(new Error("이미지 형식은 png, jpg, jpeg, gif, webp만 허용됩니다."));
      return;
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

const upsertSchema = z.object({
  title: z.string().trim().min(1, "제목을 입력하세요.").max(200),
  content: z.string().trim().min(1, "내용을 입력하세요.").max(50000),
  pinned: z.boolean().optional(),
});

const patchSchema = upsertSchema.partial();

router.get("/", requireAuth, async (_req: AuthedRequest, res) => {
  const items = await prisma.announcement.findMany({
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
    include: { createdBy: { select: { studentId: true } } },
  });
  res.json(items);
});

router.post("/", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않습니다." });
    return;
  }
  const created = await prisma.announcement.create({
    data: {
      title: parsed.data.title,
      content: parsed.data.content,
      pinned: parsed.data.pinned ?? false,
      createdById: req.user!.id,
    },
    include: { createdBy: { select: { studentId: true } } },
  });
  res.status(201).json(created);
});

router.patch("/:id", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = routeParamId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "잘못된 요청입니다." });
    return;
  }
  const existing = await prisma.announcement.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: "공지사항을 찾을 수 없습니다." });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않습니다." });
    return;
  }
  const data = parsed.data;
  const updated = await prisma.announcement.update({
    where: { id },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.content !== undefined && { content: data.content }),
      ...(data.pinned !== undefined && { pinned: data.pinned }),
    },
    include: { createdBy: { select: { studentId: true } } },
  });
  res.json(updated);
});

router.post(
  "/images",
  requireAuth,
  requireAdmin,
  imageUpload.single("image"),
  (req: AuthedRequest, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "이미지를 선택하세요." });
      return;
    }
    res.status(201).json({
      url: `/api/announcements/uploads/${file.filename}`,
      filename: file.filename,
    });
  }
);

router.delete("/:id", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = routeParamId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "잘못된 요청입니다." });
    return;
  }
  const existing = await prisma.announcement.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: "공지사항을 찾을 수 없습니다." });
    return;
  }
  await prisma.announcement.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
