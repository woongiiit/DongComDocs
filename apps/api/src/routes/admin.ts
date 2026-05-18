import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

/**
 * 관리자 페이지 대시보드용 서비스 이용률 집계.
 * 모델 호출 수는 별도 로그 테이블이 없어, 다음 두 지표를 프록시로 사용한다:
 *  - reanalysisRunsCount: 재분석 실행(버튼 1회 = 1 run) 누적 횟수
 *  - modelCallProxyCount: 분류/추출 결과 행 수 (파일 1개당 LLM 호출 1회로 가정)
 */
router.get("/stats", requireAuth, requireAdmin, async (_req: AuthedRequest, res) => {
  const [
    processCount,
    activeProcessCount,
    submissionCount,
    userCount,
    adminCount,
    reanalysisRunsCount,
    modelCallProxyCount,
    announcementCount,
    submissionStatusGroups,
    perProcessSubmissions,
  ] = await Promise.all([
    prisma.process.count(),
    prisma.process.count({ where: { active: true } }),
    prisma.submission.count(),
    prisma.user.count(),
    prisma.user.count({ where: { role: "ADMIN" } }),
    prisma.processReanalysisRun.count(),
    prisma.submissionFileDocTypeResult.count(),
    prisma.announcement.count(),
    prisma.submission.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    prisma.submission.groupBy({
      by: ["processId"],
      _count: { _all: true },
    }),
  ]);

  const processIds = perProcessSubmissions.map((g) => g.processId);
  const processes = processIds.length
    ? await prisma.process.findMany({
        where: { id: { in: processIds } },
        select: { id: true, title: true, active: true, createdAt: true },
      })
    : [];
  const processById = new Map(processes.map((p) => [p.id, p]));

  const submissionsPerProcess = perProcessSubmissions
    .map((g) => ({
      processId: g.processId,
      title: processById.get(g.processId)?.title ?? "(삭제됨)",
      active: processById.get(g.processId)?.active ?? false,
      submissionsCount: g._count._all,
    }))
    .sort((a, b) => b.submissionsCount - a.submissionsCount);

  const statusCounts: Record<string, number> = {};
  for (const g of submissionStatusGroups) statusCounts[g.status] = g._count._all;

  res.json({
    processCount,
    activeProcessCount,
    submissionCount,
    userCount,
    adminCount,
    studentCount: userCount - adminCount,
    reanalysisRunsCount,
    modelCallProxyCount,
    announcementCount,
    statusCounts,
    submissionsPerProcess,
  });
});

export default router;
