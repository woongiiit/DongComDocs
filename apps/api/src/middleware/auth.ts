import type { Request, Response, NextFunction } from "express";
import { verifyToken, type JwtPayload } from "../lib/jwt.js";
import { prisma } from "../lib/prisma.js";

export type AuthedRequest = Request & { user?: JwtPayload & { id: string } };

export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "인증이 필요합니다." });
    return;
  }
  try {
    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      res.status(401).json({ error: "사용자를 찾을 수 없습니다." });
      return;
    }
    req.user = {
      id: user.id,
      sub: user.id,
      studentId: user.studentId,
      role: user.role,
    };
    next();
  } catch {
    res.status(401).json({ error: "유효하지 않은 토큰입니다." });
  }
}

export function requireAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.user?.role !== "ADMIN") {
    res.status(403).json({ error: "관리자만 접근할 수 있습니다." });
    return;
  }
  next();
}
