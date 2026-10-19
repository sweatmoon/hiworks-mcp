import { and, eq, inArray } from 'drizzle-orm';
import { acct } from '../account.js';
import type { Db } from '../db/client.js';
import { dailyWorklogs, emails, workActivities, type DailyWorklogRow } from '../db/schema.js';
import { formatKST } from '../utils/date.js';
import { extractWorkActivities, type ExtractOptions } from './extract.js';

export interface WorklogJson {
  work_date: string;
  generated_at: string;
  extractor: string;
  model: string | null;
  summary: { emails: number; threads: number; activities: number; needs_review: number };
  projects: Array<{
    project: string;
    activities: Array<{
      id: number;
      type: string;
      description: string;
      needs_review: boolean;
      confidence: number | null;
      evidence: Array<{ id: number; subject: string; direction: string; date: string; from: string }>;
    }>;
  }>;
  unresolved_requests: Array<{ description: string; requester: string; evidence_email_ids: number[] }>;
  notes: string;
}

const TYPE_LABEL: Record<string, string> = {
  sent_work: '수행 업무',
  received_request: '수신 요청',
  follow_up: '후속 조치',
  other: '기타',
};

export function renderMarkdown(j: WorklogJson): string {
  const lines: string[] = [];
  lines.push(`# 업무일지 ${j.work_date}`);
  lines.push('');
  lines.push(`- 분석 메일 ${j.summary.emails}통 (스레드 ${j.summary.threads}개), 활동 ${j.summary.activities}건, 확인 필요 ${j.summary.needs_review}건`);
  lines.push(`- 추출 방식: ${j.extractor}${j.model ? ` (${j.model})` : ''}`);
  lines.push('');
  if (j.projects.length === 0) {
    lines.push('해당 날짜에 기록할 업무 활동이 없습니다.');
  }
  for (const p of j.projects) {
    lines.push(`## ${p.project}`);
    for (const a of p.activities) {
      const flag = a.needs_review ? ' **[확인 필요]**' : '';
      lines.push(`- [${TYPE_LABEL[a.type] ?? a.type}] ${a.description}${flag}`);
      for (const e of a.evidence) {
        lines.push(`  - 근거: #${e.id} ${e.direction === 'sent' ? '발신' : '수신'} "${e.subject}" (${e.from}, ${e.date})`);
      }
    }
    lines.push('');
  }
  if (j.unresolved_requests.length) {
    lines.push('## 미해결 요청');
    for (const u of j.unresolved_requests) {
      lines.push(`- ${u.description} (요청자: ${u.requester}, 근거: ${u.evidence_email_ids.map((id) => `#${id}`).join(', ') || '없음 **[확인 필요]**'})`);
    }
    lines.push('');
  }
  if (j.notes) {
    lines.push('## 비고');
    lines.push(j.notes);
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

export interface GenerateResult {
  worklog: DailyWorklogRow;
  json: WorklogJson;
  markdown: string;
}

/** 활동을 (재)추출하고 Markdown/JSON 업무일지를 만들어 daily_worklogs 에 저장한다. */
export async function generateDailyWorklog(db: Db, workDate: string, opts: ExtractOptions & { reuseActivities?: boolean } = {}): Promise<GenerateResult> {
  let extractor: string;
  let model: string | null = null;
  let threads = 0;
  let emailsCount = 0;
  let unresolved: WorklogJson['unresolved_requests'] = [];
  let notes = '';

  let activities;
  if (opts.reuseActivities) {
    activities = await db.select().from(workActivities).where(and(eq(workActivities.account, acct()), eq(workActivities.activityDate, workDate)));
    extractor = activities[0]?.extractor ?? 'none';
  } else {
    const r = await extractWorkActivities(db, workDate, opts);
    activities = r.activities;
    extractor = r.mode;
    model = r.model;
    threads = r.threads;
    emailsCount = r.emailsConsidered;
    unresolved = r.unresolvedRequests;
    notes = r.notes;
  }

  const evidenceIds = Array.from(new Set(activities.flatMap((a) => a.evidenceEmailIds)));
  const evidenceRows = evidenceIds.length ? await db.select().from(emails).where(and(eq(emails.account, acct()), inArray(emails.id, evidenceIds))) : [];
  const byId = new Map(evidenceRows.map((e) => [e.id, e]));

  const groups = new Map<string, WorklogJson['projects'][number]['activities']>();
  for (const a of activities) {
    const key = a.projectName || '(사업 미분류)';
    const list = groups.get(key) ?? [];
    list.push({
      id: a.id,
      type: a.activityType,
      description: a.description,
      needs_review: a.needsReview,
      confidence: a.confidence,
      evidence: a.evidenceEmailIds
        .map((id) => byId.get(id))
        .filter((e): e is NonNullable<typeof e> => Boolean(e))
        .map((e) => ({ id: e.id, subject: e.subject, direction: e.direction, date: e.sentAt ? formatKST(e.sentAt) : '', from: e.sender })),
    });
    groups.set(key, list);
  }

  const json: WorklogJson = {
    work_date: workDate,
    generated_at: formatKST(new Date()),
    extractor,
    model,
    summary: { emails: emailsCount, threads, activities: activities.length, needs_review: activities.filter((a) => a.needsReview).length },
    projects: Array.from(groups.entries())
      .sort(([a], [b]) => (a.startsWith('(') ? 1 : 0) - (b.startsWith('(') ? 1 : 0) || a.localeCompare(b))
      .map(([project, acts]) => ({ project, activities: acts })),
    unresolved_requests: unresolved,
    notes,
  };
  const markdown = renderMarkdown(json);
  const now = new Date();
  const [worklog] = await db
    .insert(dailyWorklogs)
    .values({ account: acct(), workDate, content: markdown, contentJson: json as unknown as Record<string, unknown>, model, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [dailyWorklogs.account, dailyWorklogs.workDate], set: { content: markdown, contentJson: json as unknown as Record<string, unknown>, model, updatedAt: now } })
    .returning();
  return { worklog, json, markdown };
}

export async function getWorklog(db: Db, workDate: string): Promise<DailyWorklogRow | null> {
  const rows = await db.select().from(dailyWorklogs).where(and(eq(dailyWorklogs.account, acct()), eq(dailyWorklogs.workDate, workDate))).limit(1);
  return rows[0] ?? null;
}
