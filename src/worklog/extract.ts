import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { emails, workActivities, type EmailRow, type WorkActivityRow } from '../db/schema.js';
import { projectRules } from '../config.js';
import { formatKST, parseDateInput } from '../utils/date.js';
import { getWorklogLLM, type CompactEmail, type Extraction } from './llm.js';

export interface ExtractOptions {
  mode?: 'llm' | 'rules';
  /** 발신/수신 본문 전달 글자 수 */
  sentBodyChars?: number;
  receivedBodyChars?: number;
  /** 하루에 LLM 으로 보낼 최대 스레드 수 */
  maxThreads?: number;
}

export interface ExtractResult {
  workDate: string;
  mode: 'llm' | 'rules';
  model: string | null;
  emailsConsidered: number;
  threads: number;
  activities: WorkActivityRow[];
  unresolvedRequests: Extraction['unresolved_requests'];
  notes: string;
  /** 모델이 입력에 없는 id 를 근거로 든 횟수 (0 이어야 정상) */
  invalidEvidenceCount: number;
}

const NOISE_SENDER = /(noreply|no-reply|newsletter|notification|mailer-daemon|donotreply)/i;

export async function emailsForDate(db: Db, workDate: string): Promise<EmailRow[]> {
  const since = parseDateInput(workDate);
  const before = parseDateInput(workDate, true);
  const dateCol = sql`coalesce(${emails.sentAt}, ${emails.receivedAt}, ${emails.createdAt})`;
  return db
    .select()
    .from(emails)
    .where(and(gte(dateCol, since), lte(dateCol, before)))
    .orderBy(asc(dateCol));
}

/** 스레드별 대표 메일을 고른다: 발신 메일 우선, 그다음 최신. 스레드당 1통만 LLM 에 보낸다. */
export function pickRepresentatives(rows: EmailRow[], maxThreads: number): Array<{ rep: EmailRow; size: number; all: EmailRow[] }> {
  const groups = new Map<string, EmailRow[]>();
  for (const r of rows) {
    if (NOISE_SENDER.test(r.senderEmail)) continue;
    const key = r.threadKey || `mid:${r.messageId ?? r.id}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  const picked = Array.from(groups.values()).map((all) => {
    const sent = all.filter((e) => e.direction === 'sent');
    const rep = (sent.length ? sent : all).slice().sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0))[0];
    return { rep, size: all.length, all };
  });
  // 발신 포함 스레드 우선
  picked.sort((a, b) => Number(b.all.some((e) => e.direction === 'sent')) - Number(a.all.some((e) => e.direction === 'sent')));
  return picked.slice(0, maxThreads);
}

export function toCompact(rep: EmailRow, size: number, sentChars: number, receivedChars: number): CompactEmail {
  const limit = rep.direction === 'sent' ? sentChars : receivedChars;
  return {
    id: rep.id,
    direction: rep.direction,
    date: rep.sentAt ? formatKST(rep.sentAt) : '',
    from: rep.sender,
    to: rep.recipients.filter((r) => r.kind !== 'bcc').map((r) => r.address),
    subject: rep.subject,
    body: rep.bodyText.replace(/\s+/g, ' ').slice(0, limit),
    threadSize: size,
    projectHint: rep.projectName,
  };
}

/** LLM 없이 제목 기반으로 활동 초안을 만든다. 모두 needs_review=true. */
export function rulesExtraction(reps: Array<{ rep: EmailRow; size: number; all: EmailRow[] }>): Extraction {
  return {
    activities: reps.map(({ rep, all }) => ({
      description: rep.direction === 'sent' ? `"${rep.subject || '(제목 없음)'}" 메일 발송` : `"${rep.subject || '(제목 없음)'}" 메일 수신`,
      activity_type: rep.direction === 'sent' ? 'sent_work' : 'received_request',
      project_name: rep.projectName,
      evidence_email_ids: all.map((e) => e.id),
      confidence: 0.3,
    })),
    unresolved_requests: [],
    notes: '규칙 기반 추출: 제목만으로 만든 초안이므로 전부 확인이 필요합니다.',
  };
}

/** 특정 날짜의 업무 활동을 추출해 work_activities 에 저장한다 (해당 날짜의 기존 결과는 교체). */
export async function extractWorkActivities(db: Db, workDate: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const mode = opts.mode ?? 'llm';
  const rows = await emailsForDate(db, workDate);
  const reps = pickRepresentatives(rows, opts.maxThreads ?? 40);
  const validIds = new Set(rows.map((r) => r.id));

  let extraction: Extraction;
  let model: string | null = null;
  if (reps.length === 0) {
    extraction = { activities: [], unresolved_requests: [], notes: '해당 날짜에 분석할 메일이 없습니다.' };
  } else if (mode === 'rules') {
    extraction = rulesExtraction(reps);
  } else {
    const llm = getWorklogLLM();
    model = llm.model;
    const compact = reps.map((r) => toCompact(r.rep, r.size, opts.sentBodyChars ?? 1200, opts.receivedBodyChars ?? 600));
    extraction = await llm.extract(workDate, compact, projectRules().map((p) => p.name));
  }

  // 근거 검증: 입력에 없는 id 는 제거하고, 근거가 남지 않으면 확인 필요로 표시
  let invalidEvidenceCount = 0;
  const idToThread = new Map(rows.map((r) => [r.id, r.threadKey]));
  const prepared = extraction.activities.map((a) => {
    const evidence = a.evidence_email_ids.filter((id) => {
      const ok = validIds.has(id);
      if (!ok) invalidEvidenceCount++;
      return ok;
    });
    const needsReview = evidence.length === 0 || a.confidence < 0.6 || mode === 'rules';
    return {
      emailId: evidence[0] ?? null,
      activityDate: workDate,
      projectName: a.project_name,
      activityType: a.activity_type,
      description: a.description,
      evidenceEmailIds: evidence,
      threadKey: evidence[0] !== undefined ? idToThread.get(evidence[0]) ?? null : null,
      needsReview,
      confidence: a.confidence,
      extractor: mode,
    };
  });

  const activities = await db.transaction(async (tx) => {
    await tx.delete(workActivities).where(eq(workActivities.activityDate, workDate));
    if (prepared.length === 0) return [] as WorkActivityRow[];
    return tx.insert(workActivities).values(prepared).returning();
  });

  const unresolved = extraction.unresolved_requests.map((u) => ({ ...u, evidence_email_ids: u.evidence_email_ids.filter((id) => validIds.has(id)) }));

  return {
    workDate,
    mode,
    model,
    emailsConsidered: rows.length,
    threads: reps.length,
    activities,
    unresolvedRequests: unresolved,
    notes: extraction.notes,
    invalidEvidenceCount,
  };
}
