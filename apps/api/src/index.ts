import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { getVllmPdfRenderOptions, getVllmTemplateRenderScale, isVllmTunnelBaseUrl } from "./lib/reanalysis.js";

/** `npm run dev:api`를 모노레포 루트에서 실행해도 apps/api/.env가 항상 로드되도록 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env");
const envResult = dotenv.config({ path: envPath });
if (!fs.existsSync(envPath)) {
  console.warn(`[dotenv] 파일 없음: ${envPath}`);
} else if (envResult.error) {
  console.warn(`[dotenv] 로드 실패 (${envPath}):`, envResult.error.message);
} else {
  console.info(`[dotenv] loaded ${envPath}`);
}

import authRoutes from "./routes/auth.js";
import processRoutes from "./routes/processes.js";
import submissionRoutes from "./routes/submissions.js";
import announcementRoutes from "./routes/announcements.js";
import adminRoutes from "./routes/admin.js";

const PORT = Number(process.env.PORT) || 4000;
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
const ANNOUNCEMENT_UPLOAD_ROOT = path.join(UPLOAD_ROOT, "announcements");
if (!fs.existsSync(ANNOUNCEMENT_UPLOAD_ROOT)) fs.mkdirSync(ANNOUNCEMENT_UPLOAD_ROOT, { recursive: true });

const app = express();
app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()) ?? true,
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRoutes);
app.use("/api/processes", processRoutes);
app.use("/api/submissions", submissionRoutes);
app.use("/api/announcements/uploads", express.static(ANNOUNCEMENT_UPLOAD_ROOT));
app.use("/api/announcements", announcementRoutes);
app.use("/api/admin", adminRoutes);

app.listen(PORT, () => {
  const vllmPdf = getVllmPdfRenderOptions();
  console.log(`API listening on http://localhost:${PORT}`);
  const vllmBase = (process.env.VLLM_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");
  console.info("[env] vllm pdf render", vllmPdf, {
    VLLM_RENDER_SCALE: process.env.VLLM_RENDER_SCALE ?? "(unset)",
    VLLM_MAX_PDF_PAGES: process.env.VLLM_MAX_PDF_PAGES ?? "(unset)",
    VLLM_TEMPLATE_RENDER_SCALE: process.env.VLLM_TEMPLATE_RENDER_SCALE ?? getVllmTemplateRenderScale(),
    VLLM_BASE_URL: vllmBase,
    vllm_tunnel: isVllmTunnelBaseUrl(vllmBase),
  });
});
