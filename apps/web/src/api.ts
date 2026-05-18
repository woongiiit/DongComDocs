const TOKEN_KEY = "dongcomdocs_token";

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export function getApiBase(): string {
  return API_BASE;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export type UserRole = "STUDENT" | "ADMIN";

export type Me = {
  id: string;
  studentId: string;
  role: UserRole;
  createdAt: string;
};

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit & { json?: unknown } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body = options.body;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }

  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const res = await fetch(url, { ...options, headers, body });
  if (!res.ok) {
    const errBody = await parseJson<{ error?: string }>(res).catch(
      () => ({}) as { error?: string }
    );
    throw new Error(errBody.error ?? `요청 실패 (${res.status})`);
  }
  return parseJson<T>(res);
}

/** 멀티파트 업로드 후 규칙 실행(run-rules)까지 수행 */
export async function submitProcessFiles(
  processId: string,
  files: FileList | File[],
  fileSlots?: { fileIndex: number; slotIndex: number }[]
): Promise<{ submissionId: string; fileNames: string[] }> {
  const token = getToken();
  const base = getApiBase();
  const list = Array.isArray(files) ? files : Array.from(files);
  const fd = new FormData();
  fd.append("processId", processId);
  if (fileSlots) fd.append("fileSlots", JSON.stringify(fileSlots));
  for (const f of list) fd.append("files", f);

  const res = await fetch(`${base}/api/submissions`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const body = await res.json().catch(
    () => ({}) as { error?: string; id?: string; files?: { originalName: string }[] }
  );
  if (!res.ok) throw new Error(body.error ?? "업로드 실패");

  const fileNames = body.files?.map((f: { originalName: string }) => f.originalName) ?? [];

  const run = await fetch(`${base}/api/submissions/${body.id}/run-rules`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const runBody = await run.json().catch(() => ({} as { error?: string }));
  if (!run.ok) throw new Error(runBody.error ?? "규칙 처리 실패");

  return { submissionId: body.id!, fileNames };
}

/** 공지사항 본문에 삽입할 이미지를 업로드하고 절대 URL을 반환합니다. */
export async function uploadAnnouncementImage(file: File): Promise<string> {
  const token = getToken();
  const base = getApiBase();
  const fd = new FormData();
  fd.append("image", file);
  const res = await fetch(`${base}/api/announcements/images`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const body = await res.json().catch(() => ({} as { error?: string; url?: string }));
  if (!res.ok) throw new Error(body.error ?? "이미지 업로드 실패");
  if (!body.url) throw new Error("이미지 URL이 없습니다.");
  return `${base}${body.url}`;
}

/** 인증 후 제출 파일을 새 탭에서 엽니다(미리보기). */
export async function openSubmissionFileInNewTab(fileId: string): Promise<void> {
  const token = getToken();
  const base = getApiBase();
  const res = await fetch(`${base}/api/submissions/files/${fileId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(err.error ?? "파일을 불러오지 못했습니다.");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank", "noopener,noreferrer");
  if (!w) {
    URL.revokeObjectURL(url);
    throw new Error("팝업이 차단되었습니다.");
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

export type ProcessListItem = {
  id: string;
  title: string;
  description: string | null;
  active: boolean;
  /** YYYY-MM-DD, null이면 제한 없음 */
  startDate: string | null;
  endDate: string | null;
  rulesJson?: unknown;
  createdAt: string;
};

export type ProcessDetail = ProcessListItem & {
  rulesJson: unknown;
  createdById?: string;
};

export type Submission = {
  id: string;
  processId: string;
  userId: string;
  status: string;
  createdAt: string;
  process: { id: string; title: string };
  files: {
    id: string;
    originalName: string;
    mimeType: string | null;
    formSlotIndex?: number | null;
    formDocType?: string | null;
    createdAt: string;
  }[];
};

/** 관리자 제출 현황 API (`GET /api/processes/submission-overview`) */
export type ProcessSubmissionOverview = {
  id: string;
  title: string;
  description: string | null;
  active: boolean;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  submissionsCount: number;
  statusCounts: Record<string, number>;
};

export type AdminProcessSubmissionFile = {
  id: string;
  originalName: string;
  mimeType: string | null;
  formSlotIndex?: number | null;
  formDocType?: string | null;
  createdAt: string;
};

export type AdminProcessSubmission = {
  id: string;
  processId: string;
  userId: string;
  status: string;
  createdAt: string;
  user: { id: string; studentId: string };
  files: AdminProcessSubmissionFile[];
};

export type AdminProcessSubmissionsResponse = {
  process: Omit<ProcessDetail, "rulesJson" | "createdById">;
  submissions: AdminProcessSubmission[];
};

export type ProcessLayoutSchema = {
  docType: string;
  schemaJson: unknown;
  templateOriginalName?: string | null;
  analysisSummary?: string | null;
};

export type ReanalysisRun = {
  id: string;
  processId: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  createdAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  totalFiles?: number;
  processedFiles?: number;
  createdBy?: { studentId: string };
  _count?: { fileClassifications: number };
};

export type Announcement = {
  id: string;
  title: string;
  content: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: { studentId: string };
};

export type AdminStats = {
  processCount: number;
  activeProcessCount: number;
  submissionCount: number;
  userCount: number;
  adminCount: number;
  studentCount: number;
  reanalysisRunsCount: number;
  modelCallProxyCount: number;
  announcementCount: number;
  statusCounts: Record<string, number>;
  submissionsPerProcess: {
    processId: string;
    title: string;
    active: boolean;
    submissionsCount: number;
  }[];
};
