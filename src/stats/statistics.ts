import { and, gte, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { emails } from '../db/schema.js';
import { parseDateInput } from '../utils/date.js';

export type Granularity = 'day' | 'week' | 'month';

export interface StatisticsParams {
  since: string;
  before: string;
  granularity?: Granularity;
  topN?: number;
  selfEmail?: string;
}

export interface Statistics {
  period: { since: string; before: string; granularity: Granularity };
  totals: { sent: number; received: number; total: number; withAttachments: number };
  series: Array<{ bucket: string; sent: number; received: number }>;
  topSenders: Array<{ email: string; name: string; count: number }>;
  topRecipients: Array<{ email: string; count: number }>;
  byProject: Array<{ project: string; sent: number; received: number; total: number }>;
  pendingRequests: Array<{ id: number; subject: string; sender: string; date: string; reason: string }>;
}

const REQUEST_PATTERN = '(요청|부탁|확인|검토|회신|문의|제출|승인|회답|답변|가능할까요|해주세요|바랍니다|please|request|review|confirm)';

export async function getStatistics(db: Db, p: StatisticsParams): Promise<Statistics> {
  const since = parseDateInput(p.since);
  const before = parseDateInput(p.before, true);
  const granularity: Granularity = p.granularity ?? 'day';
  const topN = Math.min(Math.max(p.topN ?? 10, 1), 50);
  const dateCol = sql`coalesce(${emails.sentAt}, ${emails.receivedAt}, ${emails.createdAt})`;
  const inPeriod = and(gte(dateCol, since), lte(dateCol, before));
  const self = (p.selfEmail || '').toLowerCase();

  const [totals] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${emails.direction} = 'sent')`.mapWith(Number),
      received: sql<number>`count(*) filter (where ${emails.direction} = 'received')`.mapWith(Number),
      withAttachments: sql<number>`count(*) filter (where ${emails.hasAttachments})`.mapWith(Number),
    })
    .from(emails)
    .where(inPeriod);

  // KST 기준 버킷
  const trunc = sql.raw(`'${granularity === 'month' ? 'month' : granularity === 'week' ? 'week' : 'day'}'`);
  const bucket = sql`to_char(date_trunc(${trunc}, ${dateCol} at time zone 'Asia/Seoul'), 'YYYY-MM-DD')`;
  const series = await db
    .select({
      bucket: sql<string>`${bucket}`,
      sent: sql<number>`count(*) filter (where ${emails.direction} = 'sent')`.mapWith(Number),
      received: sql<number>`count(*) filter (where ${emails.direction} = 'received')`.mapWith(Number),
    })
    .from(emails)
    .where(inPeriod)
    .groupBy(bucket)
    .orderBy(bucket);

  const topSenders = await db
    .select({
      email: emails.senderEmail,
      name: sql<string>`max(${emails.sender})`,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(emails)
    .where(and(inPeriod, sql`${emails.direction} = 'received'`, sql`${emails.senderEmail} <> ''`))
    .groupBy(emails.senderEmail)
    .orderBy(sql`count(*) desc`)
    .limit(topN);

  const topRecipientsRes = await db.execute(sql`
    select r as email, count(*)::int as count
    from ${emails}, unnest(${emails.recipientEmails}) as r
    where ${inPeriod} and ${emails.direction} = 'sent' and r <> ${self}
    group by r order by count desc limit ${topN}`);

  const byProject = await db
    .select({
      project: sql<string>`coalesce(${emails.projectName}, '(미분류)')`,
      sent: sql<number>`count(*) filter (where ${emails.direction} = 'sent')`.mapWith(Number),
      received: sql<number>`count(*) filter (where ${emails.direction} = 'received')`.mapWith(Number),
      total: sql<number>`count(*)`.mapWith(Number),
    })
    .from(emails)
    .where(inPeriod)
    .groupBy(emails.projectName)
    .orderBy(sql`count(*) desc`);

  // 미처리 요청 후보: 기간 내 수신한 요청성 메일 중, 같은 스레드에 그 이후 발신 메일이 없는 것
  const pending = await db.execute(sql`
    select e.id, e.subject, e.sender, to_char(coalesce(e.sent_at, e.received_at, e.created_at) at time zone 'Asia/Seoul', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') as date
    from ${emails} e
    where e.direction = 'received'
      and coalesce(e.sent_at, e.received_at, e.created_at) between ${since} and ${before}
      and e.sender_email !~* '(noreply|no-reply|newsletter|notification|mailer-daemon)'
      and (e.subject ~* ${REQUEST_PATTERN} or left(e.body_text, 1500) ~* ${REQUEST_PATTERN})
      and not exists (
        select 1 from ${emails} s
        where s.direction = 'sent' and s.thread_key = e.thread_key and s.thread_key <> ''
          and coalesce(s.sent_at, s.created_at) >= coalesce(e.sent_at, e.received_at, e.created_at)
      )
    order by coalesce(e.sent_at, e.received_at, e.created_at) desc
    limit 20`);

  return {
    period: { since: p.since, before: p.before, granularity },
    totals: { sent: totals?.sent ?? 0, received: totals?.received ?? 0, total: (totals?.sent ?? 0) + (totals?.received ?? 0), withAttachments: totals?.withAttachments ?? 0 },
    series,
    topSenders,
    topRecipients: (topRecipientsRes.rows as Array<{ email: string; count: number }>).map((r) => ({ email: String(r.email), count: Number(r.count) })),
    byProject,
    pendingRequests: (pending.rows as Array<{ id: number; subject: string; sender: string; date: string }>).map((r) => ({
      id: Number(r.id),
      subject: r.subject,
      sender: r.sender,
      date: r.date,
      reason: '요청성 표현이 있고 같은 스레드에 이후 발신 메일이 없음',
    })),
  };
}
