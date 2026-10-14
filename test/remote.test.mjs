// 실제 PostgreSQL(DATABASE_URL) + 목 POP3 + 가짜 LLM 으로 원격 서버 전체를 검증하는 통합 테스트.
// 실행: DATABASE_URL=postgres://... node --test test/remote.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startPop3, messages as pop3Messages } from './mock-servers.mjs';

process.env.HIWORKS_USERNAME = 'me@hiworks.com';
process.env.HIWORKS_PASSWORD = 'secret';
process.env.HIWORKS_POP3_HOST = '127.0.0.1';
process.env.HIWORKS_POP3_PORT = '11120';
process.env.HIWORKS_POP3_TLS = 'false';
process.env.MCP_AUTH_TOKEN = 'test-token-0123456789abcdef';
process.env.PROJECT_RULES = JSON.stringify([{ name: 'A사업', keywords: ['A사업', '견적'] }, { name: 'B사업', keywords: ['계약서'] }]);
process.env.SYNC_INTERVAL_MINUTES = '10';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없어 remote 테스트를 건너뜁니다.');
  process.exit(0);
}

const { getDb, closeDb, getPool } = await import('../build/db/client.js');
const { runMigrations } = await import('../build/db/migrate.js');
const { importMessages, extractMessages } = await import('../build/sync/import.js');
const { runSync } = await import('../build/sync/runner.js');
const { withAdvisoryLock, SYNC_LOCK_KEY } = await import('../build/sync/lock.js');
const { getSyncState } = await import('../build/sync/state.js');
const { searchEmails, getEmailById } = await import('../build/search/query.js');
const { getStatistics } = await import('../build/stats/statistics.js');
const { extractWorkActivities } = await import('../build/worklog/extract.js');
const { generateDailyWorklog, getWorklog } = await import('../build/worklog/generate.js');
const { setWorklogLLM } = await import('../build/worklog/llm.js');
const { createHttpServer } = await import('../build/remote/server.js');
const { threadKeyOf } = await import('../build/sync/store.js');
const { createTask, updateTask, listTasks, getTask, findActionableEmails, buildDailyBrief, getReplyContext } = await import('../build/tasks/service.js');

const CRLF = '\r\n';
// 실제 메일 클라이언트처럼 제목은 RFC 2047 로 인코딩한다 (raw 8bit 헤더는 파서마다 처리가 다르다)
const enc = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
function eml({ id, from, to, subject, date, text, inReplyTo }) {
  return [
    `Message-ID: <${id}>`, `From: ${from}`, `To: ${to}`, ...(inReplyTo ? [`In-Reply-To: <${inReplyTo}>`] : []),
    `Subject: ${enc(subject)}`, `Date: ${date}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text,
  ].join(CRLF);
}

const SELF = 'me@hiworks.com';
const sentBackup = [
  eml({ id: 's1@self', from: `Me <${SELF}>`, to: 'kim@vendor.com', subject: '[A사업] 견적서를 요청드립니다', date: 'Tue, 02 Sep 2025 10:00:00 +0900', text: 'A사업 관련 견적서를 9/5까지 보내주시면 감사하겠습니다.' }),
  eml({ id: 's2@self', from: `Me <${SELF}>`, to: 'lee@partner.co.kr, boss@hiworks.com', subject: 'Re: 회의 일정 조율', date: 'Tue, 02 Sep 2025 16:00:00 +0900', text: '네, 화요일 오후 2시에 뵙겠습니다.', inReplyTo: 'm2@test' }),
  eml({ id: 's3@self', from: `Me <${SELF}>`, to: 'park@client.com', subject: '계약서 검토 의견', date: 'Wed, 03 Sep 2025 09:30:00 +0900', text: '계약서 3조 수정 의견 드립니다.' }),
];
const mbox = ['From - Mon Sep 01 00:00:00 2025', eml({ id: 'mb1@self', from: `Me <${SELF}>`, to: 'x@y.com', subject: '월간 보고', date: 'Mon, 01 Sep 2025 18:00:00 +0900', text: '8월 보고서 송부' }), 'From - Mon Sep 01 00:00:00 2025', eml({ id: 'mb2@self', from: `Me <${SELF}>`, to: 'x@y.com', subject: '>From 테스트', date: 'Mon, 01 Sep 2025 19:00:00 +0900', text: '>From 줄이 있는 본문\n내용' })].join('\n') + '\n';

let pop;
let db;
before(async () => {
  const pool = getPool();
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await runMigrations();
  db = getDb();
  pop = await startPop3(11120);
});
after(async () => {
  await pop.state.stop();
  await closeDb();
});

test('import: zip of EML (sent backup), dedup, mbox', async () => {
  const zip = zipSync({ 'sent/s1.eml': strToU8(sentBackup[0]), 'sent/s2.eml': strToU8(sentBackup[1]), 'sent/s3.eml': strToU8(sentBackup[2]), 'readme.txt': strToU8('ignore me') });
  const r = await importMessages(db, Buffer.from(zip), { filename: 'sent-backup.zip', direction: 'sent' });
  assert.equal(r.newCount, 3);
  assert.equal(r.failed, 0);
  const again = await importMessages(db, Buffer.from(zip), { filename: 'sent-backup.zip', direction: 'sent' });
  assert.equal(again.newCount, 0);
  assert.equal(again.skippedCount, 3);
  // direction 추정 (selfEmail) + mbox 분리
  const m = await importMessages(db, Buffer.from(mbox), { filename: 'sent.mbox', selfEmail: SELF });
  assert.equal(m.newCount, 2);
  const s = await searchEmails(db, { direction: 'sent', limit: 50 });
  assert.equal(s.total, 5);
  assert.ok(s.emails.find((e) => e.subject === '>From 테스트'));
  // Message-ID 없는 메일도 지문으로 중복 방지
  const noId = Buffer.from(['From: a@b.com', 'To: me@hiworks.com', 'Subject: no id', 'Date: Thu, 04 Sep 2025 10:00:00 +0900', '', 'body'].join(CRLF));
  assert.equal((await importMessages(db, noId)).newCount, 1);
  assert.equal((await importMessages(db, noId)).newCount, 0);
  // project 분류
  const a = await searchEmails(db, { project: 'A사업' });
  assert.equal(a.total, 1);
  assert.equal(extractMessages(Buffer.from('plain'), 'x.eml').length, 1);
});

test('inbox sync: incremental, bcc-to-self as sent, uid backfill, lock', async () => {
  // 백업으로 먼저 들어온 메일(m1@test 와 같은 Message-ID)이 POP3 에도 있으면 uid 만 보강된다
  const pre = await importMessages(db, Buffer.from(pop3Messages[0]), { direction: 'received' });
  assert.equal(pre.newCount, 1);
  const first = await runSync(db, { sources: ['pop3'] });
  assert.equal(first.acquired, true);
  assert.equal(first.results[0].ok, true);
  assert.equal(first.results[0].newCount, 3); // 4 on server, 1 pre-imported
  assert.equal(first.results[0].skippedCount, 1);
  const backfilled = await searchEmails(db, { subject: '견적서 송부' });
  assert.equal(backfilled.total, 1);
  const detail = await getEmailById(db, backfilled.emails[0].id);
  assert.equal(detail.source, 'pop3');
  assert.equal(detail.attachments.length, 1);
  assert.equal(detail.attachments[0].filename, '견적서.txt');

  const second = await runSync(db, { sources: ['pop3'] });
  assert.equal(second.results[0].newCount, 0);

  // 숨은참조로 자신에게 보낸 사본은 sent 로 분류
  pop.state.messages.push(eml({ id: 'bcc1@self', from: `Me <${SELF}>`, to: 'ext@corp.com', subject: '발주서 송부', date: 'Thu, 04 Sep 2025 15:00:00 +0900', text: '발주서 보냅니다.' }));
  const third = await runSync(db, { sources: ['pop3'] });
  assert.equal(third.results[0].newCount, 1);
  const sent = await searchEmails(db, { direction: 'sent', subject: '발주서' });
  assert.equal(sent.total, 1);
  assert.equal(sent.emails[0].direction, 'sent');

  // 다른 세션이 잠금을 쥐고 있으면 실행하지 않는다
  const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await other.connect();
  await other.query('select pg_advisory_lock(hashtext($1))', [SYNC_LOCK_KEY]);
  const blocked = await runSync(db, { sources: ['pop3'] });
  assert.equal(blocked.acquired, false);
  await other.end();
  const inner = await withAdvisoryLock('other-key', async () => 42);
  assert.deepEqual(inner, { acquired: true, result: 42 });

  const state = await getSyncState(db, 'pop3');
  assert.equal(state.status, 'ok');
  assert.equal(state.consecutiveFailures, 0);
  assert.ok(state.lastSuccessAt);
});

test('sync failure: error recorded, backoff, force', async () => {
  process.env.HIWORKS_PASSWORD = 'wrong';
  const failed = await runSync(db, { sources: ['pop3'] });
  assert.equal(failed.results[0].ok, false);
  assert.match(failed.results[0].error, /Authentication/);
  let state = await getSyncState(db, 'pop3');
  assert.equal(state.status, 'error');
  assert.equal(state.consecutiveFailures, 1);
  assert.ok(state.nextRetryAt.getTime() > Date.now());
  const skipped = await runSync(db, { sources: ['pop3'] });
  assert.match(skipped.results[0].skippedReason, /백오프/);
  process.env.HIWORKS_PASSWORD = 'secret';
  const forced = await runSync(db, { sources: ['pop3'], force: true });
  assert.equal(forced.results[0].ok, true);
  state = await getSyncState(db, 'pop3');
  assert.equal(state.status, 'ok');
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.nextRetryAt, null);
});

test('search: korean partial match, multi-term AND, filters, pagination, relevance', async () => {
  const r1 = await searchEmails(db, { query: '견적' });
  assert.ok(r1.total >= 2, 'partial match on 견적서/견적서를');
  const r2 = await searchEmails(db, { query: '견적 9/5' });
  assert.equal(r2.total, 1, JSON.stringify(r2.emails.map((e) => [e.subject, e.snippet, e.sender, e.to])));
  assert.equal(r2.emails[0].subject, '[A사업] 견적서를 요청드립니다');
  const r3 = await searchEmails(db, { from: 'vendor' });
  assert.equal(r3.total, 1);
  const r4 = await searchEmails(db, { to: 'boss@hiworks.com' });
  assert.equal(r4.total, 2); // m2(cc boss) + s2(to boss)
  const r5 = await searchEmails(db, { since: '2025-09-03', before: '2025-09-03' });
  assert.ok(r5.emails.every((e) => e.date.startsWith('2025-09-03')));
  assert.equal(r5.total, 2); // s3 발신 + m3 뉴스레터 (m4 는 9/4)
  const page1 = await searchEmails(db, { limit: 2, offset: 0 });
  const page2 = await searchEmails(db, { limit: 2, offset: 2 });
  assert.equal(page1.emails.length, 2);
  assert.notEqual(page1.emails[0].id, page2.emails[0].id);
  assert.equal(page1.total, page2.total);
  const rel = await searchEmails(db, { query: '회의', sort: 'relevance' });
  assert.ok(rel.total >= 2);
  const asc = await searchEmails(db, { sort: 'date_asc', limit: 1 });
  assert.ok(asc.emails[0].date.startsWith('2025-09-01'));
  const detail = await getEmailById(db, r2.emails[0].id, { maxLength: 5 });
  assert.equal(detail.truncated, true);
  assert.equal(threadKeyOf('Re: RE: Fwd: 회의 일정 조율'), '회의 일정 조율');
});

test('statistics: totals, series, top counterparts, projects, pending requests', async () => {
  const s = await getStatistics(db, { since: '2025-09-01', before: '2025-09-30', granularity: 'day', selfEmail: SELF });
  assert.equal(s.totals.sent, 6);
  assert.equal(s.totals.received, 5);
  assert.equal(s.totals.total, 11);
  assert.equal(s.totals.withAttachments, 1);
  assert.ok(s.series.find((b) => b.bucket === '2025-09-02' && b.sent === 2 && b.received === 1));
  assert.ok(s.topSenders.find((t) => t.email === 'kim@vendor.com'));
  assert.ok(s.topRecipients.find((t) => t.email === 'x@y.com' && t.count === 2));
  assert.ok(!s.topRecipients.find((t) => t.email === SELF));
  assert.ok(s.byProject.find((p) => p.project === 'A사업' && p.total === 2), JSON.stringify(s.byProject)); // s1 + m1(키워드 견적)
  assert.ok(s.byProject.find((p) => p.project === 'B사업' && p.total === 2));
  // "회의 일정 조율" 요청은 답장(Re:)이 있어 미처리가 아니고, "[긴급] 계약서 검토 요청" 은 Re: 답장이 없어 후보에 오른다
  const pendingSubjects = s.pendingRequests.map((p) => p.subject);
  assert.ok(pendingSubjects.includes('[긴급] 계약서 검토 요청'));
  assert.ok(!pendingSubjects.includes('회의 일정 조율'));
  const weekly = await getStatistics(db, { since: '2025-09-01', before: '2025-09-30', granularity: 'month' });
  assert.equal(weekly.series.length, 1);
});

test('worklog: fake LLM evidence validation, rules mode, markdown/json, persistence', async () => {
  const seen = { calls: 0, lastEmails: null };
  setWorklogLLM({
    model: 'fake-model',
    async extract(workDate, emails, projects) {
      seen.calls++;
      seen.lastEmails = emails;
      assert.deepEqual(projects, ['A사업', 'B사업']);
      const sent = emails.find((e) => e.subject.includes('견적서를'));
      return {
        activities: [
          { description: 'A사업 견적서 요청 메일 발송', activity_type: 'sent_work', project_name: 'A사업', evidence_email_ids: [sent.id], confidence: 0.9 },
          { description: '회의 일정 확정 회신', activity_type: 'follow_up', project_name: null, evidence_email_ids: [emails.find((e) => e.subject.includes('회의')).id], confidence: 0.8 },
          { description: '지어낸 업무', activity_type: 'other', project_name: null, evidence_email_ids: [999999], confidence: 0.95 },
        ],
        unresolved_requests: [{ description: '회의 일정 회신 요청', requester: 'lee@partner.co.kr', evidence_email_ids: [999998] }],
        notes: '테스트 노트',
      };
    },
  });
  const r = await extractWorkActivities(db, '2025-09-02');
  assert.equal(seen.calls, 1);
  assert.equal(r.model, 'fake-model');
  assert.equal(r.emailsConsidered, 3); // s1, s2(sent), m2(received, same thread as s2)
  assert.equal(r.threads, 2);
  assert.ok(seen.lastEmails.every((e) => e.body.length <= 1200));
  assert.equal(r.activities.length, 3);
  const fabricated = r.activities.find((a) => a.description === '지어낸 업무');
  assert.equal(fabricated.needsReview, true);
  assert.deepEqual(fabricated.evidenceEmailIds, []);
  assert.equal(r.invalidEvidenceCount, 1);
  assert.equal(r.activities.find((a) => a.projectName === 'A사업').needsReview, false);
  assert.deepEqual(r.unresolvedRequests[0].evidence_email_ids, []);

  const g = await generateDailyWorklog(db, '2025-09-02');
  assert.equal(seen.calls, 2);
  assert.match(g.markdown, /# 업무일지 2025-09-02/);
  assert.match(g.markdown, /## A사업/);
  assert.match(g.markdown, /지어낸 업무 \*\*\[확인 필요\]\*\*/);
  assert.match(g.markdown, /근거: #\d+ 발신 "\[A사업\] 견적서를 요청드립니다"/);
  assert.equal(g.json.summary.needs_review, 1);
  assert.equal(g.json.projects[0].project, 'A사업');
  const stored = await getWorklog(db, '2025-09-02');
  assert.equal(stored.content, g.markdown);
  assert.equal(stored.model, 'fake-model');

  // 저장된 활동 재사용 (LLM 호출 없음) + 업서트
  const reuse = await generateDailyWorklog(db, '2025-09-02', { reuseActivities: true });
  assert.equal(seen.calls, 2);
  assert.equal(reuse.json.summary.activities, 3);

  // 규칙 기반 (LLM 없이), 모두 확인 필요
  setWorklogLLM(null);
  const rules = await extractWorkActivities(db, '2025-09-03', { mode: 'rules' });
  assert.ok(rules.activities.length >= 1); // 9/3: s3 발신, m4 수신, m3 는 뉴스레터로 제외
  assert.ok(rules.activities.every((a) => a.needsReview && a.extractor === 'rules'));
  await assert.rejects(() => extractWorkActivities(db, '2025-09-03'), /ANTHROPIC_API_KEY/);
  const empty = await generateDailyWorklog(db, '2030-01-01', { mode: 'rules' });
  assert.match(empty.markdown, /기록할 업무 활동이 없습니다/);
});

test('tasks: actionable emails, create/update/list, brief, reply context', async () => {
  const cands = await findActionableEmails(db, { since: '2025-09-01', before: '2025-09-30' });
  const subjects = cands.map((c) => c.subject);
  assert.ok(subjects.includes('[긴급] 계약서 검토 요청'), JSON.stringify(subjects));
  assert.ok(!subjects.includes('회의 일정 조율'), '답장한 스레드는 제외');
  assert.ok(!subjects.includes('Weekly Newsletter'), '자동 발신은 제외');
  const urgent = cands.find((c) => c.subject === '[긴급] 계약서 검토 요청');
  assert.ok(urgent.reasons.includes('긴급 표현'));
  assert.equal(urgent.repliedAfter, false);
  assert.deepEqual(urgent.linkedTaskIds, []);

  // 근거 메일로 등록 → 요청자/사업/스레드 자동
  const t1 = await createTask(db, { title: '계약서 검토 의견 회신', sourceEmailId: urgent.id, dueDate: '2025-09-10', priority: 'high', meta: { dueSource: '테스트' } });
  assert.equal(t1.requesterEmail, 'park@client.com');
  assert.equal(t1.projectName, 'B사업');
  assert.equal(t1.threadKey, '[긴급] 계약서 검토 요청');
  assert.equal(t1.overdue, true, '2025-09-10 은 지났다');
  assert.ok(t1.daysLeft < 0);
  await assert.rejects(() => createTask(db, { title: 'x', dueDate: '9/5' }), /YYYY-MM-DD/);
  await assert.rejects(() => createTask(db, { title: 'x', sourceEmailId: 999999 }), /근거 메일/);

  // 등록된 메일은 후보에서 빠지고, includeLinked 면 연결 id 가 보인다
  const after = await findActionableEmails(db, { since: '2025-09-01', before: '2025-09-30' });
  assert.ok(!after.find((c) => c.id === urgent.id));
  const withLinked = await findActionableEmails(db, { since: '2025-09-01', before: '2025-09-30', includeLinked: true });
  assert.deepEqual(withLinked.find((c) => c.id === urgent.id).linkedTaskIds, [t1.id]);

  const t2 = await createTask(db, { title: '월간 보고서 작성', projectName: 'A사업', dueDate: '2099-12-31' });
  const t3 = await createTask(db, { title: '마감 없는 일', priority: 'low' });
  const open = await listTasks(db);
  assert.equal(open.total, 3);
  assert.equal(open.tasks[0].id, t1.id, '마감 임박(지연) 먼저');
  assert.equal(open.tasks[2].id, t3.id, '마감 없는 것은 마지막');
  assert.equal(open.tasks[0].sourceEmail.subject, '[긴급] 계약서 검토 요청');
  const overdue = await listTasks(db, { overdueOnly: true });
  assert.equal(overdue.total, 1);
  const byProject = await listTasks(db, { project: 'A사업' });
  assert.equal(byProject.tasks[0].id, t2.id);
  const byQuery = await listTasks(db, { query: '보고서' });
  assert.equal(byQuery.total, 1);

  const upd = await updateTask(db, t1.id, { status: 'doing', appendNote: '초안 작성 시작' });
  assert.equal(upd.status, 'doing');
  assert.match(upd.notes, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 초안 작성 시작/);
  const done = await updateTask(db, t1.id, { status: 'done' });
  assert.ok(done.completedAt);
  assert.equal(done.overdue, false);
  assert.equal((await listTasks(db)).total, 2);
  assert.equal((await listTasks(db, { status: ['done'] })).total, 1);
  assert.equal(await updateTask(db, 999999, { status: 'done' }), null);
  // 완료된 할 일은 스레드 연결로 치지 않으므로 후보에 다시 나타난다 (source_email_id 직접 연결은 유지)
  const reopened = await findActionableEmails(db, { since: '2025-09-01', before: '2025-09-30', includeLinked: true });
  assert.deepEqual(reopened.find((c) => c.id === urgent.id).linkedTaskIds, [t1.id]);

  const detail = await getTask(db, t1.id);
  assert.equal(detail.sourceEmail.id, urgent.id);
  assert.ok(detail.thread.length >= 1);
  assert.equal(await getTask(db, 999999), null);

  const brief = await buildDailyBrief(db, { date: '2025-09-05', lookbackDays: 2 });
  assert.equal(brief.date, '2025-09-05');
  assert.equal(brief.counts.dueSoon, 0);
  assert.equal(brief.counts.todo, 2);
  assert.ok(brief.recentlyCompleted.find((t) => t.id === t1.id));
  assert.ok(Array.isArray(brief.newActionableEmails));
  assert.equal(brief.sync[0].source, 'pop3');
  const todayBrief = await buildDailyBrief(db);
  assert.equal(todayBrief.counts.overdue, 0, 't1 완료, t2 는 2099');

  const ctx = await getReplyContext(db, { taskId: t1.id });
  assert.equal(ctx.email.id, urgent.id);
  assert.equal(ctx.suggestedSubject, 'Re: [긴급] 계약서 검토 요청');
  assert.deepEqual(ctx.replyTo, ['park@client.com']);
  assert.equal(ctx.myRecentMailsToSender.length, 1, 's3 계약서 검토 의견');
  assert.equal(ctx.task.id, t1.id);
  await assert.rejects(() => getReplyContext(db, { taskId: t3.id }), /emailId/);
  assert.equal(await getReplyContext(db, { emailId: 999999 }), null);
});

test('http server: health, auth, MCP tools over Streamable HTTP, path token, /import', async () => {
  const server = createHttpServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.db, 'ok');
    const unauth = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(unauth.status, 401);
    const badToken = await fetch(`${base}/mcp/wrong-token-xxxxxxxxxxxxxxxx`, { method: 'POST', body: '{}' });
    assert.equal(badToken.status, 401);
    assert.equal((await fetch(`${base}/nope`)).status, 404);

    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } } }));
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const name of ['find_actionable_emails', 'create_task', 'update_task', 'list_tasks', 'get_task', 'daily_brief', 'get_reply_context', 'sync_emails', 'search_emails', 'read_email', 'get_email_statistics', 'get_sent_emails', 'extract_work_activities', 'generate_daily_worklog', 'get_sync_status', 'import_emails', 'search', 'fetch']) {
      assert.ok(tools.includes(name), `tool ${name}`);
    }
    const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
    const s = await call('search_emails', { query: '계약서', limit: 5 });
    assert.equal(s.success, true, s.error);
    assert.equal(s.total, 2, JSON.stringify(s.emails.map((e) => e.subject)));
    const sent = await call('get_sent_emails', { limit: 50 });
    assert.ok(sent.emails.every((e) => e.direction === 'sent'));
    const e = await call('read_email', { id: s.emails[0].id, includeThread: true });
    assert.equal(e.success, true);
    assert.ok(e.email.bodyText.length > 0);
    assert.ok(Array.isArray(e.thread));
    const st = await call('get_sync_status');
    assert.equal(st.success, true);
    assert.equal(st.sources[0].source, 'pop3');
    assert.ok(st.recentRuns.length >= 3);
    assert.equal(st.llmAvailable, false);
    const stats = await call('get_email_statistics', { since: '2025-09-01', before: '2025-09-30' });
    assert.equal(stats.totals.total, 11);
    const wl = await call('get_daily_worklog', { date: '2025-09-02', format: 'markdown' });
    assert.match(wl.markdown, /업무일지/);
    const gen = await call('generate_daily_worklog', { date: '2025-09-04', mode: 'rules', format: 'json' });
    assert.equal(gen.success, true);
    assert.equal(gen.json.extractor, 'rules');
    const chat = await call('search', { query: '견적' });
    assert.ok(chat.results.length >= 2 && chat.results[0].url.startsWith('email://'));
    const fetched = await call('fetch', { id: chat.results[0].id });
    assert.equal(fetched.id, chat.results[0].id);
    assert.match(fetched.text, /From: /);
    const brief = await call('daily_brief', {});
    assert.equal(brief.success, true);
    assert.ok(brief.counts.todo >= 1);
    const created = await call('create_task', { title: 'MCP 로 만든 할 일', sourceEmailId: s.emails[0].id });
    assert.equal(created.success, true);
    assert.equal(created.task.sourceEmailId, s.emails[0].id);
    const listed = await call('list_tasks', { query: 'MCP 로' });
    assert.equal(listed.total, 1);
    const sync = await call('sync_emails', { sources: ['pop3'] });
    assert.equal(sync.acquired, true);
    const imp = await call('import_emails', { contentBase64: Buffer.from(eml({ id: 'tool-import@self', from: `Me <${SELF}>`, to: 'a@b.com', subject: '도구로 가져온 메일', date: 'Fri, 05 Sep 2025 10:00:00 +0900', text: 'x' })).toString('base64'), direction: 'sent' });
    assert.equal(imp.newCount, 1);
    await client.close();

    // ChatGPT 방식: URL 경로 토큰
    const client2 = new Client({ name: 'chatgpt-like', version: '0' });
    await client2.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${process.env.MCP_AUTH_TOKEN}`)));
    const ping = JSON.parse((await client2.callTool({ name: 'ping', arguments: {} })).content[0].text);
    assert.equal(ping.success, true);
    await client2.close();

    // HTTP 업로드 가져오기
    const zip = zipSync({ 'a.eml': strToU8(eml({ id: 'http-import@self', from: `Me <${SELF}>`, to: 'a@b.com', subject: 'HTTP 업로드', date: 'Fri, 05 Sep 2025 11:00:00 +0900', text: 'y' })) });
    const up = await fetch(`${base}/import?direction=sent&filename=backup.zip`, { method: 'POST', headers: { 'x-api-key': process.env.MCP_AUTH_TOKEN, 'content-type': 'application/zip' }, body: Buffer.from(zip) }).then((r) => r.json());
    assert.equal(up.newCount, 1);
    assert.equal((await fetch(`${base}/import`, { method: 'POST', body: 'x' })).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
  }
});
