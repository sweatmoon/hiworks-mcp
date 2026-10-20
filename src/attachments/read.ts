import { and, asc, eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import type { Db } from '../db/client.js';
import { emailAttachments, emails } from '../db/schema.js';
import { currentAccount } from '../account.js';
import { withPop3 } from '../services/pop3.js';

/**
 * 첨부 읽기 (저장 없음).
 * 메일 DB 에는 첨부의 이름·크기만 있으므로, 요청이 오면 하이웍스 POP3 에서 그 메일 원본을 다시 받아
 * 첨부 하나의 텍스트만 꺼내 돌려준다. 원본·텍스트 모두 DB 나 디스크에 남기지 않고, 로그에도 내용을 쓰지 않는다.
 */

const MAX_MESSAGE_BYTES = Number(process.env['ATTACHMENT_MAX_MB'] || 60) * 1024 * 1024;
const RETR_TIMEOUT_MS = Number(process.env['ATTACHMENT_RETR_TIMEOUT_MS'] || 180000);
/** 압축을 풀었을 때 허용하는 최대 크기 (zip 폭탄 방지) */
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

export interface ReadAttachmentParams {
  emailId: number;
  /** read_email 결과 attachments[].id */
  attachmentId?: number;
  /** 첨부 순번 (0부터) */
  index?: number;
  /** 파일 이름 일부 */
  filename?: string;
  /** 텍스트에서 건너뛸 글자 수 (이어 읽기) */
  offset?: number;
  /** 돌려줄 최대 글자 수 */
  maxChars?: number;
}

export interface AttachmentListItem {
  index: number;
  id: number;
  filename: string;
  mimeType: string;
  fileSize: number;
}

export type ReadAttachmentResult =
  | {
      success: true;
      emailId: number;
      subject: string;
      attachment: { index: number; filename: string; mimeType: string; size: number };
      format: string;
      pages?: number;
      totalChars: number;
      offset: number;
      text: string;
      truncated: boolean;
      nextOffset: number | null;
    }
  | { success: false; error: string; attachments?: AttachmentListItem[] };

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: ${Math.round(ms / 1000)}초 안에 받지 못했습니다`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** XML 조각에서 문단(paraTag) 단위로 텍스트 태그(textTag) 내용을 모은다 */
function xmlParagraphs(xml: string, paraTag: string, textTag: string): string[] {
  const textRe = new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>|<${textTag}(?:\\s[^>]*)?/>|<[a-z]+:tab\\s*/>`, 'g');
  return xml
    .split(new RegExp(`</${paraTag}>`))
    .map((chunk) => {
      let line = '';
      for (const m of chunk.matchAll(textRe)) line += m[0].includes(':tab') ? '\t' : decodeEntities(m[1] ?? '');
      return line.trimEnd();
    })
    .filter((line) => line.trim() !== '');
}

function unzip(buf: Buffer, want: (name: string) => boolean): Record<string, Uint8Array> {
  let total = 0;
  return unzipSync(new Uint8Array(buf), {
    filter: (f) => {
      if (!want(f.name)) return false;
      total += f.originalSize;
      if (total > MAX_UNZIPPED_BYTES) throw new Error('압축을 푼 크기가 너무 큽니다');
      return true;
    },
  });
}

const utf8 = (u: Uint8Array) => Buffer.from(u).toString('utf8');
const numberIn = (name: string) => Number((name.match(/(\d+)\.xml$/) || [])[1] || 0);

function docxText(buf: Buffer): string {
  const files = unzip(buf, (n) => n === 'word/document.xml');
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('word/document.xml 이 없습니다');
  return xmlParagraphs(utf8(xml), 'w:p', 'w:t').join('\n');
}

function pptxText(buf: Buffer): { text: string; pages: number } {
  const files = unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const names = Object.keys(files).sort((a, b) => numberIn(a) - numberIn(b));
  const text = names.map((n, i) => `[슬라이드 ${i + 1}]\n${xmlParagraphs(utf8(files[n]!), 'a:p', 'a:t').join('\n')}`).join('\n\n');
  return { text, pages: names.length };
}

function hwpxText(buf: Buffer): { text: string; pages: number } {
  const files = unzip(buf, (n) => /^Contents\/section\d+\.xml$/.test(n));
  const names = Object.keys(files).sort((a, b) => numberIn(a) - numberIn(b));
  return { text: names.map((n) => xmlParagraphs(utf8(files[n]!), 'hp:p', 'hp:t').join('\n')).join('\n\n'), pages: names.length };
}

function xlsxText(buf: Buffer): { text: string; pages: number } {
  const files = unzip(buf, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = files['xl/sharedStrings.xml']
    ? utf8(files['xl/sharedStrings.xml']).split('</si>').slice(0, -1).map((si) => [...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1] ?? '')).join(''))
    : [];
  const sheets = Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort((a, b) => numberIn(a) - numberIn(b));
  const text = sheets
    .map((n, i) => {
      const rows = utf8(files[n]!).split('</row>').slice(0, -1).map((row) =>
        [...row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
          .map((c) => {
            const attrs = c[1] ?? '';
            const inner = c[2] ?? '';
            if (/\bt="s"/.test(attrs)) return shared[Number((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1])] ?? '';
            if (/\bt="inlineStr"/.test(attrs)) return [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1] ?? '')).join('');
            return decodeEntities((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] ?? '');
          })
          .join('\t')
          .trimEnd()
      ).filter((r) => r.trim() !== '');
      return `[시트 ${i + 1}]\n${rows.join('\n')}`;
    })
    .join('\n\n');
  return { text, pages: sheets.length };
}

async function pdfText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return { text: pages.map((t, i) => `[${i + 1}쪽]\n${t.trim()}`).join('\n\n'), pages: totalPages };
}

/** 첨부 내용(Buffer)에서 텍스트를 꺼낸다. 지원하지 않는 형식은 오류. */
export async function extractAttachmentText(content: Buffer, filename: string, mimeType: string): Promise<{ format: string; text: string; pages?: number }> {
  const ext = (filename.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const mt = mimeType.toLowerCase();
  if (ext === 'pdf' || mt === 'application/pdf') return { format: 'pdf', ...(await pdfText(content)) };
  if (ext === 'docx') return { format: 'docx', text: docxText(content) };
  if (ext === 'pptx') return { format: 'pptx', ...pptxText(content) };
  if (ext === 'xlsx') return { format: 'xlsx', ...xlsxText(content) };
  if (ext === 'hwpx') return { format: 'hwpx', ...hwpxText(content) };
  if (ext === 'html' || ext === 'htm' || mt === 'text/html') {
    const html = content.toString('utf8').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
    return { format: 'html', text: decodeEntities(html.replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim() };
  }
  if (['txt', 'csv', 'tsv', 'md', 'json', 'xml', 'log'].includes(ext) || mt.startsWith('text/')) return { format: ext || 'text', text: content.toString('utf8') };
  if (ext === 'hwp') throw new Error('HWP(한글 97~) 바이너리 형식은 읽을 수 없습니다. HWPX 나 PDF 로 받아 주세요.');
  if (['ppt', 'doc', 'xls'].includes(ext)) throw new Error(`옛 오피스 형식(.${ext})은 읽을 수 없습니다. ${ext}x 나 PDF 로 받아 주세요.`);
  throw new Error(`이 형식은 텍스트로 읽을 수 없습니다: ${filename} (${mimeType})`);
}

export interface FetchedAttachment {
  emailId: number;
  subject: string;
  pick: AttachmentListItem;
  content: Buffer;
  contentType: string;
  size: number;
}

/** DB 에서 메일·첨부를 고른다 (POP3 접속 없음). 다운로드 링크를 만들기 전에 확인용으로도 쓴다. */
export async function pickAttachment(
  db: Db,
  p: Pick<ReadAttachmentParams, 'emailId' | 'attachmentId' | 'index' | 'filename'>
): Promise<{ ok: true; row: { id: number; source: string; sourceUid: string | null; subject: string }; pick: AttachmentListItem; list: AttachmentListItem[] } | { ok: false; error: string; attachments?: AttachmentListItem[] }> {
  const account = currentAccount();
  const [row] = await db
    .select({ id: emails.id, source: emails.source, sourceUid: emails.sourceUid, subject: emails.subject })
    .from(emails)
    .where(and(eq(emails.account, account.key), eq(emails.id, p.emailId)))
    .limit(1);
  if (!row) return { ok: false, error: `메일을 찾을 수 없습니다: ${p.emailId}` };
  const stored = await db.select().from(emailAttachments).where(eq(emailAttachments.emailId, row.id)).orderBy(asc(emailAttachments.id));
  const list: AttachmentListItem[] = stored.map((a, index) => ({ index, id: a.id, filename: a.filename, mimeType: a.mimeType, fileSize: a.fileSize }));
  if (!list.length) return { ok: false, error: '이 메일에는 첨부가 없습니다. 본문의 "대용량 첨부파일" 링크는 첨부가 아니라 내려받을 수 없습니다.' };

  let pick: AttachmentListItem | undefined;
  if (p.attachmentId !== undefined) pick = list.find((a) => a.id === p.attachmentId);
  else if (p.index !== undefined) pick = list[p.index];
  else if (p.filename) pick = list.find((a) => a.filename.toLowerCase().includes(p.filename!.toLowerCase()));
  else if (list.length === 1) pick = list[0];
  if (!pick) return { ok: false, error: '어느 첨부를 읽을지 attachmentId, index 또는 filename 으로 지정해 주세요.', attachments: list };

  if (row.source !== 'pop3' || !row.sourceUid) {
    return { ok: false, error: '받은편지함(POP3)으로 들어온 메일만 첨부를 다시 받을 수 있습니다. 백업 파일로 가져온 메일은 원본이 메일 서버에 없습니다.', attachments: list };
  }
  if (!account.username || !account.password) return { ok: false, error: '이 계정의 하이웍스 주소·비밀번호가 서버에 설정되지 않았습니다.' };
  return { ok: true, row, pick, list };
}

/** 첨부 하나의 원본 바이트를 POP3 에서 다시 받는다 (메모리에만 둠). */
export async function fetchAttachment(
  db: Db,
  p: Pick<ReadAttachmentParams, 'emailId' | 'attachmentId' | 'index' | 'filename'>
): Promise<{ ok: true; file: FetchedAttachment } | { ok: false; error: string; attachments?: AttachmentListItem[] }> {
  const picked = await pickAttachment(db, p);
  if (!picked.ok) return picked;
  const { row, pick, list } = picked;
  const account = currentAccount();
  const uid = row.sourceUid!;
  const parsedAtts = await withPop3({ username: account.username!, password: account.password! }, async (s) => {
    const ref = (await s.list()).find((r) => r.uid === uid);
    if (!ref) throw new Error('하이웍스 메일함에 이 메일 원본이 없습니다 (메일함에서 지웠거나 POP3 "서버에 원본 남기기"가 꺼져 있음).');
    if (ref.size !== undefined && ref.size > MAX_MESSAGE_BYTES) throw new Error(`메일 원본이 ${Math.round(ref.size / 1048576)}MB 로 한도(${Math.round(MAX_MESSAGE_BYTES / 1048576)}MB)를 넘습니다.`);
    const parsed = await withTimeout(s.retrieve(ref.msgNum), RETR_TIMEOUT_MS, '메일 원본');
    return parsed.attachments || [];
  });
  // 저장할 때와 같은 순서로 파싱되므로 순번으로 찾고, 이름이 다르면 이름으로 다시 찾는다
  let att = parsedAtts.at(pick.index);
  if (!att || (att.filename || '') !== pick.filename) att = parsedAtts.find((a) => (a.filename || '') === pick.filename);
  if (!att) return { ok: false, error: `메일 원본에서 첨부를 찾지 못했습니다: ${pick.filename}`, attachments: list };
  return { ok: true, file: { emailId: row.id, subject: row.subject, pick, content: att.content, contentType: att.contentType || pick.mimeType, size: att.size } };
}

/** 메일 한 통의 첨부 하나를 POP3 원본에서 다시 받아 텍스트로 돌려준다. */
export async function readAttachment(db: Db, p: ReadAttachmentParams): Promise<ReadAttachmentResult> {
  const got = await fetchAttachment(db, p);
  if (!got.ok) return { success: false, error: got.error, ...(got.attachments ? { attachments: got.attachments } : {}) };
  const { pick, content, contentType, size } = got.file;
  const att = { content, contentType, size };
  const row = { id: got.file.emailId, subject: got.file.subject };

  const extracted = await extractAttachmentText(att.content, pick.filename, att.contentType || pick.mimeType);
  const full = extracted.text;
  const offset = Math.max(0, p.offset ?? 0);
  const maxChars = Math.min(Math.max(p.maxChars ?? 40000, 1000), 100000);
  const text = full.slice(offset, offset + maxChars);
  const end = offset + text.length;
  return {
    success: true,
    emailId: row.id,
    subject: row.subject,
    attachment: { index: pick.index, filename: pick.filename, mimeType: att.contentType || pick.mimeType, size: att.size },
    format: extracted.format,
    ...(extracted.pages !== undefined ? { pages: extracted.pages } : {}),
    totalChars: full.length,
    offset,
    text,
    truncated: end < full.length,
    nextOffset: end < full.length ? end : null,
  };
}
