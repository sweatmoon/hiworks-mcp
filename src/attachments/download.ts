import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from '../db/client.js';
import { currentAccount, withAccount, type Account } from '../account.js';
import { log } from '../config.js';
import { fetchAttachment, pickAttachment, type ReadAttachmentParams } from './read.js';

/**
 * 첨부 원본 일회용 다운로드 링크.
 * 링크에는 무작위 토큰만 담고, 토큰 → (계정, 메일, 첨부) 대응은 이 프로세스 메모리에만 10분 둔다.
 * 링크를 여는 순간 POP3 에서 원본을 받아 그대로 흘려보내며, 파일은 디스크·DB 에 남기지 않는다. 한 번 쓰면 지운다.
 */

const TTL_MS = Number(process.env['ATTACHMENT_LINK_TTL_MIN'] || 10) * 60 * 1000;
const MAX_LINKS = 200;

interface Pending {
  account: Account;
  params: Pick<ReadAttachmentParams, 'emailId' | 'attachmentId' | 'index' | 'filename'>;
  expires: number;
}
const pending = new Map<string, Pending>();

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires <= now) pending.delete(k);
  while (pending.size > MAX_LINKS) pending.delete(pending.keys().next().value!);
}

/** 링크의 앞부분. PUBLIC_BASE_URL, 없으면 Railway 가 넣어 주는 RAILWAY_PUBLIC_DOMAIN. */
export function publicBaseUrl(): string {
  const explicit = (process.env['PUBLIC_BASE_URL'] || '').trim().replace(/\/$/, '');
  if (explicit) return explicit;
  const domain = (process.env['RAILWAY_PUBLIC_DOMAIN'] || '').trim();
  return domain ? `https://${domain}` : '';
}

export type DownloadLinkResult =
  | { success: true; url: string; filename: string; size: number; expiresAt: string; note: string }
  | { success: false; error: string; attachments?: unknown };

export async function createDownloadLink(db: Db, params: Pending['params']): Promise<DownloadLinkResult> {
  const picked = await pickAttachment(db, params);
  if (!picked.ok) return { success: false, error: picked.error, ...(picked.attachments ? { attachments: picked.attachments } : {}) };
  const base = publicBaseUrl();
  if (!base) return { success: false, error: '서버 공개 주소를 알 수 없습니다. Railway 변수 PUBLIC_BASE_URL 을 설정하세요.' };
  sweep();
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = Date.now() + TTL_MS;
  // 링크는 그 메일을 고른 계정으로만 연다
  pending.set(token, { account: currentAccount(), params: { emailId: params.emailId, attachmentId: picked.pick.id }, expires });
  return {
    success: true,
    url: `${base}/dl/${token}`,
    filename: picked.pick.filename,
    size: picked.pick.fileSize,
    expiresAt: new Date(expires).toISOString(),
    note: `한 번만 열 수 있고 ${Math.round(TTL_MS / 60000)}분 뒤 만료됩니다. 예: curl -fsS -o "<파일이름>" "<url>"`,
  };
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** GET /dl/<token> */
export async function handleDownload(db: Db, req: IncomingMessage, res: ServerResponse, token: string | undefined): Promise<void> {
  const send = (status: number, message: string) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: message }));
  };
  if (req.method !== 'GET') return send(405, 'GET only');
  sweep();
  const entry = token ? pending.get(token) : undefined;
  if (!token || !entry) return send(404, '링크가 없거나 만료됐습니다. 새 링크를 만드세요.');
  pending.delete(token);
  const got = await withAccount(entry.account, () => fetchAttachment(db, entry.params));
  if (!got.ok) return send(404, got.error);
  const { pick, content, contentType } = got.file;
  log(`attachment download: email=${got.file.emailId} attachment=${pick.id} bytes=${content.length}`);
  res.writeHead(200, {
    'content-type': contentType || 'application/octet-stream',
    'content-length': String(content.length),
    'content-disposition': contentDisposition(pick.filename),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(content);
}

/** 테스트용 */
export function pendingLinkCount(): number {
  sweep();
  return pending.size;
}
