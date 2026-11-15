// 메일 초안(나에게만) 통합 테스트 — 실제 PostgreSQL + 목 POP3 + 목 SMTP.
// 실행: DATABASE_URL=postgres://... node --test test/drafts.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { simpleParser } from 'mailparser';
import { startPop3, startSmtp } from './mock-servers.mjs';

process.env.HIWORKS_USERNAME = 'me@hiworks.com';
process.env.HIWORKS_PASSWORD = 'secret';
process.env.HIWORKS_POP3_HOST = '127.0.0.1';
process.env.HIWORKS_POP3_PORT = '11130';
process.env.HIWORKS_POP3_TLS = 'false';
process.env.HIWORKS_SMTP_HOST = '127.0.0.1';
process.env.HIWORKS_SMTP_PORT = '11131';
process.env.HIWORKS_SMTP_SECURE = 'false';
process.env.MCP_AUTH_TOKEN = 'test-token-0123456789abcdef';
process.env.DRAFT_URL_HOSTS = 'nas.example.com';
process.env.DRAFT_PER_HOUR = '5';
for (const k of Object.keys(process.env)) if (k.startsWith('ACCOUNT_')) delete process.env[k];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없어 drafts 테스트를 건너뜁니다.');
  process.exit(0);
}

const { getDb, closeDb, getPool } = await import('../build/db/client.js');
const { runMigrations } = await import('../build/db/migrate.js');
const { listAccounts, withAccount, MAIN_ACCOUNT } = await import('../build/account.js');
const { runSync } = await import('../build/sync/runner.js');
const { searchEmails } = await import('../build/search/query.js');
const { importMessages } = await import('../build/sync/import.js');
const { sendDraftToSelf, resetDraftLimits } = await import('../build/drafts.js');
const { createHttpServer } = await import('../build/remote/server.js');

const MAIN = listAccounts().find((a) => a.key === MAIN_ACCOUNT);
const asMain = (fn) => withAccount(MAIN, fn);
let pop, smtp, db, m1, m2;

before(async () => {
  await getPool().query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await runMigrations();
  db = getDb();
  pop = await startPop3(11130);
  smtp = await startSmtp(11131);
  await asMain(() => runSync(db, { force: true }));
  const all = await asMain(() => searchEmails(db, { limit: 50 }));
  m1 = all.emails.find((e) => e.subject === '견적서 송부');
  m2 = all.emails.find((e) => e.subject === '회의 일정 조율');
  assert.ok(m1 && m2, '목 메일 동기화');
});
after(async () => {
  await pop.state.stop();
  await new Promise((r) => smtp.server.close(r));
  await closeDb();
});

const last = () => smtp.state.sent.at(-1);
/** quoted-printable/base64 본문을 대충 풀어 글자를 찾는다 */
const decoded = (data) => {
  const qp = data.replace(/=\r?\n/g, '').replace(/(=[0-9A-F]{2})+/g, (m) => Buffer.from(m.split('=').filter(Boolean).map((h) => parseInt(h, 16))).toString('utf8'));
  const b64 = [...data.matchAll(/\n\n([A-Za-z0-9+/=\n]{20,})\n/g)].map((m) => Buffer.from(m[1].replace(/\n/g, ''), 'base64').toString('utf8')).join('\n');
  return qp + '\n' + b64;
};

test('초안: 실제 수신자는 본인 하나, 외부 받는 사람·참조는 안내에만, 첨부·머리글', async () => {
  resetDraftLimits();
  const before = smtp.state.sent.length;
  const r = await asMain(() =>
    sendDraftToSelf(db, {
      to: ['kim@vendor.com', 'outside@gmail.com'],
      cc: ['boss@hiworks.com'],
      bcc: ['secret@other.org'],
      subject: '견적서 회신',
      body: '안녕하세요. 견적서 확인했습니다.',
      attachments: [{ emailId: m1.id, filename: '견적서' }],
    })
  );
  assert.equal(r.success, true);
  assert.equal(r.deliveredTo, 'me@hiworks.com');
  assert.equal(smtp.state.sent.length, before + 1);
  const sent = last();
  assert.deepEqual(sent.to, ['<me@hiworks.com>'], '봉투 수신자는 본인 하나');
  assert.match(sent.from, /me@hiworks\.com/);
  const head = sent.data.split('\n\n')[0];
  assert.match(head, /^To: me@hiworks\.com$/m);
  assert.doesNotMatch(head, /^Cc:/m);
  assert.doesNotMatch(head, /^Bcc:/m);
  assert.match(head, /^X-Hiworks-MCP-Draft: 1$/im);
  assert.match(head, /^X-Draft-To: kim@vendor\.com, outside@gmail\.com$/im);
  const text = decoded(sent.data);
  assert.match(text, /받는 사람: kim@vendor\.com, outside@gmail\.com/);
  assert.match(text, /참조: boss@hiworks\.com/);
  assert.match(text, /견적서 확인했습니다/);
  assert.match(text, /quote content 123/, '메일 첨부를 POP3 원본에서 가져와 붙임');
  const parsed = await simpleParser(sent.data.replace(/\n/g, '\r\n'));
  assert.deepEqual(parsed.attachments.map((a) => [a.filename, a.content.toString()]), [['견적서.txt', 'quote content 123']]);
  assert.equal(parsed.subject, '[초안] 견적서 회신');
  assert.deepEqual(r.attachments.map((a) => a.from), [`메일 ${m1.id}`]);
});

test('답장 초안: 원래 메일과 같은 스레드(In-Reply-To·References)', async () => {
  resetDraftLimits();
  await asMain(() => sendDraftToSelf(db, { to: ['lee@partner.co.kr'], subject: 'Re: 회의 일정 조율', body: '화요일 좋습니다.', replyToEmailId: m2.id }));
  const head = last().data.split('\n\n')[0];
  assert.match(head, /^In-Reply-To: <m2@test>$/m);
  assert.match(head, /^References: .*<m2@test>/m);
});

test('url 첨부: 허용 호스트·https 만, 큰 파일·실패 거부', async () => {
  resetDraftLimits();
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (u, init) => {
    calls.push(String(u));
    if (String(u).includes('/gone')) return new Response('x', { status: 404 });
    if (String(u).includes('/big')) return new Response(Buffer.alloc(21 * 1024 * 1024));
    assert.equal(init.redirect, 'error');
    return new Response('nas file body', { headers: { 'content-type': 'application/pdf', 'content-disposition': "attachment; filename*=UTF-8''%EC%A0%9C%EC%95%88%EC%84%9C.pdf" } });
  };
  try {
    const base = { to: ['a@b.com'], subject: '자료', body: '첨부' };
    const ok = await asMain(() => sendDraftToSelf(db, { ...base, attachments: [{ url: 'https://nas.example.com/dl/abc' }] }));
    assert.deepEqual(ok.attachments.map((a) => a.name), ['제안서.pdf']);
    assert.match(decoded(last().data), /nas file body/);
    const n = smtp.state.sent.length;
    await assert.rejects(asMain(() => sendDraftToSelf(db, { ...base, attachments: [{ url: 'http://nas.example.com/dl/abc' }] })), /https 만/);
    await assert.rejects(asMain(() => sendDraftToSelf(db, { ...base, attachments: [{ url: 'https://evil.example.com/x' }] })), /허용 호스트 아님/);
    await assert.rejects(asMain(() => sendDraftToSelf(db, { ...base, attachments: [{ url: 'https://nas.example.com/gone' }] })), /HTTP 404/);
    await assert.rejects(asMain(() => sendDraftToSelf(db, { ...base, attachments: [{ url: 'https://nas.example.com/big' }] })), /너무 큽니다/);
    assert.equal(smtp.state.sent.length, n, '실패하면 아무 메일도 안 나감');
    assert.equal(calls.filter((c) => c.includes('evil')).length, 0, '허용 안 된 호스트는 요청도 안 함');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('입력 검증과 시간당 한도', async () => {
  resetDraftLimits();
  const n = smtp.state.sent.length;
  await assert.rejects(asMain(() => sendDraftToSelf(db, { to: [], subject: 's', body: 'b' })), /받는 사람을 한 명 이상/);
  await assert.rejects(asMain(() => sendDraftToSelf(db, { to: ['not-an-address'], subject: 's', body: 'b' })), /주소 형식이 아닙니다/);
  await assert.rejects(asMain(() => sendDraftToSelf(db, { to: ['a@b.com'], subject: '  ', body: 'b' })), /제목이 비어/);
  await assert.rejects(asMain(() => sendDraftToSelf(db, { to: ['a@b.com'], subject: 's', body: 'b', attachments: [{}] })), /emailId\(메일 첨부\) 또는 url/);
  await assert.rejects(asMain(() => sendDraftToSelf(db, { to: ['a@b.com'], subject: 's', body: 'b', replyToEmailId: 999999 })), /답장할 메일을 찾을 수 없습니다/);
  assert.equal(smtp.state.sent.length, n);
  // 제목 줄바꿈으로 머리글을 끼워 넣을 수 없음
  await asMain(() => sendDraftToSelf(db, { to: ['a@b.com'], subject: 'x\r\nBcc: victim@evil.com', body: 'b' }));
  assert.deepEqual(last().to, ['<me@hiworks.com>']);
  assert.doesNotMatch(last().data.split('\n\n')[0], /^Bcc:/m);
  for (let i = 0; i < 4; i++) await asMain(() => sendDraftToSelf(db, { to: ['a@b.com'], subject: `n${i}`, body: 'b' }));
  await assert.rejects(asMain(() => sendDraftToSelf(db, { to: ['a@b.com'], subject: 'over', body: 'b' })), /한 시간에 5통/);
});

test('본인에게 온 초안은 동기화 때 보낸 메일로 세지 않음', async () => {
  const raw = last().data.replace(/\n/g, '\r\n');
  const r = await asMain(() => importMessages(db, Buffer.from(raw), { selfEmail: 'me@hiworks.com' }));
  assert.equal(r.newCount, 1);
  const sent = await asMain(() => searchEmails(db, { direction: 'sent', limit: 50 }));
  assert.ok(!sent.emails.some((e) => e.subject?.startsWith('[초안]')));
  const received = await asMain(() => searchEmails(db, { direction: 'received', query: '초안', limit: 50 }));
  assert.ok(received.emails.some((e) => e.subject?.startsWith('[초안]')));
});

test('MCP 도구 create_draft: 목록·주의 표시·호출', async () => {
  resetDraftLimits();
  const server = createHttpServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } } }));
    const tool = (await client.listTools()).tools.find((t) => t.name === 'create_draft');
    assert.ok(tool);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.match(tool.description, /아무에게도 보내지 않습니다/);
    assert.ok(!(await client.listTools()).tools.some((t) => /^send_|reply_email/.test(t.name)), '보내기 도구 없음');
    const res = JSON.parse((await client.callTool({ name: 'create_draft', arguments: { to: ['x@y.com'], subject: '도구', body: '본문' } })).content[0].text);
    assert.equal(res.success, true, res.error);
    assert.deepEqual(last().to, ['<me@hiworks.com>']);
    await client.close();
  } finally {
    await new Promise((r) => server.close(r));
  }
});
