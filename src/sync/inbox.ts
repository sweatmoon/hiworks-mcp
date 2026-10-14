import type { Db } from '../db/client.js';
import { log, type Credentials } from '../config.js';
import { Pop3Session } from '../services/pop3.js';
import { insertEmail, knownSourceUids, prepareEmail } from './store.js';
import type { RunOutcome } from './state.js';

export interface InboxSyncOptions {
  /** 한 번에 내려받을 최대 메일 수 (오래된 것부터) */
  batchSize: number;
  selfEmail: string;
}

/**
 * POP3 받은편지함 증분 동기화.
 * UIDL 로 서버의 모든 UID 를 받아 DB 에 없는 것만 RETR 한다. 서버가 메일을 지워도 DB 는 유지된다.
 * 발신자가 본인이면(숨은참조로 자기에게 보낸 사본) direction=sent 로 저장한다.
 */
export async function syncInbox(db: Db, creds: Credentials, opts: InboxSyncOptions): Promise<RunOutcome> {
  const session = new Pop3Session(creds);
  try {
    const refs = await session.list();
    const known = await knownSourceUids(
      db,
      'pop3',
      refs.map((r) => r.uid)
    );
    const pending = refs.filter((r) => !known.has(r.uid)); // msgNum 오름차순 = 오래된 것부터
    const batch = pending.slice(0, opts.batchSize);

    let newCount = 0;
    let skippedCount = 0;
    let failed = 0;
    let lastUid: string | null = null;
    for (const ref of batch) {
      try {
        const parsed = await session.retrieve(ref.msgNum);
        const prepared = prepareEmail(parsed, {
          source: 'pop3',
          sourceUid: ref.uid,
          selfEmail: opts.selfEmail,
          sizeBytes: ref.size,
          receivedAt: new Date(),
        });
        const result = await insertEmail(db, prepared);
        if (result.inserted) newCount++;
        else skippedCount++;
        lastUid = ref.uid;
      } catch (err) {
        failed++;
        log(`RETR ${ref.msgNum} failed:`, err instanceof Error ? err.message : err);
        if (failed >= 5) throw new Error(`메일 ${failed}건 연속 수신 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return {
      newCount,
      skippedCount,
      lastUid,
      details: { serverTotal: refs.length, pendingBefore: pending.length, processed: batch.length, failed, remaining: pending.length - batch.length },
    };
  } finally {
    await session.close();
  }
}
