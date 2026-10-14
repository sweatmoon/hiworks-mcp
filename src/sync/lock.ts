import { getPool } from '../db/client.js';

export const SYNC_LOCK_KEY = 'hiworks-mail-sync';

/**
 * PostgreSQL 세션 advisory lock 으로 같은 작업의 중복 실행을 막는다.
 * 잠금을 얻지 못하면 fn 을 실행하지 않고 { acquired:false } 를 돌려준다.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const client = await getPool().connect();
  let locked = false;
  try {
    const res = await client.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [key]);
    locked = Boolean(res.rows[0]?.ok);
    if (!locked) return { acquired: false };
    const result = await fn();
    return { acquired: true, result };
  } finally {
    if (locked) {
      try {
        await client.query('select pg_advisory_unlock(hashtext($1))', [key]);
      } catch {
        /* 연결이 끊긴 경우 잠금은 세션 종료와 함께 풀린다 */
      }
    }
    client.release();
  }
}
