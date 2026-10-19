import type { Db } from '../db/client.js';
import { log, serviceConfig } from '../config.js';
import { currentAccount } from '../account.js';
import { syncInbox } from './inbox.js';
import { breakStaleLock, syncLockKey, withAdvisoryLock } from './lock.js';
import { getSyncState, trackRun, type SyncSource } from './state.js';
import { syncSentFromWebmail } from './sent/webmail.js';

/** 심박(updated_at)이 이보다 오래 끊긴 잠금은 죽은 프로세스의 것으로 보고 끊는다 */
const STALE_LOCK_MS = Number(process.env['SYNC_STALE_LOCK_MINUTES'] || 15) * 60 * 1000;

export interface SyncSummary {
  acquired: boolean;
  /** 죽은 프로세스의 잠금을 끊고 진행했는지 */
  brokeStaleLock?: boolean;
  results: Array<{ source: SyncSource; ok: boolean; newCount: number; skippedCount: number; remaining?: number; error?: string; skippedReason?: string }>;
}

/**
 * 지금 계정(withAccount 문맥)의 모든 수집원을 한 번 동기화한다. advisory lock 으로 Worker 와 MCP 서버의 동시 실행을 막는다.
 * 직전 실패로 백오프 중인 수집원은 force 가 아니면 건너뛴다.
 */
export async function runSync(db: Db, opts: { sources?: SyncSource[]; force?: boolean } = {}): Promise<SyncSummary> {
  const sources: SyncSource[] = opts.sources ?? ['pop3', ...(serviceConfig.sentSyncMode === 'webmail' ? (['webmail'] as const) : [])];
  const baseIntervalMs = serviceConfig.syncIntervalMinutes * 60 * 1000;

  const account = currentAccount();
  const lockKey = syncLockKey();
  const run = () => withAdvisoryLock(lockKey, async () => {
    const results: SyncSummary['results'] = [];
    for (const source of sources) {
      if (!opts.force) {
        const state = await getSyncState(db, source);
        if (state?.nextRetryAt && state.nextRetryAt.getTime() > Date.now()) {
          results.push({ source, ok: false, newCount: 0, skippedCount: 0, skippedReason: `백오프 중 (다음 재시도 ${state.nextRetryAt.toISOString()})` });
          continue;
        }
      }
      const outcome = await trackRun(db, source, baseIntervalMs, async () => {
        if (source === 'pop3') {
          if (!account.username || !account.password) throw new Error(`계정 ${account.key}: 하이웍스 주소·비밀번호가 설정되지 않았습니다`);
          return syncInbox(db, { username: account.username, password: account.password }, { batchSize: serviceConfig.syncBatchSize, selfEmail: account.username.toLowerCase() });
        }
        if (source === 'webmail') {
          return syncSentFromWebmail(db);
        }
        throw new Error(`자동 동기화를 지원하지 않는 수집원: ${source} (import 는 /import 또는 import_emails 로 올립니다)`);
      });
      log(`sync ${account.key}/${source}:`, outcome.ok ? `+${outcome.newCount} (skip ${outcome.skippedCount})` : `error ${outcome.error}`);
      const entry: SyncSummary['results'][number] = { source, ok: outcome.ok, newCount: outcome.newCount, skippedCount: outcome.skippedCount };
      const remaining = Number((outcome.details as Record<string, unknown> | undefined)?.['remaining'] ?? 0);
      if (remaining > 0) entry.remaining = remaining;
      if (outcome.error) entry.error = outcome.error;
      results.push(entry);
    }
    return results;
  });

  let locked = await run();
  let brokeStaleLock = false;
  if (!locked.acquired) {
    // 잠금 보유자가 심박 없이 오래됐으면 죽은 것으로 보고 끊은 뒤 한 번 더 시도한다.
    const states = await Promise.all(sources.map((s) => getSyncState(db, s)));
    const newest = states.reduce<number>((m, s) => Math.max(m, s?.updatedAt?.getTime() ?? 0), 0);
    if (newest > 0 && Date.now() - newest > STALE_LOCK_MS) {
      if (await breakStaleLock(lockKey)) {
        brokeStaleLock = true;
        log('stale sync lock broken');
        // 종료 신호가 반영돼 잠금이 풀릴 때까지 잠시 기다리며 재시도
        for (let attempt = 0; attempt < 10 && !locked.acquired; attempt++) {
          await new Promise((r) => setTimeout(r, 500));
          locked = await run();
        }
      }
    }
  }

  if (!locked.acquired) return { acquired: false, results: [] };
  return { acquired: true, results: locked.result, brokeStaleLock };
}
