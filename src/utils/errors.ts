/**
 * 오류를 사람이 읽을 한 줄로.
 * drizzle 은 DB 오류를 "Failed query: <SQL> params: <값>" 으로 감싸고 진짜 원인(Postgres 오류)을 cause 에 둔다.
 * 그 메시지를 그대로 남기면 원인은 안 보이고 메일 본문(파라미터)만 상태 표·로그에 들어가므로,
 * SQL·파라미터는 버리고 cause 의 Postgres 메시지와 SQLSTATE 만 남긴다.
 */
export function describeError(err: unknown): string {
  const pg = findPgError(err);
  const top = err instanceof Error ? err.message : String(err);
  if (/^Failed query:/.test(top)) {
    return pg ? `DB 저장 실패: ${pg.message}${pg.code ? ` (SQLSTATE ${pg.code})` : ''}` : 'DB 저장 실패 (원인 미상)';
  }
  return top;
}

/** cause 사슬에서 Postgres 오류(code 가 5자리 SQLSTATE)를 찾는다 */
export function findPgError(err: unknown): { message: string; code?: string } | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const e = cur as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return { message: String(e.message ?? ''), code: e.code };
    cur = e.cause;
  }
  return null;
}

/**
 * 메일 내용 때문에 생긴 DB 오류인가 (같은 메일을 다시 넣어도 또 실패하는 오류).
 * 22 데이터 예외(잘못된 바이트·문자열 길이 등) · 23 무결성 위반 · 54 한도 초과(색인 행 크기 등).
 * 연결 끊김·시간 초과 같은 일시 오류는 false — 그 메일을 실패로 굳히지 않고 이번 실행을 멈춘다.
 */
export function isDataError(err: unknown): boolean {
  const code = findPgError(err)?.code;
  return Boolean(code && /^(22|23|54)/.test(code));
}
