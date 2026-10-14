import { simpleParser } from 'mailparser';
import { unzipSync } from 'fflate';
import type { Db } from '../db/client.js';
import { log } from '../config.js';
import { insertEmail, prepareEmail, type Direction } from './store.js';
import type { RunOutcome } from './state.js';

export interface ImportOptions {
  /** 지정하지 않으면 발신자 = 본인 여부로 추정 */
  direction?: Direction;
  selfEmail?: string;
  source?: string;
  filename?: string;
}

export interface ImportResult extends RunOutcome {
  files: number;
  failed: number;
  errors: string[];
}

function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05) && (buf[3] === 0x04 || buf[3] === 0x06);
}

function isMbox(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString('latin1') === 'From ';
}

/** mbox 를 개별 메시지로 나눈다 ("From " 구분선 기준, ">From " 이스케이프 복원). */
export function splitMbox(buf: Buffer): Buffer[] {
  const text = buf.toString('latin1');
  const parts = text.split(/^From .*\r?\n/m).filter((p) => p.trim().length > 0);
  return parts.map((p) => Buffer.from(p.replace(/^>From /gm, 'From '), 'latin1'));
}

/** 하나의 파일(zip/eml/mbox) 버퍼에서 메시지 버퍼 목록을 뽑는다. */
export function extractMessages(buf: Buffer, filename = ''): Array<{ name: string; data: Buffer }> {
  if (isZip(buf)) {
    const entries = unzipSync(new Uint8Array(buf));
    const out: Array<{ name: string; data: Buffer }> = [];
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('/') || data.length === 0) continue;
      const inner = Buffer.from(data);
      if (isZip(inner) || /\.(eml|mbox)$/i.test(name) || !/\.[a-z0-9]{1,5}$/i.test(name)) {
        out.push(...extractMessages(inner, name));
      }
    }
    return out;
  }
  if (isMbox(buf) || /\.mbox$/i.test(filename)) {
    return splitMbox(buf).map((data, i) => ({ name: `${filename || 'mbox'}#${i + 1}`, data }));
  }
  return [{ name: filename || 'message.eml', data: buf }];
}

/** 백업/내보내기 파일을 DB 로 가져온다. 중복(Message-ID 또는 지문)은 건너뛴다. */
export async function importMessages(db: Db, buf: Buffer, opts: ImportOptions = {}): Promise<ImportResult> {
  const messages = extractMessages(buf, opts.filename);
  let newCount = 0;
  let skippedCount = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const m of messages) {
    try {
      const parsed = await simpleParser(m.data);
      if (!parsed.subject && !parsed.from && !parsed.text && !parsed.html) {
        skippedCount++;
        continue;
      }
      const prepared = prepareEmail(parsed, {
        source: opts.source || 'import',
        direction: opts.direction,
        selfEmail: opts.selfEmail,
        sizeBytes: m.data.length,
      });
      const r = await insertEmail(db, prepared);
      if (r.inserted) newCount++;
      else skippedCount++;
    } catch (err) {
      failed++;
      const msg = `${m.name}: ${err instanceof Error ? err.message : String(err)}`;
      if (errors.length < 20) errors.push(msg);
      log('import failed:', msg);
    }
  }
  return { newCount, skippedCount, files: messages.length, failed, errors, details: { files: messages.length, failed } };
}
