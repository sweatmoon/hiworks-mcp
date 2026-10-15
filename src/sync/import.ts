import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import type { Readable } from 'stream';
import { simpleParser } from 'mailparser';
import yauzl from 'yauzl';
import type { Db } from '../db/client.js';
import { log } from '../config.js';
import { insertEmail, prepareEmail, type Direction } from './store.js';
import type { RunOutcome } from './state.js';

export interface ImportProgress {
  files: number;
  newCount: number;
  skippedCount: number;
  failed: number;
}

export interface ImportOptions {
  /** 지정하지 않으면 발신자 = 본인 여부로 추정 */
  direction?: Direction;
  selfEmail?: string;
  source?: string;
  filename?: string;
  /** 메시지 하나를 처리할 때마다 호출 (진행 상황 보고용) */
  onProgress?: (p: ImportProgress) => void;
}

export interface ImportResult extends RunOutcome {
  files: number;
  failed: number;
  errors: string[];
}

/** ZIP 항목 하나의 최대 크기. 첨부가 큰 메일도 수십 MB 수준이므로 넉넉히 잡는다. */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

export function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05) && (buf[3] === 0x04 || buf[3] === 0x06);
}

function isMbox(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString('latin1') === 'From ';
}

/** RFC 822 헤더로 시작하는지 (확장자가 없거나 깨진 항목을 내용으로 판별) */
function looksLikeMessage(buf: Buffer): boolean {
  return /^[A-Za-z][A-Za-z0-9-]{0,40}:\s/.test(buf.subarray(0, 64).toString('latin1'));
}

/** mbox 를 개별 메시지로 나눈다 ("From " 구분선 기준, ">From " 이스케이프 복원). */
export function splitMbox(buf: Buffer): Buffer[] {
  const text = buf.toString('latin1');
  const parts = text.split(/^From .*\r?\n/m).filter((p) => p.trim().length > 0);
  return parts.map((p) => Buffer.from(p.replace(/^>From /gm, 'From '), 'latin1'));
}

/** ZIP 이 아닌 하나의 파일(eml/mbox) 버퍼에서 메시지 버퍼 목록을 뽑는다. */
export function extractMessages(buf: Buffer, filename = ''): Array<{ name: string; data: Buffer }> {
  if (isMbox(buf) || /\.mbox$/i.test(filename)) {
    return splitMbox(buf).map((data, i) => ({ name: `${filename || 'mbox'}#${i + 1}`, data }));
  }
  return [{ name: filename || 'message.eml', data: buf }];
}

/** ZIP 항목 이름 복원: UTF-8 이 아니면 CP949(EUC-KR) 로 시도한다 (하이웍스/알집 백업은 한글 파일명). */
export function decodeEntryName(raw: Buffer | string): string {
  if (typeof raw === 'string') return raw;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    try {
      return new TextDecoder('euc-kr').decode(raw);
    } catch {
      return raw.toString('latin1');
    }
  }
}

class ImportAccumulator {
  newCount = 0;
  skippedCount = 0;
  failed = 0;
  files = 0;
  errors: string[] = [];
  constructor(private readonly db: Db, private readonly opts: ImportOptions) {}

  progress(): ImportProgress {
    return { files: this.files, newCount: this.newCount, skippedCount: this.skippedCount, failed: this.failed };
  }

  fail(name: string, err: unknown): void {
    this.failed++;
    const msg = `${name}: ${err instanceof Error ? err.message : String(err)}`;
    if (this.errors.length < 20) this.errors.push(msg);
    log('import failed:', msg);
    this.opts.onProgress?.(this.progress());
  }

  /** 메시지 한 통(eml 버퍼)을 저장한다. */
  async message(name: string, data: Buffer): Promise<void> {
    this.files++;
    try {
      const parsed = await simpleParser(data);
      if (!parsed.subject && !parsed.from && !parsed.text && !parsed.html) {
        this.skippedCount++;
      } else {
        const prepared = prepareEmail(parsed, {
          source: this.opts.source || 'import',
          direction: this.opts.direction,
          selfEmail: this.opts.selfEmail,
          sizeBytes: data.length,
        });
        const r = await insertEmail(this.db, prepared);
        if (r.inserted) this.newCount++;
        else this.skippedCount++;
      }
      this.opts.onProgress?.(this.progress());
    } catch (err) {
      this.fail(name, err);
    }
  }

  /** ZIP 이 아닌 파일(eml/mbox) */
  async flat(name: string, data: Buffer): Promise<void> {
    for (const m of extractMessages(data, name)) await this.message(m.name, m.data);
  }

  /** 파일 하나(zip/eml/mbox)를 내용으로 판별해 처리한다. */
  async any(name: string, data: Buffer): Promise<void> {
    if (isZip(data)) {
      // 중첩 ZIP 은 임시 파일로 내려 스트리밍 처리한다 (메모리 상주 최소화)
      const tmp = tempPath('nested');
      try {
        await fs.promises.writeFile(tmp, data);
        await this.zipFile(tmp);
      } finally {
        await fs.promises.rm(tmp, { force: true });
      }
      return;
    }
    await this.flat(name, data);
  }

  async zipFile(filePath: string): Promise<void> {
    const zf = await yauzl.openPromise(filePath, { lazyEntries: true, decodeStrings: false });
    await this.walkZip(zf);
  }

  async zipBuffer(buf: Buffer): Promise<void> {
    const zf = await yauzl.fromBufferPromise(buf, { lazyEntries: true, decodeStrings: false });
    await this.walkZip(zf);
  }

  /** ZIP 항목을 하나씩 순서대로 읽어 처리한다. 항목 하나만 메모리에 올린다. */
  private walkZip(zf: yauzl.ZipFile): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: unknown): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      zf.on('error', done);
      zf.on('end', () => done());
      zf.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          const name = decodeEntryName(entry.fileName as unknown as Buffer | string);
          try {
            if (!name.endsWith('/') && entry.uncompressedSize > 0) {
              if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`항목이 너무 큽니다 (${entry.uncompressedSize} bytes)`);
              const data = await readAll(await zf.openReadStreamPromise(entry));
              if (isZip(data) || /\.(eml|mbox)$/i.test(name) || !/\.[a-z0-9]{1,5}$/i.test(name) || looksLikeMessage(data)) {
                await this.any(name, data);
              }
            }
          } catch (err) {
            this.fail(name, err);
          }
          zf.readEntry();
        })();
      });
      zf.readEntry();
    });
  }

  result(): ImportResult {
    return {
      newCount: this.newCount,
      skippedCount: this.skippedCount,
      files: this.files,
      failed: this.failed,
      errors: this.errors,
      details: { files: this.files, failed: this.failed },
    };
  }
}

function tempPath(tag: string): string {
  return path.join(os.tmpdir(), `hiworks-import-${tag}-${Date.now()}-${randomBytes(4).toString('hex')}`);
}

function readAll(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** 메모리 버퍼(작은 파일·MCP 도구 입력)를 가져온다. ZIP 이면 항목 단위로 스트리밍한다. */
export async function importMessages(db: Db, buf: Buffer, opts: ImportOptions = {}): Promise<ImportResult> {
  const acc = new ImportAccumulator(db, opts);
  if (isZip(buf)) await acc.zipBuffer(buf);
  else await acc.flat(opts.filename || '', buf);
  return acc.result();
}

/** 디스크의 파일(대용량 백업 ZIP 포함)을 가져온다. ZIP 은 전체를 메모리에 올리지 않는다. */
export async function importFile(db: Db, filePath: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const acc = new ImportAccumulator(db, { ...opts, filename: opts.filename || path.basename(filePath) });
  const head = Buffer.alloc(8);
  const fh = await fs.promises.open(filePath, 'r');
  try {
    await fh.read(head, 0, 8, 0);
  } finally {
    await fh.close();
  }
  if (isZip(head)) await acc.zipFile(filePath);
  else await acc.flat(opts.filename || path.basename(filePath), await fs.promises.readFile(filePath));
  return acc.result();
}
