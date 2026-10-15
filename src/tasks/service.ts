import { and, asc, desc, eq, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { emails, tasks, type EmailRow, type TaskRow } from '../db/schema.js';
import { getEmailById, getThread, toSummary, type EmailDetail, type EmailSummary } from '../search/query.js';
import { formatKST, parseDateInput } from '../utils/date.js';

export type TaskStatus = TaskRow['status'];
export type TaskPriority = TaskRow['priority'];

export interface TaskView {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  /** 마감까지 남은 일수 (음수면 지남). 마감 없으면 null */
  daysLeft: number | null;
  overdue: boolean;
  projectName: string | null;
  requester: string | null;
  requesterEmail: string | null;
  sourceEmailId: number | null;
  sourceEmail?: EmailSummary | null;
  threadKey: string | null;
  notes: string;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const REQUEST_PATTERN = '(요청|부탁|확인|검토|회신|문의|제출|승인|회답|답변|가능할까요|가능하신|괜찮으신|어떠신가요|어떠세요|주실 수|해주세요|해 주세요|바랍니다|주시기|please|request|review|confirm|deadline|due)';
const NOISE_SENDER = '(noreply|no-reply|newsletter|notification|mailer-daemon|donotreply|alert|bounce)';

export function todayKST(): string {
  return formatKST(new Date()).slice(0, 10);
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = parseDateInput(fromYmd).getTime();
  const b = parseDateInput(toYmd).getTime();
  return Math.round((b - a) / 86400000);
}

export function toTaskView(row: TaskRow, sourceEmail?: EmailRow | null, today = todayKST()): TaskView {
  const open = row.status !== 'done' && row.status !== 'cancelled';
  const daysLeft = row.dueDate ? daysBetween(today, row.dueDate) : null;
  const view: TaskView = {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueDate: row.dueDate,
    daysLeft,
    overdue: open && daysLeft !== null && daysLeft < 0,
    projectName: row.projectName,
    requester: row.requester,
    requesterEmail: row.requesterEmail,
    sourceEmailId: row.sourceEmailId,
    threadKey: row.threadKey,
    notes: row.notes,
    meta: row.meta,
    createdAt: formatKST(row.createdAt),
    updatedAt: formatKST(row.updatedAt),
    completedAt: row.completedAt ? formatKST(row.completedAt) : null,
  };
  if (sourceEmail !== undefined) view.sourceEmail = sourceEmail ? toSummary(sourceEmail, 120) : null;
  return view;
}

async function attachSourceEmails(db: Db, rows: TaskRow[]): Promise<TaskView[]> {
  const ids = Array.from(new Set(rows.map((r) => r.sourceEmailId).filter((id): id is number => id !== null)));
  const found = ids.length ? await db.select().from(emails).where(inArray(emails.id, ids)) : [];
  const byId = new Map(found.map((e) => [e.id, e]));
  const today = todayKST();
  return rows.map((r) => toTaskView(r, r.sourceEmailId ? byId.get(r.sourceEmailId) ?? null : null, today));
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  projectName?: string | null;
  requester?: string | null;
  requesterEmail?: string | null;
  sourceEmailId?: number | null;
  notes?: string;
  meta?: Record<string, unknown>;
}

function normalizeDue(due: string | null | undefined): string | null {
  if (!due) return null;
  const trimmed = due.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) throw new Error(`dueDate 는 YYYY-MM-DD 형식이어야 합니다: ${due}`);
  return trimmed;
}

/** 할 일 생성. sourceEmailId 가 있으면 요청자·사업·스레드를 메일에서 채운다. */
export async function createTask(db: Db, input: CreateTaskInput): Promise<TaskView> {
  let source: EmailRow | null = null;
  if (input.sourceEmailId) {
    const rows = await db.select().from(emails).where(eq(emails.id, input.sourceEmailId)).limit(1);
    source = rows[0] ?? null;
    if (!source) throw new Error(`근거 메일을 찾을 수 없습니다: ${input.sourceEmailId}`);
  }
  const [row] = await db
    .insert(tasks)
    .values({
      title: input.title.trim(),
      description: input.description ?? '',
      status: input.status ?? 'todo',
      priority: input.priority ?? 'normal',
      dueDate: normalizeDue(input.dueDate),
      projectName: input.projectName ?? source?.projectName ?? null,
      requester: input.requester ?? (source && source.direction === 'received' ? source.sender : null),
      requesterEmail: input.requesterEmail ?? (source && source.direction === 'received' ? source.senderEmail : null),
      sourceEmailId: source?.id ?? null,
      threadKey: source?.threadKey ?? null,
      notes: input.notes ?? '',
      meta: input.meta ?? {},
    })
    .returning();
  return toTaskView(row, source);
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  projectName?: string | null;
  requester?: string | null;
  notes?: string;
  /** 기존 notes 뒤에 타임스탬프와 함께 덧붙임 */
  appendNote?: string;
  sourceEmailId?: number | null;
}

export async function updateTask(db: Db, id: number, input: UpdateTaskInput): Promise<TaskView | null> {
  const existing = (await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0];
  if (!existing) return null;
  const set: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
  if (input.title !== undefined) set.title = input.title.trim();
  if (input.description !== undefined) set.description = input.description;
  if (input.priority !== undefined) set.priority = input.priority;
  if (input.dueDate !== undefined) set.dueDate = normalizeDue(input.dueDate);
  if (input.projectName !== undefined) set.projectName = input.projectName;
  if (input.requester !== undefined) set.requester = input.requester;
  if (input.sourceEmailId !== undefined) set.sourceEmailId = input.sourceEmailId;
  if (input.notes !== undefined) set.notes = input.notes;
  if (input.appendNote) {
    const stamp = formatKST(new Date()).slice(0, 16).replace('T', ' ');
    set.notes = `${(set.notes ?? existing.notes).trim()}\n[${stamp}] ${input.appendNote.trim()}`.trim();
  }
  if (input.status !== undefined) {
    set.status = input.status;
    if (input.status === 'done') set.completedAt = existing.completedAt ?? new Date();
    else if (input.status === 'cancelled') set.completedAt = existing.completedAt ?? new Date();
    else set.completedAt = null;
  }
  const [row] = await db.update(tasks).set(set).where(eq(tasks.id, id)).returning();
  return (await attachSourceEmails(db, [row]))[0];
}

export interface ListTasksParams {
  status?: TaskStatus[];
  project?: string;
  priority?: TaskPriority[];
  dueBefore?: string;
  dueAfter?: string;
  overdueOnly?: boolean;
  /** 제목/설명/메모 부분 일치 */
  query?: string;
  requester?: string;
  sourceEmailId?: number;
  limit?: number;
  offset?: number;
  sort?: 'due' | 'priority' | 'updated' | 'created';
}

const PRIORITY_ORDER = sql`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`;

export async function listTasks(db: Db, p: ListTasksParams = {}): Promise<{ tasks: TaskView[]; total: number; limit: number; offset: number }> {
  const limit = Math.min(Math.max(p.limit ?? 50, 1), 200);
  const offset = Math.max(p.offset ?? 0, 0);
  const conds: SQL[] = [];
  const status = p.status && p.status.length ? p.status : (['todo', 'doing', 'waiting'] as TaskStatus[]);
  conds.push(inArray(tasks.status, status));
  if (p.project) conds.push(eq(tasks.projectName, p.project));
  if (p.priority && p.priority.length) conds.push(inArray(tasks.priority, p.priority));
  if (p.dueBefore) conds.push(lte(tasks.dueDate, p.dueBefore));
  if (p.dueAfter) conds.push(gte(tasks.dueDate, p.dueAfter));
  if (p.overdueOnly) conds.push(sql`${tasks.dueDate} < ${todayKST()}::date`);
  if (p.requester) conds.push(or(sql`${tasks.requester} ILIKE ${'%' + p.requester + '%'}`, sql`${tasks.requesterEmail} ILIKE ${'%' + p.requester + '%'}`)!);
  if (p.sourceEmailId) conds.push(eq(tasks.sourceEmailId, p.sourceEmailId));
  if (p.query) {
    const pat = '%' + p.query.replace(/[%_\\]/g, '\\$&') + '%';
    conds.push(or(sql`${tasks.title} ILIKE ${pat}`, sql`${tasks.description} ILIKE ${pat}`, sql`${tasks.notes} ILIKE ${pat}`)!);
  }
  const order =
    p.sort === 'priority'
      ? [asc(PRIORITY_ORDER), sql`${tasks.dueDate} asc nulls last`]
      : p.sort === 'updated'
        ? [desc(tasks.updatedAt)]
        : p.sort === 'created'
          ? [desc(tasks.createdAt)]
          : [sql`${tasks.dueDate} asc nulls last`, asc(PRIORITY_ORDER), asc(tasks.id)];
  const rows = await db
    .select({ row: tasks, total: sql<number>`count(*) over()`.mapWith(Number) })
    .from(tasks)
    .where(and(...conds))
    .orderBy(...order)
    .limit(limit)
    .offset(offset);
  return { tasks: await attachSourceEmails(db, rows.map((r) => r.row)), total: rows[0]?.total ?? 0, limit, offset };
}

export async function getTask(db: Db, id: number): Promise<{ task: TaskView; sourceEmail: EmailDetail | null; thread: EmailSummary[] } | null> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0];
  if (!row) return null;
  const sourceEmail = row.sourceEmailId ? await getEmailById(db, row.sourceEmailId, { maxLength: 4000 }) : null;
  const thread = row.threadKey ? await getThread(db, row.threadKey) : [];
  return { task: toTaskView(row), sourceEmail, thread };
}

export interface ActionableEmail extends EmailSummary {
  reasons: string[];
  /** 본문에서 찾은 날짜/기한 표현 (참고용) */
  dateHints: string[];
  /** 이 메일(또는 스레드)에 이미 연결된 할 일 */
  linkedTaskIds: number[];
  /** 같은 스레드에 내가 이후에 보낸 메일이 있는지 */
  repliedAfter: boolean;
}

const DATE_HINT = /(\d{1,2}\s*월\s*\d{1,2}\s*일|\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}\/\d{1,2}|오늘|내일|모레|이번\s*주|다음\s*주|금주|차주|월요일|화요일|수요일|목요일|금요일|까지|마감|기한|asap|eod|eow)/gi;

/**
 * 할 일 후보 메일: 기간 내 수신 메일 중 요청 표현이 있고, 아직 할 일로 등록되지 않은 것.
 * LLM 없이 규칙으로 고르며, 최종 판단은 에이전트(Claude)가 본문을 읽고 한다.
 */
export async function findActionableEmails(
  db: Db,
  p: { since?: string; before?: string; includeLinked?: boolean; includeReplied?: boolean; limit?: number } = {}
): Promise<ActionableEmail[]> {
  const since = parseDateInput(p.since ?? formatKST(new Date(Date.now() - 7 * 86400000)).slice(0, 10));
  const before = parseDateInput(p.before ?? todayKST(), true);
  const limit = Math.min(Math.max(p.limit ?? 30, 1), 100);
  const dateCol = sql`coalesce(${emails.sentAt}, ${emails.receivedAt}, ${emails.createdAt})`;
  const outerThreadKey = sql.raw('"emails"."thread_key"');
  const outerId = sql.raw('"emails"."id"');
  const outerDate = sql.raw('coalesce("emails"."sent_at", "emails"."received_at", "emails"."created_at")');
  const rows = await db
    .select({
      row: emails,
      // 주의: SELECT 절에서 drizzle 은 컬럼을 테이블명 없이 렌더링하므로 서브쿼리 안의 외부 참조는 명시적으로 적는다.
      repliedAfter: sql<boolean>`exists (select 1 from ${emails} s where s.direction = 'sent' and s.thread_key = ${outerThreadKey} and s.thread_key <> '' and coalesce(s.sent_at, s.created_at) >= ${outerDate})`,
      linkedTaskIds: sql<number[]>`coalesce((select array_agg(t.id order by t.id) from ${tasks} t where t.source_email_id = ${outerId} or (t.thread_key = ${outerThreadKey} and ${outerThreadKey} <> '' and t.status not in ('done','cancelled'))), '{}')`,
    })
    .from(emails)
    .where(
      and(
        eq(emails.direction, 'received'),
        gte(dateCol, since),
        lte(dateCol, before),
        sql`${emails.senderEmail} !~* ${NOISE_SENDER}`,
        sql`(${emails.subject} ~* ${REQUEST_PATTERN} or left(${emails.bodyText}, 2000) ~* ${REQUEST_PATTERN})`
      )
    )
    .orderBy(desc(dateCol))
    .limit(limit * 3);

  const out: ActionableEmail[] = [];
  for (const r of rows) {
    const linked = (r.linkedTaskIds ?? []).map(Number);
    if (!p.includeLinked && linked.length) continue;
    if (!p.includeReplied && r.repliedAfter) continue;
    const text = `${r.row.subject}\n${r.row.bodyText.slice(0, 2000)}`;
    const reasons: string[] = [];
    if (new RegExp(REQUEST_PATTERN, 'i').test(r.row.subject)) reasons.push('제목에 요청 표현');
    else reasons.push('본문에 요청 표현');
    if (/긴급|urgent|asap|빠른|급히/i.test(text)) reasons.push('긴급 표현');
    const dateHints = Array.from(new Set((text.match(DATE_HINT) ?? []).map((s) => s.trim()))).slice(0, 6);
    if (dateHints.length) reasons.push('기한 표현');
    out.push({ ...toSummary(r.row, 300), reasons, dateHints, linkedTaskIds: linked, repliedAfter: Boolean(r.repliedAfter) });
    if (out.length >= limit) break;
  }
  return out;
}

export interface DailyBrief {
  date: string;
  generatedAt: string;
  counts: { overdue: number; dueToday: number; dueSoon: number; doing: number; waiting: number; todo: number; newActionable: number };
  overdue: TaskView[];
  dueToday: TaskView[];
  dueSoon: TaskView[];
  doing: TaskView[];
  waiting: TaskView[];
  newActionableEmails: ActionableEmail[];
  recentlyCompleted: TaskView[];
  sync: { source: string; status: string; lastSuccessAt: string | null; error: string | null }[];
}

/** 일일 브리핑 원자료. 서술은 에이전트가 한다. */
export async function buildDailyBrief(db: Db, p: { date?: string; soonDays?: number; lookbackDays?: number } = {}): Promise<DailyBrief> {
  const date = p.date ?? todayKST();
  const soonDays = p.soonDays ?? 3;
  const lookbackDays = p.lookbackDays ?? 1;
  const soonEnd = formatKST(new Date(parseDateInput(date).getTime() + soonDays * 86400000)).slice(0, 10);
  const open = (await listTasks(db, { limit: 200, sort: 'due' })).tasks;
  const overdue = open.filter((t) => t.dueDate && t.dueDate < date);
  const dueToday = open.filter((t) => t.dueDate === date);
  const dueSoon = open.filter((t) => t.dueDate && t.dueDate > date && t.dueDate <= soonEnd);
  const doing = open.filter((t) => t.status === 'doing');
  const waiting = open.filter((t) => t.status === 'waiting');
  const todo = open.filter((t) => t.status === 'todo');
  const since = formatKST(new Date(parseDateInput(date).getTime() - lookbackDays * 86400000)).slice(0, 10);
  const newActionableEmails = await findActionableEmails(db, { since, before: date, limit: 20 });
  const completedRows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'done'), gte(tasks.completedAt, parseDateInput(since))))
    .orderBy(desc(tasks.completedAt))
    .limit(20);
  const { listSyncStates } = await import('../sync/state.js');
  const states = await listSyncStates(db);
  return {
    date,
    generatedAt: formatKST(new Date()),
    counts: { overdue: overdue.length, dueToday: dueToday.length, dueSoon: dueSoon.length, doing: doing.length, waiting: waiting.length, todo: todo.length, newActionable: newActionableEmails.length },
    overdue,
    dueToday,
    dueSoon,
    doing,
    waiting,
    newActionableEmails,
    recentlyCompleted: await attachSourceEmails(db, completedRows),
    sync: states.map((s) => ({ source: s.source, status: s.status, lastSuccessAt: s.lastSuccessAt ? formatKST(s.lastSuccessAt) : null, error: s.errorMessage })),
  };
}

export interface ReplyContext {
  task: TaskView | null;
  email: EmailDetail;
  thread: EmailSummary[];
  /** 같은 상대에게 내가 최근에 보낸 메일 (말투 참고용) */
  myRecentMailsToSender: EmailSummary[];
  replyTo: string[];
  suggestedSubject: string;
}

/** 답장 초안 작성에 필요한 맥락. 실제 발송은 하지 않는다 (로컬 stdio 서버의 reply_email 로 확인 후 발송). */
export async function getReplyContext(db: Db, p: { taskId?: number; emailId?: number }): Promise<ReplyContext | null> {
  let task: TaskRow | null = null;
  let emailId = p.emailId ?? null;
  if (p.taskId) {
    task = (await db.select().from(tasks).where(eq(tasks.id, p.taskId)).limit(1))[0] ?? null;
    if (!task) return null;
    emailId = emailId ?? task.sourceEmailId;
  }
  if (!emailId) throw new Error('emailId 또는 근거 메일이 연결된 taskId 가 필요합니다.');
  const email = await getEmailById(db, emailId, { maxLength: 8000 });
  if (!email) return null;
  const thread = await getThread(db, email.threadKey);
  const myRecent = email.senderEmail
    ? await db
        .select()
        .from(emails)
        .where(and(eq(emails.direction, 'sent'), sql`${email.senderEmail} = any(${emails.recipientEmails})`))
        .orderBy(desc(emails.sentAt))
        .limit(3)
    : [];
  const subject = email.subject.trim();
  return {
    task: task ? toTaskView(task) : null,
    email,
    thread,
    myRecentMailsToSender: myRecent.map((r) => toSummary(r, 300)),
    replyTo: [email.senderEmail].filter(Boolean),
    suggestedSubject: /^(re|답장)\s*:/i.test(subject) ? subject : `Re: ${subject}`,
  };
}

export async function taskSummaryCounts(db: Db): Promise<Record<string, number>> {
  const rows = await db.select({ status: tasks.status, n: sql<number>`count(*)`.mapWith(Number) }).from(tasks).groupBy(tasks.status);
  const out: Record<string, number> = { todo: 0, doing: 0, waiting: 0, done: 0, cancelled: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}


export interface SentThreadSummary {
  threadKey: string;
  subject: string;
  projectName: string | null;
  count: number;
  firstAt: string;
  lastAt: string;
  to: string[];
  emailIds: number[];
  /** 대표(마지막) 메일 본문 앞부분 */
  snippet: string;
  /** 이 스레드에 같은 날 수신 메일이 있었는지 (답장인지) */
  isReply: boolean;
}

export interface DailyActivity {
  date: string;
  generatedAt: string;
  stats: { sent: number; received: number; sentThreads: number; requestsReceived: number; requestsReplied: number; tasksCompleted: number; tasksCreated: number };
  /** 내가 보낸 메일을 스레드별로 묶음 (수행 업무의 근거) */
  sentThreads: SentThreadSummary[];
  /** 그날 받은 요청성 메일과 회신 여부 */
  receivedRequests: ActionableEmail[];
  tasksCompleted: TaskView[];
  tasksCreated: TaskView[];
  /** 자동 발신 제외, 그날 받은 메일 중 요청이 아닌 것의 제목 (참고) */
  otherReceivedSubjects: string[];
}

/** 특정 날짜(KST)의 업무 내역 원자료. 업무일지·전날 브리핑의 입력이 된다. 서술은 에이전트가 한다. */
export async function buildDailyActivity(db: Db, p: { date?: string } = {}): Promise<DailyActivity> {
  const date = p.date ?? formatKST(new Date(Date.now() - 86400000)).slice(0, 10);
  const since = parseDateInput(date);
  const before = parseDateInput(date, true);
  const dateCol = sql`coalesce(${emails.sentAt}, ${emails.receivedAt}, ${emails.createdAt})`;
  const rows = await db
    .select()
    .from(emails)
    .where(and(gte(dateCol, since), lte(dateCol, before)))
    .orderBy(asc(dateCol));

  const received = rows.filter((r) => r.direction === 'received');
  const receivedThreads = new Set(received.map((r) => r.threadKey).filter(Boolean));
  const sentGroups = new Map<string, EmailRow[]>();
  for (const r of rows.filter((r) => r.direction === 'sent')) {
    const key = r.threadKey || `mid:${r.messageId ?? r.id}`;
    sentGroups.set(key, [...(sentGroups.get(key) ?? []), r]);
  }
  const sentThreads: SentThreadSummary[] = Array.from(sentGroups.entries()).map(([key, list]) => {
    const last = list[list.length - 1]!;
    return {
      threadKey: key,
      subject: last.subject,
      projectName: list.find((e) => e.projectName)?.projectName ?? null,
      count: list.length,
      firstAt: formatKST(list[0]!.sentAt ?? list[0]!.createdAt),
      lastAt: formatKST(last.sentAt ?? last.createdAt),
      to: Array.from(new Set(list.flatMap((e) => e.recipients.filter((x) => x.kind !== 'bcc').map((x) => x.address)))),
      emailIds: list.map((e) => e.id),
      snippet: last.bodyText.replace(/\s+/g, ' ').slice(0, 300),
      isReply: receivedThreads.has(key) || Boolean(last.inReplyTo),
    };
  });

  const receivedRequests = await findActionableEmails(db, { since: date, before: date, includeLinked: true, includeReplied: true, limit: 100 });
  const requestIds = new Set(receivedRequests.map((r) => r.id));
  const noise = new RegExp(NOISE_SENDER, 'i');
  const otherReceivedSubjects = received.filter((r) => !requestIds.has(r.id) && !noise.test(r.senderEmail)).map((r) => r.subject).slice(0, 50);

  const completedRows = await db.select().from(tasks).where(and(gte(tasks.completedAt, since), lte(tasks.completedAt, before))).orderBy(asc(tasks.completedAt));
  const createdRows = await db.select().from(tasks).where(and(gte(tasks.createdAt, since), lte(tasks.createdAt, before))).orderBy(asc(tasks.createdAt));

  return {
    date,
    generatedAt: formatKST(new Date()),
    stats: {
      sent: rows.length - received.length,
      received: received.length,
      sentThreads: sentThreads.length,
      requestsReceived: receivedRequests.length,
      requestsReplied: receivedRequests.filter((r) => r.repliedAfter).length,
      tasksCompleted: completedRows.length,
      tasksCreated: createdRows.length,
    },
    sentThreads,
    receivedRequests,
    tasksCompleted: await attachSourceEmails(db, completedRows),
    tasksCreated: await attachSourceEmails(db, createdRows),
    otherReceivedSubjects,
  };
}
