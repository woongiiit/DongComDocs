import jwt from "jsonwebtoken";

function getJwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is required");
  return s;
}

export type JwtPayload = {
  sub: string;
  studentId: string;
  role: "STUDENT" | "ADMIN";
};

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: "30m" });
}

export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, getJwtSecret());
  return decoded as JwtPayload;
}
