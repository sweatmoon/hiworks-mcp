const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Date 를 KST(+09:00) 기준 ISO 8601 문자열로 변환한다. 예: 2025-01-02T09:30:00+09:00 */
export function formatKST(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const d = new Date(date.getTime() + KST_OFFSET_MS);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+09:00`
  );
}

/**
 * 사용자가 넘긴 날짜 문자열을 Date 로 바꾼다.
 * - "2025-01-02" 처럼 날짜만 있으면 KST 자정으로 해석한다.
 *   endOfDay 가 true 면 그 날의 23:59:59.999 (KST) 로 해석한다.
 * - 시간대가 포함된 ISO 문자열은 그대로 해석한다.
 */
export function parseDateInput(input: string, endOfDay = false): Date {
  const trimmed = input.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const utcMidnight = Date.UTC(Number(y), Number(m) - 1, Number(d));
    const kstMidnight = utcMidnight - KST_OFFSET_MS;
    return new Date(endOfDay ? kstMidnight + 24 * 60 * 60 * 1000 - 1 : kstMidnight);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`날짜 형식을 해석할 수 없습니다: "${input}" (예: 2025-01-02 또는 2025-01-02T09:00:00+09:00)`);
  }
  return parsed;
}
