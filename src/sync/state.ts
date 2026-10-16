import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { emailSyncState, syncRuns } from '../db/schema.js';

export type SyncSource = 'pop3' | 'import' | 'webmail';

export interface RunOutcome {
  newCount: number;
  skippedCount: number;
  lastUid?: string | null;
  details?: Record<string, unknown>;
}

const MAX_BACKOFF_MS = 2 * 60 * 60 * 1000;

export function backoffMs(failures: number, baseMs: number): number {
  return Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.max(0, failures - 1));
}

export async function getSyncState(db: Db, source: SyncSource) {
  const rows = await db.select().from(emailSyncState).where(eq(emailSyncState.source, source)).limit(1);
  return rows[0] ?? null;
}

export async function listSyncStates(db: Db) {
  return db.select().from(emailSyncState).orderBy(emailSyncState.source);
}

export async function recentRuns(db: Db, limit = 10) {
  return db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(limit);
}

/** 동기화 1회를 상태 테이블과 실행 기록에 반영하면서 실행한다. */
export async function trackRun(
  db: Db,
  source: SyncSource,
  baseIntervalMs: number,
  fn: () => Promise<RunOutcome>
): Promise<RunOutcome & { ok: boolean; error?: string }> {
  const started = new Date();
  await db
    .insert(emailSyncState)
    .values({ source, status: 'running', lastSyncAt: started, updatedAt: started })
    .onConflictDoUpdate({
      target: emailSyncState.source,
      set: { status: 'running', lastSyncAt: started, updatedAt: started },
    });
  const [run] = await db.insert(syncRuns).values({ source, startedAt: started, status: 'running' }).returning({ id: syncRuns.id });

  try {
    const outcome = await fn();
    const now = new Date();
    await db
      .update(emailSyncState)
      .set({
        status: 'ok',
        lastSuccessAt: now,
        lastUid: outcome.lastUid ?? undefined,
        errorMessage: null,
        consecutiveFailures: 0,
        nextRetryAt: null,
        stats: { ...outcome.details, newCount: outcome.newCount, skippedCount: outcome.skippedCount },
        updatedAt: now,
      })
      .where(eq(emailSyncState.source, source));
    await db
      .update(syncRuns)
      .set({ finishedAt: now, status: 'ok', newCount: outcome.newCount, skippedCount: outcome.skippedCount, details: outcome.details ?? {} })
      .where(eq(syncRuns.id, run.id));
    return { ...outcome, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const now = new Date();
    const prev = await getSyncState(db, source);
    const failures = (prev?.consecutiveFailures ?? 0) + 1;
    await db
      .update(emailSyncState)
      .set({
        status: 'error',
        errorMessage: message.slice(0, 2000),
        consecutiveFailures: failures,
        nextRetryAt: new Date(now.getTime() + backoffMs(failures, baseIntervalMs)),
        updatedAt: now,
      })
      .where(eq(emailSyncState.source, source));
    await db.update(syncRuns).set({ finishedAt: now, status: 'error', errorMessage: message.slice(0, 2000) }).where(eq(syncRuns.id, run.id));
    return { newCount: 0, skippedCount: 0, ok: false, error: message };
  }
}

/**
 * 프로세스가 재시작되면서 끝맺지 못한 실행 기록을 정리한다.
 * 호출자는 동기화 잠금을 쥔 상태여야 한다 (다른 프로세스가 실제로 실행 중인 경우를 배제).
 */
export async function closeInterruptedRuns(db: Db): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(syncRuns)
    .set({ status: 'error', finishedAt: now, errorMessage: '프로세스 재시작으로 중단됨 (다음 주기에 이어서 진행)' })
    .where(eq(syncRuns.status, 'running'))
    .returning({ id: syncRuns.id });
  if (rows.length) {
    await db.update(emailSyncState).set({ status: 'idle', updatedAt: now }).where(eq(emailSyncState.status, 'running'));
  }
  return rows.length;
}

/** 동기화 진행 중 심박. 잠금 보유자가 살아 있음을 알린다 (updated_at 갱신). */
export async function heartbeat(db: Db, source: SyncSource): Promise<void> {
  await db.update(emailSyncState).set({ updatedAt: new Date() }).where(eq(emailSyncState.source, source));
}
