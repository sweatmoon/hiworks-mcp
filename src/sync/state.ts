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
