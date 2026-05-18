import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { signToken } from "../lib/jwt.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const BCRYPT_ROUNDS = 10;

function parseAdminIds(): Set<string> {
  const raw = (process.env.ADMIN_ID ?? "").trim();
  if (!raw) return new Set();

  const parts = raw.split(",").map((s) => {
    let id = s.trim();
    if ((id.startsWith('"') && id.endsWith('"')) || (id.startsWith("'") && id.endsWith("'"))) {
      id = id.slice(1, -1).trim();
    }
    return id;
  });

  return new Set(parts.filter(Boolean));
}

const loginSchema = z.object({
  studentId: z.string().min(1).max(32),
  password: z.string().min(1).max(200),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "학번과 비밀번호를 입력하세요." });
    return;
  }

  const studentId = parsed.data.studentId.trim();
  const password = parsed.data.password;
  const adminIds = parseAdminIds();
  const roleFromEnv = adminIds.has(studentId) ? "ADMIN" : "STUDENT";

  const existing = await prisma.user.findUnique({ where: { studentId } });

  if (!existing) {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await prisma.user.create({
      data: {
        studentId,
        passwordHash,
        role: roleFromEnv,
      },
    });
    const token = signToken({
      sub: user.id,
      studentId: user.studentId,
      role: user.role,
    });
    res.json({
      token,
      user: { id: user.id, studentId: user.studentId, role: user.role },
    });
    return;
  }

  const ok = await bcrypt.compare(password, existing.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "학번 또는 비밀번호가 올바르지 않습니다." });
    return;
  }

  const user = await prisma.user.update({
    where: { id: existing.id },
    data: { role: roleFromEnv },
  });

  const token = signToken({
    sub: user.id,
    studentId: user.studentId,
    role: user.role,
  });

  res.json({
    token,
    user: { id: user.id, studentId: user.studentId, role: user.role },
  });
});

router.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { id: true, studentId: true, role: true, createdAt: true },
  });
  if (!user) {
    res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
    return;
  }
  res.json(user);
});

router.post("/refresh", requireAuth, async (req: AuthedRequest, res) => {
  const token = signToken({
    sub: req.user!.id,
    studentId: req.user!.studentId,
    role: req.user!.role,
  });
  res.json({ token });
});

export default router;
