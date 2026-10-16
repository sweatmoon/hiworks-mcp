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

/**
 * 잠금을 쥔 세션의 PID 를 찾는다 (bigint advisory lock: classid=상위 32비트, objid=하위 32비트).
 */
export async function lockHolderPid(key: string): Promise<number | null> {
  const res = await getPool().query<{ pid: number }>(
    `select l.pid from pg_locks l
      where l.locktype = 'advisory' and l.granted and l.objsubid = 1
        and l.classid = ((hashtext($1)::bigint >> 32) & 4294967295)
        and l.objid = (hashtext($1)::bigint & 4294967295)
        and l.pid <> pg_backend_pid()
      limit 1`,
    [key]
  );
  return res.rows[0]?.pid ?? null;
}

/** 죽은 프로세스가 남긴 잠금을 끊는다. 심박이 오래 끊겼을 때만 호출할 것. */
export async function breakStaleLock(key: string): Promise<boolean> {
  const pid = await lockHolderPid(key);
  if (!pid) return false;
  const res = await getPool().query<{ ok: boolean }>('select pg_terminate_backend($1) as ok', [pid]);
  return Boolean(res.rows[0]?.ok);
}
