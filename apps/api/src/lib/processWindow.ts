const SEOUL_TZ = "Asia/Seoul";

const ymdSeoulFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SEOUL_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 한국(서울) 기준 달력 날짜 YYYY-MM-DD */
export function todayYmdSeoul(now = new Date()): string {
  return ymdSeoulFormatter.format(now);
}

/** 임의 시각을 서울 달력 기준 YYYY-MM-DD로 */
export function dateToYmdSeoul(d: Date): string {
  return ymdSeoulFormatter.format(d);
}

/** 시작일·종료일이 비어 있으면 해당 구간 제한 없음. 날짜는 달력 기준 포함(inclusive). */
export function isWithinDateWindow(
  todayYmd: string,
  startDate: string | null | undefined,
  endDate: string | null | undefined
): boolean {
  if (startDate && startDate > todayYmd) return false;
  if (endDate && endDate < todayYmd) return false;
  return true;
}
