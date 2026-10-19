import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.js';
import { emailAttachments, emails, type EmailRow } from '../db/schema.js';
import { formatKST, parseDateInput } from '../utils/date.js';
import { acct } from '../account.js';

export interface SearchParams {
  query?: string;
  direction?: 'sent' | 'received';
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  before?: string;
  hasAttachments?: boolean;
  project?: string;
  threadKey?: string;
  limit?: number;
  offset?: number;
  sort?: 'date_desc' | 'date_asc' | 'relevance';
}

export interface EmailSummary {
  id: number;
  direction: 'sent' | 'received';
  messageId: string | null;
  sender: string;
  senderEmail: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  hasAttachments: boolean;
  projectName: string | null;
  threadKey: string;
  snippet: string;
}

export interface SearchResult {
  emails: EmailSummary[];
  total: number;
  limit: number;
  offset: number;
}

const ilike = (col: SQL | AnyPgColumn, term: string) => sql`${col} ILIKE ${'%' + term.replace(/[%_\\]/g, '\\$&') + '%'}`;

export function toSummary(row: EmailRow, snippetLength = 200): EmailSummary {
  const date = row.sentAt ?? row.receivedAt ?? row.createdAt;
  return {
    id: row.id,
    direction: row.direction,
    messageId: row.messageId,
    sender: row.sender,
    senderEmail: row.senderEmail,
    to: row.recipients.filter((r) => r.kind === 'to').map((r) => (r.name ? `${r.name} <${r.address}>` : r.address)),
    cc: row.recipients.filter((r) => r.kind === 'cc').map((r) => (r.name ? `${r.name} <${r.address}>` : r.address)),
    subject: row.subject,
    date: date ? formatKST(date) : '',
    hasAttachments: row.hasAttachments,
    projectName: row.projectName,
    threadKey: row.threadKey,
    snippet: row.bodyText.replace(/\s+/g, ' ').slice(0, snippetLength),
  };
}

/** 검색 조건을 WHERE 절로 변환한다. 한글은 trigram ILIKE 부분 일치, 공백으로 나뉜 단어는 AND. */
export function buildWhere(p: SearchParams): SQL | undefined {
  // 언제나 지금 계정의 메일만
  const conds: SQL[] = [eq(emails.account, acct())];
  if (p.direction) conds.push(eq(emails.direction, p.direction));
  if (p.from) conds.push(sql`(${ilike(emails.sender, p.from)} OR ${ilike(emails.senderEmail, p.from)})`);
  if (p.to) conds.push(sql`exists (select 1 from unnest(${emails.recipientEmails}) r where r ILIKE ${'%' + p.to.toLowerCase() + '%'})`);
  if (p.subject) conds.push(ilike(emails.subject, p.subject));
  if (p.project) conds.push(eq(emails.projectName, p.project));
  if (p.threadKey) conds.push(eq(emails.threadKey, p.threadKey));
  if (p.hasAttachments !== undefined) conds.push(eq(emails.hasAttachments, p.hasAttachments));
  if (p.since) conds.push(gte(emails.sentAt, parseDateInput(p.since)));
  if (p.before) conds.push(lte(emails.sentAt, parseDateInput(p.before, true)));
  if (p.query) {
    const terms = p.query.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    for (const term of terms) {
      conds.push(
        sql`(${ilike(emails.subject, term)} OR ${ilike(emails.bodyText, term)} OR ${ilike(emails.sender, term)} OR exists (select 1 from unnest(${emails.recipientEmails}) r where r ILIKE ${'%' + term.toLowerCase() + '%'}))`
      );
    }
  }
  return conds.length ? and(...conds) : undefined;
}

export async function searchEmails(db: Db, p: SearchParams): Promise<SearchResult> {
  const limit = Math.min(Math.max(p.limit ?? 20, 1), 200);
  const offset = Math.max(p.offset ?? 0, 0);
  const where = buildWhere(p);
  const sortDate = sql`coalesce(${emails.sentAt}, ${emails.receivedAt}, ${emails.createdAt})`;
  let order: SQL[];
  if (p.sort === 'relevance' && p.query) {
    order = [
      desc(sql`ts_rank(${emails.searchVector}, plainto_tsquery('simple', ${p.query})) + similarity(${emails.subject}, ${p.query})`),
      desc(sortDate),
    ];
  } else if (p.sort === 'date_asc') {
    order = [asc(sortDate)];
  } else {
    order = [desc(sortDate)];
  }
  const rows = await db
    .select({ row: emails, total: sql<number>`count(*) over()`.mapWith(Number) })
    .from(emails)
    .where(where)
    .orderBy(...order)
    .limit(limit)
    .offset(offset);
  return { emails: rows.map((r) => toSummary(r.row)), total: rows[0]?.total ?? 0, limit, offset };
}

export interface EmailDetail extends EmailSummary {
  bcc: string[];
  bodyText: string;
  bodyHtml?: string;
  truncated: boolean;
  inReplyTo: string | null;
  references: string[];
  source: string;
  attachments: Array<{ id: number; filename: string; mimeType: string; fileSize: number }>;
}

export async function getEmailById(db: Db, id: number, opts: { includeHtml?: boolean; maxLength?: number } = {}): Promise<EmailDetail | null> {
  const rows = await db.select().from(emails).where(and(eq(emails.account, acct()), eq(emails.id, id))).limit(1);
  const row = rows[0];
  if (!row) return null;
  const atts = await db.select().from(emailAttachments).where(eq(emailAttachments.emailId, id));
  const maxLength = opts.maxLength ?? 20000;
  const truncated = maxLength > 0 && row.bodyText.length > maxLength;
  const detail: EmailDetail = {
    ...toSummary(row),
    bcc: row.recipients.filter((r) => r.kind === 'bcc').map((r) => r.address),
    bodyText: truncated ? `${row.bodyText.slice(0, maxLength)}\n…(이하 ${row.bodyText.length - maxLength}자 생략)` : row.bodyText,
    truncated,
    inReplyTo: row.inReplyTo,
    references: row.references,
    source: row.source,
    attachments: atts.map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, fileSize: a.fileSize })),
  };
  if (opts.includeHtml && row.bodyHtml) detail.bodyHtml = maxLength > 0 ? row.bodyHtml.slice(0, maxLength) : row.bodyHtml;
  return detail;
}

/** 같은 스레드의 메일을 시간순으로 */
export async function getThread(db: Db, threadKey: string, limit = 50): Promise<EmailSummary[]> {
  if (!threadKey) return [];
  const rows = await db
    .select()
    .from(emails)
    .where(and(eq(emails.account, acct()), eq(emails.threadKey, threadKey)))
    .orderBy(asc(sql`coalesce(${emails.sentAt}, ${emails.receivedAt}, ${emails.createdAt})`))
    .limit(limit);
  return rows.map((r) => toSummary(r));
}
