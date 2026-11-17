// 한 연결에서 여러 메일함(MAILBOX_LINKS) 통합 테스트 — 실제 PostgreSQL 필요.
// 실행: DATABASE_URL=postgres://... node --test test/mailboxes.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

for (const k of Object.keys(process.env)) if (k.startsWith('ACCOUNT_') || k === 'DELEGATE_READ' || k === 'MAILBOX_LINKS') delete process.env[k];
process.env.HIWORKS_USERNAME = 'me@activo.kr';
process.env.HIWORKS_PASSWORD = 'secret';
process.env.MCP_AUTH_TOKEN = 'main-token-0123456789abcdef';
// 붙일 메일함: 토큰 없이 주소·비밀번호만 (동기화 대상)
process.env.ACCOUNT_AUTOMIND_USERNAME = 'me@automind.kr';
process.env.ACCOUNT_AUTOMIND_PASSWORD = 'secret-am';
// 다른 사람
process.env.ACCOUNT_B_USERNAME = 'b@activo.kr';
process.env.ACCOUNT_B_PASSWORD = 'secret-b';
process.env.ACCOUNT_B_TOKEN = 'token-b-0123456789abcdef';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없어 mailboxes 테스트를 건너뜁니다.');
  process.exit(0);
}

const { getDb, closeDb, getPool } = await import('../build/db/client.js');
const { runMigrations } = await import('../build/db/migrate.js');
const { listAccounts, withAccount } = await import('../build/account.js');
const { importMessages } = await import('../build/sync/import.js');
const { createHttpServer } = await import('../build/remote/server.js');
const { parseMailboxLinks, mailboxesFor } = await import('../build/remote/mailboxes.js');

const CRLF = '\r\n';
const enc = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
const eml = (id, from, to, subject, date, text) =>
  [`Message-ID: <${id}>`, `From: ${from}`, `To: ${to}`, `Subject: ${enc(subject)}`, `Date: ${date}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', text].join(CRLF);
const all = () => listAccounts(process.env, { requireToken: false });
const acc = (key) => all().find((a) => a.key === key);
let server, base;
const ids = {};

before(async () => {
  await getPool().query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await runMigrations();
  const db = getDb();
  await withAccount(acc('main'), () => importMessages(db, Buffer.from(eml('a1@x', 'Kim <kim@vendor.com>', 'me@activo.kr', '악티보 견적 요청', 'Mon, 02 Nov 2026 10:00:00 +0900', '견적서 보내 주세요'))));
  await withAccount(acc('main'), () => importMessages(db, Buffer.from(eml('a2@x', 'Lee <lee@vendor.com>', 'me@activo.kr', '악티보 회의', 'Wed, 04 Nov 2026 10:00:00 +0900', '회의 일정'))));
  await withAccount(acc('automind'), () => importMessages(db, Buffer.from(eml('m1@x', 'Park <park@client.com>', 'me@automind.kr', '오토마인드 견적 요청', 'Tue, 03 Nov 2026 10:00:00 +0900', '견적 부탁드립니다'))));
  await withAccount(acc('b'), () => importMessages(db, Buffer.from(eml('b1@x', 'X <x@y.com>', 'b@activo.kr', '다른 사람 견적', 'Thu, 05 Nov 2026 10:00:00 +0900', '비밀'))));
  for (const r of (await getPool().query('select id, account from emails')).rows) ids[r.account] = Number(r.id);
  server = createHttpServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await closeDb();
});

async function connect(token) {
  const client = new Client({ name: 't', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const tools = (await client.listTools()).tools;
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...JSON.parse(r.content[0].text), _isError: Boolean(r.isError) };
  };
  return { client, tools, call };
}

test('설정 해석과 메일함 목록', () => {
  assert.deepEqual(parseMailboxLinks('main:automind, bad , main:main, MAIN:Automind, b:x'), [{ owner: 'main', linked: 'automind' }, { owner: 'b', linked: 'x' }]);
  process.env.MAILBOX_LINKS = 'main:automind,main:nobody';
  try {
    assert.deepEqual(mailboxesFor(acc('main')).map((a) => a.key), ['main', 'automind'], '서버에 없는 계정은 뺌');
    assert.deepEqual(mailboxesFor(acc('b')).map((a) => a.key), ['b']);
  } finally {
    delete process.env.MAILBOX_LINKS;
  }
});

test('붙인 메일함이 없으면 도구 그대로 (mailbox 인자 없음)', async () => {
  delete process.env.MAILBOX_LINKS;
  const { tools, call, client } = await connect(process.env.MCP_AUTH_TOKEN);
  assert.ok(!tools.find((t) => t.name === 'search_emails').inputSchema.properties.mailbox);
  const s = await call('search_emails', { query: '견적' });
  assert.deepEqual(s.emails.map((e) => e.subject), ['악티보 견적 요청']);
  await client.close();
});

test('한 연결에서 두 메일함: 합친 검색·고르기·id 자동·메일함별 통계·할 일·다른 사람은 그대로', async () => {
  process.env.MAILBOX_LINKS = 'main:automind';
  try {
    const { tools, call, client } = await connect(process.env.MCP_AUTH_TOKEN);
    const search = tools.find((t) => t.name === 'search_emails');
    assert.ok(search.inputSchema.properties.mailbox);
    assert.match(search.description, /me@automind\.kr/);
    assert.ok(!tools.find((t) => t.name === 'ping').inputSchema.properties.account);

    // 기본 = 모든 메일함, 날짜순, 메일함 표시
    const both = await call('search_emails', { query: '견적' });
    assert.deepEqual(both.emails.map((e) => [e.subject, e.mailbox]), [
      ['오토마인드 견적 요청', 'me@automind.kr'],
      ['악티보 견적 요청', 'me@activo.kr'],
    ]);
    assert.equal(both.total, 2);
    assert.deepEqual(both.mailboxes, [{ mailbox: 'me@activo.kr', total: 1 }, { mailbox: 'me@automind.kr', total: 1 }]);
    // 페이지 넘기기
    const page2 = await call('search_emails', { limit: 1, offset: 1 });
    assert.equal(page2.emails.length, 1);
    assert.equal(page2.total, 3);
    // 하나만 고르기 (주소·회사 이름)
    assert.deepEqual((await call('search_emails', { query: '견적', mailbox: 'automind' })).emails.map((e) => e.subject), ['오토마인드 견적 요청']);
    assert.deepEqual((await call('search_emails', { query: '견적', mailbox: 'me@activo.kr' })).emails.map((e) => e.subject), ['악티보 견적 요청']);
    const bad = await call('search_emails', { mailbox: 'b@activo.kr' });
    assert.equal(bad._isError, true);
    assert.match(bad.error, /모르는 메일함/);

    // id 로 찾는 도구는 그 메일함에서 자동
    const r = await call('read_email', { id: ids.automind });
    assert.equal(r.success, true, r.error);
    assert.equal(r.email.subject, '오토마인드 견적 요청');
    // 다른 사람 메일 id 는 못 읽음
    assert.equal((await call('read_email', { id: ids.b })).success, false);
    const f = await call('fetch', { id: String(ids.automind) });
    assert.equal(f.title, '오토마인드 견적 요청');
    const s = await call('search', { query: '견적' });
    assert.ok(s.results.some((x) => x.title.startsWith('[me@automind.kr]')));

    // 메일함별로 따로인 도구
    const stats = await call('get_email_statistics', { since: '2026-11-01', before: '2026-11-30' });
    assert.deepEqual(stats.mailboxes.map((m) => m.mailbox), ['me@activo.kr', 'me@automind.kr']);

    // 할 일: 원래 메일의 메일함에 만들어지고 id 로 다시 찾음
    const t = await call('create_task', { title: '오토마인드 견적 회신', sourceEmailId: ids.automind });
    assert.equal(t.success, true, t.error);
    const row = (await getPool().query('select account from tasks where id = $1', [t.task.id])).rows[0];
    assert.equal(row.account, 'automind');
    assert.equal((await call('get_task', { id: t.task.id })).task.title, '오토마인드 견적 회신');
    const list = await call('list_tasks', {});
    assert.deepEqual(list.mailboxes.map((m) => [m.mailbox, (m.tasks ?? []).length]), [['me@activo.kr', 0], ['me@automind.kr', 1]]);
    // 메일 없이 만든 할 일은 주인 메일함
    const t2 = await call('create_task', { title: '그냥 할 일' });
    assert.equal((await getPool().query('select account from tasks where id = $1', [t2.task.id])).rows[0].account, 'main');
    await client.close();

    // 다른 사람(b): 메일함 인자 없음·오토마인드 안 보임
    const b = await connect(process.env.ACCOUNT_B_TOKEN);
    assert.ok(!b.tools.find((t) => t.name === 'search_emails').inputSchema.properties.mailbox);
    assert.deepEqual((await b.call('search_emails', { query: '견적' })).emails.map((e) => e.subject), ['다른 사람 견적']);
    assert.equal((await b.call('read_email', { id: ids.automind })).success, false);
    await b.client.close();
  } finally {
    delete process.env.MAILBOX_LINKS;
  }
});
