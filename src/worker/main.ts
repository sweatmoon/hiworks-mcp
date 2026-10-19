#!/usr/bin/env node
/**
 * Mail Worker: 주기적으로 하이웍스 메일을 동기화한다.
 *  - WORKER_MODE=loop (기본): SYNC_INTERVAL_MINUTES 마다 실행, /health 제공
 *  - WORKER_MODE=once: 한 번 실행 후 종료 (Railway cron 스케줄용)
 */
import http from 'http';
import { sql } from 'drizzle-orm';
import { PACKAGE_VERSION, log, serviceConfig } from '../config.js';
import { closeDb, getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { emails } from '../db/schema.js';
import { listAccounts, withAccount, type Account } from '../account.js';
import { runSync, type SyncSummary } from '../sync/runner.js';
import { closeInterruptedRuns, listSyncStates } from '../sync/state.js';
import { syncLockKey, withAdvisoryLock } from '../sync/lock.js';
import { formatKST } from '../utils/date.js';

let lastSummary: Record<string, SyncSummary> = {};
let lastRunAt: Date | null = null;
let running = false;
let catchUpTimer: NodeJS.Timeout | null = null;

/** 동기화할 계정들. 접속을 받지 않으므로 토큰은 없어도 된다 */
function syncAccounts(): Account[] {
  return listAccounts(process.env, { requireToken: false });
}

function describe(summary: SyncSummary): string {
  if (!summary.acquired) return 'skipped (lock held)';
  return summary.results.map((r) => `${r.source}:${r.ok ? `+${r.newCount}${r.remaining ? ` (남음 ${r.remaining})` : ''}` : r.skippedReason ? 'backoff' : 'ERR'}`).join(' ');
}

/** 백필 중(남은 메일이 있음)이면 주기를 기다리지 않고 잠시 후 바로 이어서 가져온다. */
const CATCH_UP_DELAY_MS = 3000;

async function applyRetention(): Promise<number> {
  const days = serviceConfig.retentionDays;
  if (days <= 0) return 0;
  const db = getDb();
  const result = await db.execute(sql`delete from ${emails} where coalesce(${emails.sentAt}, ${emails.receivedAt}, ${emails.createdAt}) < now() - make_interval(days => ${days})`);
  return result.rowCount ?? 0;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // 계정마다 차례로 동기화한다. 한 계정이 실패해도 다른 계정은 계속한다.
    const summaries: Record<string, SyncSummary> = {};
    for (const account of syncAccounts()) {
      try {
        summaries[account.key] = await withAccount(account, () => runSync(getDb()));
      } catch (err) {
        console.error(`sync ${account.key} failed:`, err instanceof Error ? err.message : err);
      }
    }
    lastSummary = summaries;
    lastRunAt = new Date();
    const deleted = await applyRetention();
    if (deleted) console.error(`retention: ${deleted}건 삭제`);
    console.error(`[${formatKST(lastRunAt)}] sync ${Object.entries(summaries).map(([key, s]) => `${key}[${describe(s)}]`).join(' ') || '(계정 없음)'}`);
    const remaining = Object.values(summaries).some((s) => s.results.some((r) => r.ok && (r.remaining ?? 0) > 0));
    if (remaining && process.env['WORKER_MODE'] !== 'once') {
      if (catchUpTimer) clearTimeout(catchUpTimer);
      catchUpTimer = setTimeout(() => void tick(), CATCH_UP_DELAY_MS);
    }
  } catch (err) {
    console.error('worker tick failed:', err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

function startHealthServer(): http.Server {
  const server = http.createServer(async (_req, res) => {
    try {
      await getDb().execute(sql`select 1`);
      const accounts: Record<string, unknown> = {};
      let stale = false;
      for (const account of syncAccounts()) {
        const states = await withAccount(account, () => listSyncStates(getDb()));
        if (states.some((s) => s.status === 'error' && s.consecutiveFailures >= 5)) stale = true;
        accounts[account.key] = states.map((s) => ({ source: s.source, status: s.status, lastSuccessAt: s.lastSuccessAt, failures: s.consecutiveFailures, error: s.errorMessage }));
      }
      res.writeHead(stale ? 503 : 200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: !stale,
          service: 'mail-worker',
          version: PACKAGE_VERSION,
          lastRunAt: lastRunAt ? formatKST(lastRunAt) : null,
          lastSummary,
          accounts,
        })
      );
    } catch (err) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  });
  server.listen(serviceConfig.port, () => console.error(`worker health on :${serviceConfig.port}`));
  return server;
}

async function main(): Promise<void> {
  await runMigrations();
  // 이전 컨테이너가 끝맺지 못한 실행 기록 정리 (다른 프로세스가 동기화 중이면 잠금 때문에 건너뜀)
  const accounts = syncAccounts();
  for (const account of accounts) {
    const cleaned = await withAccount(account, () => withAdvisoryLock(syncLockKey(), () => closeInterruptedRuns(getDb())));
    if (cleaned.acquired && cleaned.result > 0) console.error(`${account.key}: 중단된 실행 기록 ${cleaned.result}건 정리`);
  }
  const mode = process.env['WORKER_MODE'] === 'once' ? 'once' : 'loop';
  console.error(`mail worker ${PACKAGE_VERSION} mode=${mode} accounts=${accounts.map((a) => a.key).join(',') || '(없음)'} interval=${serviceConfig.syncIntervalMinutes}m sentSync=${serviceConfig.sentSyncMode}`);
  if (mode === 'once') {
    await tick();
    await closeDb();
    return;
  }
  const health = startHealthServer();
  await tick();
  const timer = setInterval(() => void tick(), serviceConfig.syncIntervalMinutes * 60 * 1000);
  const shutdown = () => {
    clearInterval(timer);
    if (catchUpTimer) clearTimeout(catchUpTimer);
    health.close();
    void closeDb().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log('fatal:', err);
  console.error('fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
