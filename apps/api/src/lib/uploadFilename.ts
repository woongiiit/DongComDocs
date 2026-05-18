/**
 * Multer(내부 busboy)가 multipart `filename` UTF-8 바이트를 Latin-1 문자열로 잘못 올리는 경우가 많아
 * 한글 파일명이 `ë³µì§€...` 형태로 깨짐. 이미 정상 한글이면 그대로 둠.
 */
export function decodeMultipartFilename(name: string): string {
  if (!name) return name;
  if (/[\uAC00-\uD7A3]/.test(name)) return name;

  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    if (decoded.includes("\uFFFD")) return name;
    return decoded;
  } catch {
    return name;
  }
}
