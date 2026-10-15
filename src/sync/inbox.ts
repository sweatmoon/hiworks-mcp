import type { Db } from '../db/client.js';
import { log, type Credentials } from '../config.js';
import { Pop3Session } from '../services/pop3.js';
import { fingerprint, insertEmail, knownSourceUids, prepareEmail, type PreparedEmail } from './store.js';
import type { RunOutcome } from './state.js';

/** 한 통을 내려받는 데 허용하는 최대 시간. 넘기면 실패로 기록하고 다음 메일로 넘어간다 (세션은 새로 연다). */
const RETR_TIMEOUT_MS = Number(process.env['SYNC_RETR_TIMEOUT_MS'] || 180000);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: ${ms}ms 초과`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** 가져오기에 실패한 메일 자리에 남기는 표시 행. 다음 실행에서 같은 메일을 다시 시도하지 않도록 uid 를 기억한다. */
function failedStub(uid: string, size: number | undefined, reason: string): PreparedEmail {
  return {
    row: {
      messageId: null,
      dedupKey: `fail:${fingerprint(['pop3', uid])}`,
      direction: 'received',
      source: 'pop3',
      sourceUid: uid,
      sender: '',
      senderEmail: '',
      recipients: [],
      recipientEmails: [],
      subject: '(가져오기 실패)',
      bodyText: `POP3 에서 이 메일을 가져오지 못했습니다: ${reason}`,
      bodyHtml: null,
      sentAt: null,
      receivedAt: new Date(),
      hasAttachments: false,
      sizeBytes: size ?? null,
      threadKey: '',
      inReplyTo: null,
      references: [],
      projectName: null,
    },
    attachments: [],
  };
}

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
    // 최신 메일부터 가져온다 (업무 보조에는 최근 메일이 먼저 필요). 과거분은 뒤따라 채워진다.
    const pending = refs.filter((r) => !known.has(r.uid)).reverse();
    const batch = pending.slice(0, opts.batchSize);

    let newCount = 0;
    let skippedCount = 0;
    let failed = 0;
    let lastUid: string | null = null;
    for (const [i, ref] of batch.entries()) {
      if (i > 0 && i % 50 === 0) console.error(`  sync progress ${i}/${batch.length} (남음 ${pending.length - i})`);
      try {
        const parsed = await withTimeout(session.retrieve(ref.msgNum), RETR_TIMEOUT_MS, `RETR ${ref.msgNum} (${ref.size ?? '?'} bytes)`);
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
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`RETR ${ref.msgNum} failed: ${reason}`);
        if (/초과/.test(reason)) {
          // 타임아웃이면 소켓 상태를 믿을 수 없으므로 표시 행만 남기고 이번 실행을 끝낸다. 다음 실행은 새 세션으로 이어진다.
          await insertEmail(db, failedStub(ref.uid, ref.size, reason));
          break;
        }
        if (failed >= 5) throw new Error(`메일 ${failed}건 연속 수신 실패: ${reason}`);
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
