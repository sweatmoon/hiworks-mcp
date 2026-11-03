import crypto from 'crypto';
import type { AddressObject, ParsedMail } from 'mailparser';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { emailAttachments, emails, sourceUidAliases, type NewEmailRow, type RecipientJson } from '../db/schema.js';
import { projectRules, type ProjectRule } from '../config.js';
import { normalizeMessageId, stripHtml } from '../utils/mail.js';
import { acct } from '../account.js';

export type Direction = 'sent' | 'received';

export interface StoreOptions {
  direction?: Direction;
  source: string;
  sourceUid?: string;
  /** 본인 계정 주소. 발신자가 본인이면 direction 을 sent 로 추정한다 */
  selfEmail?: string;
  sizeBytes?: number;
  receivedAt?: Date;
}

export interface PreparedEmail {
  row: NewEmailRow;
  attachments: Array<{ filename: string; mimeType: string; fileSize: number }>;
}

function addressesOf(addr: AddressObject | AddressObject[] | undefined, kind: RecipientJson['kind']): RecipientJson[] {
  if (!addr) return [];
  const list = Array.isArray(addr) ? addr : [addr];
  const out: RecipientJson[] = [];
  for (const a of list) {
    for (const v of a.value) {
      if (v.address) out.push({ name: v.name || '', address: v.address.toLowerCase(), kind });
    }
  }
  return out;
}

/** Re:/Fwd:/답장:/전달: 접두어를 모두 벗긴 제목 (스레드 묶음용) */
export function threadKeyOf(subject: string): string {
  let s = subject.trim();
  const prefix = /^((re|fwd?|fw|답장|전달|회신)\s*:\s*)+/i;
  for (let i = 0; i < 5 && prefix.test(s); i++) s = s.replace(prefix, '');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function classifyProject(text: string, rules: ProjectRule[] = projectRules()): string | null {
  const lower = text.toLowerCase();
  for (const rule of rules) {
    if (rule.keywords.some((k) => k && lower.includes(k.toLowerCase()))) return rule.name;
  }
  // [사업명] 태그 형태의 제목
  const tag = /^\s*\[([^\]]{2,30})\]/.exec(text);
  if (tag && rules.length === 0) return tag[1].trim();
  return null;
}

export function fingerprint(parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('\u0001')).digest('hex');
}

/** mailparser 결과를 emails 행으로 변환한다 (DB 접근 없음). */
export function prepareEmail(parsed: ParsedMail, opts: StoreOptions): PreparedEmail {
  const from = addressesOf(parsed.from, 'to')[0];
  const senderEmail = from?.address || '';
  const sender = parsed.from?.text || senderEmail;
  const recipients = [
    ...addressesOf(parsed.to, 'to'),
    ...addressesOf(parsed.cc, 'cc'),
    ...addressesOf(parsed.bcc, 'bcc'),
  ];
  const recipientEmails = Array.from(new Set(recipients.map((r) => r.address)));
  const subject = (parsed.subject || '').trim();
  const bodyText = (parsed.text && parsed.text.trim()) || (parsed.html ? stripHtml(parsed.html) : '');
  const sentAt = parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null;
  const messageId = normalizeMessageId(parsed.messageId) || null;

  const direction: Direction =
    opts.direction ?? (opts.selfEmail && senderEmail === opts.selfEmail.toLowerCase() ? 'sent' : 'received');

  const dedupKey = messageId
    ? `mid:${messageId}`
    : `fp:${fingerprint([senderEmail, recipientEmails.slice().sort().join(','), subject, sentAt?.toISOString() || '', bodyText.slice(0, 2000)])}`;

  const refs = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  const attachments = (parsed.attachments || []).map((a, i) => ({
    filename: a.filename || `attachment-${i + 1}`,
    mimeType: a.contentType || 'application/octet-stream',
    fileSize: a.size || a.content?.length || 0,
  }));

  const row: NewEmailRow = {
    messageId,
    dedupKey,
    direction,
    source: opts.source,
    sourceUid: opts.sourceUid ?? null,
    sender,
    senderEmail,
    recipients,
    recipientEmails,
    subject,
    bodyText,
    bodyHtml: parsed.html || null,
    sentAt,
    receivedAt: opts.receivedAt ?? (direction === 'received' ? sentAt : null),
    hasAttachments: attachments.length > 0,
    sizeBytes: opts.sizeBytes ?? null,
    threadKey: threadKeyOf(subject),
    inReplyTo: normalizeMessageId(parsed.inReplyTo) || null,
    references: refs.map((r) => normalizeMessageId(r)).filter(Boolean),
    projectName: classifyProject(`${subject}\n${bodyText.slice(0, 2000)}`),
  };
  return { row, attachments };
}

export interface InsertResult {
  id: number | null;
  inserted: boolean;
}

/** 중복이면 건너뛰고(inserted=false), 새 메일이면 첨부 메타까지 저장한다. */
export async function insertEmail(db: Db, prepared: PreparedEmail): Promise<InsertResult> {
  return db.transaction(async (tx) => {
    const account = acct();
    const rows = await tx.insert(emails).values({ ...prepared.row, account }).onConflictDoNothing().returning({ id: emails.id });
    const id = rows[0]?.id;
    if (!id) {
      // 이미 존재: source_uid 가 비어 있던 행(예: 백업 가져오기)에 POP3 uid 를 보강한다.
      if (prepared.row.sourceUid) {
        const existing = await tx
          .select({ id: emails.id, sourceUid: emails.sourceUid })
          .from(emails)
          .where(and(eq(emails.account, account), eq(emails.dedupKey, prepared.row.dedupKey)))
          .limit(1);
        const e = existing[0];
        if (e && !e.sourceUid) {
          await tx
            .update(emails)
            .set({ source: prepared.row.source, sourceUid: prepared.row.sourceUid })
            .where(and(eq(emails.id, e.id), sql`${emails.sourceUid} is null`));
        } else if (e && e.sourceUid !== prepared.row.sourceUid) {
          // 같은 메일이 다른 uid 로 이미 저장됨 (메일함에 두 통). 이 uid 도 받은 것으로 남겨 다시 내려받지 않게 한다.
          await tx
            .insert(sourceUidAliases)
            .values({ account, source: prepared.row.source, sourceUid: prepared.row.sourceUid, emailId: e.id })
            .onConflictDoNothing();
        }
        return { id: e?.id ?? null, inserted: false };
      }
      return { id: null, inserted: false };
    }
    if (prepared.attachments.length) {
      await tx.insert(emailAttachments).values(prepared.attachments.map((a) => ({ ...a, emailId: id })));
    }
    return { id, inserted: true };
  });
}

/** 이미 저장된 POP3 uid 집합 (다른 uid 로 저장된 같은 메일의 추가 uid 포함) */
export async function knownSourceUids(db: Db, source: string, uids: string[]): Promise<Set<string>> {
  if (uids.length === 0) return new Set();
  const account = acct();
  const known = new Set<string>();
  // UIDL 은 수천 개가 될 수 있어 나눠서 묻는다 (바인드 변수 한도)
  for (let i = 0; i < uids.length; i += 5000) {
    const part = uids.slice(i, i + 5000);
    const [rows, aliases] = await Promise.all([
      db.select({ uid: emails.sourceUid }).from(emails).where(and(eq(emails.account, account), eq(emails.source, source), inArray(emails.sourceUid, part))),
      db
        .select({ uid: sourceUidAliases.sourceUid })
        .from(sourceUidAliases)
        .where(and(eq(sourceUidAliases.account, account), eq(sourceUidAliases.source, source), inArray(sourceUidAliases.sourceUid, part))),
    ]);
    for (const r of [...rows, ...aliases]) if (r.uid) known.add(r.uid);
  }
  return known;
}
