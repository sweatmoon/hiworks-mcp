import type { Db } from '../db/client.js';
import { log, resolveCredentials, serviceConfig } from '../config.js';
import { syncInbox } from './inbox.js';
import { SYNC_LOCK_KEY, withAdvisoryLock } from './lock.js';
import { getSyncState, trackRun, type SyncSource } from './state.js';
import { syncSentFromWebmail } from './sent/webmail.js';

export interface SyncSummary {
  acquired: boolean;
  results: Array<{ source: SyncSource; ok: boolean; newCount: number; skippedCount: number; error?: string; skippedReason?: string }>;
}

/**
 * 모든 수집원을 한 번 동기화한다. advisory lock 으로 Worker 와 MCP 서버의 동시 실행을 막는다.
 * 직전 실패로 백오프 중인 수집원은 force 가 아니면 건너뛴다.
 */
export async function runSync(db: Db, opts: { sources?: SyncSource[]; force?: boolean } = {}): Promise<SyncSummary> {
  const sources: SyncSource[] = opts.sources ?? ['pop3', ...(serviceConfig.sentSyncMode === 'webmail' ? (['webmail'] as const) : [])];
  const baseIntervalMs = serviceConfig.syncIntervalMinutes * 60 * 1000;

  const locked = await withAdvisoryLock(SYNC_LOCK_KEY, async () => {
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
          const creds = resolveCredentials();
          return syncInbox(db, creds, { batchSize: serviceConfig.syncBatchSize, selfEmail: serviceConfig.selfEmail });
        }
        if (source === 'webmail') {
          return syncSentFromWebmail(db);
        }
        throw new Error(`자동 동기화를 지원하지 않는 수집원: ${source} (import 는 /import 또는 import_emails 로 올립니다)`);
      });
      log(`sync ${source}:`, outcome.ok ? `+${outcome.newCount} (skip ${outcome.skippedCount})` : `error ${outcome.error}`);
      const entry: SyncSummary['results'][number] = { source, ok: outcome.ok, newCount: outcome.newCount, skippedCount: outcome.skippedCount };
      if (outcome.error) entry.error = outcome.error;
      results.push(entry);
    }
    return results;
  });

  if (!locked.acquired) return { acquired: false, results: [] };
  return { acquired: true, results: locked.result };
}
