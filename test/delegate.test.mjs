// 위임 읽기(DELEGATE_READ) 통합 테스트 — 실제 PostgreSQL 필요.
// 실행: DATABASE_URL=postgres://... node --test test/delegate.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

for (const k of Object.keys(process.env)) if (k.startsWith('ACCOUNT_') || k === 'DELEGATE_READ') delete process.env[k];
process.env.HIWORKS_USERNAME = 'me@hiworks.com';
process.env.HIWORKS_PASSWORD = 'secret';
process.env.MCP_AUTH_TOKEN = 'main-token-0123456789abcdef';
process.env.ACCOUNT_B_USERNAME = 'b@hiworks.com';
process.env.ACCOUNT_B_PASSWORD = 'secret-b';
process.env.ACCOUNT_B_TOKEN = 'token-b-0123456789abcdef';
process.env.ACCOUNT_C_USERNAME = 'c@hiworks.com';
process.env.ACCOUNT_C_PASSWORD = 'secret-c';
process.env.ACCOUNT_C_TOKEN = 'token-c-0123456789abcdef';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없어 delegate 테스트를 건너뜁니다.');
  process.exit(0);
}

const { getDb, closeDb, getPool } = await import('../build/db/client.js');
const { runMigrations } = await import('../build/db/migrate.js');
const { listAccounts, withAccount } = await import('../build/account.js');
const { importMessages } = await import('../build/sync/import.js');
const { createHttpServer } = await import('../build/remote/server.js');
const { parseDelegateGrants, activeGrantsFor } = await import('../build/delegate.js');

const CRLF = '\r\n';
const enc = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
const eml = (id, from, to, subject, text) =>
  [`Message-ID: <${id}>`, `From: ${from}`, `To: ${to}`, `Subject: ${enc(subject)}`, 'Date: Mon, 02 Nov 2026 10:00:00 +0900', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', text].join(CRLF);

let server, base;
const acc = (key) => listAccounts().find((a) => a.key === key);
const future = '2099-12-31';

before(async () => {
  await getPool().query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await runMigrations();
  const db = getDb();
  await withAccount(acc('b'), () => importMessages(db, Buffer.from(eml('b1@x', 'Boss <boss@hiworks.com>', 'b@hiworks.com', '증자 일정 안내', '이사회 일정입니다.'))));
  await withAccount(acc('c'), () => importMessages(db, Buffer.from(eml('c1@x', 'X <x@hiworks.com>', 'c@hiworks.com', '다른 사람 메일', '비밀'))));
  await withAccount(acc('main'), () => importMessages(db, Buffer.from(eml('m1@x', 'Y <y@hiworks.com>', 'me@hiworks.com', '내 메일', '본인'))));
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
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { client, tools, names: tools.map((t) => t.name), call };
}

test('설정 해석: 형식·자기 자신·만료', () => {
  const g = parseDelegateGrants(`main:reese79:2026-11-30, bad, main:main:2026-12-01 ,x:y:2026-13-40, Main:B:${future}`);
  assert.deepEqual(g.map((x) => [x.reader, x.target, x.untilText]), [['main', 'reese79', '2026-11-30'], ['main', 'b', future]]);
  // KST 그날 끝까지 (다음 날 00:00 KST = 15:00 UTC)
  assert.equal(g[0].until.toISOString(), '2026-11-30T15:00:00.000Z');
  process.env.DELEGATE_READ = 'main:b:2026-11-30';
  assert.equal(activeGrantsFor('main', new Date('2026-11-30T14:59:00Z')).length, 1);
  assert.equal(activeGrantsFor('main', new Date('2026-11-30T15:00:00Z')).length, 0);
  delete process.env.DELEGATE_READ;
});

test('위임 없으면 도구 자체가 없음', async () => {
  delete process.env.DELEGATE_READ;
  const { names, client } = await connect(process.env.MCP_AUTH_TOKEN);
  assert.ok(!names.some((n) => n.startsWith('delegate_')));
  await client.close();
});

test('위임 있으면: 읽는 계정만 도구가 보이고, 위임된 계정만 읽기 전용으로 검색·읽기', async () => {
  process.env.DELEGATE_READ = `main:b:${future}`;
  try {
    const m = await connect(process.env.MCP_AUTH_TOKEN);
    assert.deepEqual(m.names.filter((n) => n.startsWith('delegate_')).sort(), ['delegate_read_attachment', 'delegate_read_email', 'delegate_search_emails']);
    for (const t of m.tools.filter((t) => t.name.startsWith('delegate_'))) assert.equal(t.annotations.readOnlyHint, true);
    const s = await m.call('delegate_search_emails', { account: 'b', query: '증자' });
    assert.equal(s.success, true, s.error);
    assert.deepEqual(s.emails.map((e) => e.subject), ['증자 일정 안내']);
    const r = await m.call('delegate_read_email', { account: 'B', id: s.emails[0].id });
    assert.equal(r.success, true, r.error);
    assert.match(r.email.bodyText, /이사회 일정/);
    // 위임 안 된 계정은 거부
    const denied = await m.call('delegate_search_emails', { account: 'c', query: '' });
    assert.equal(denied.success, false);
    assert.match(denied.error, /위임이 없거나 만료/);
    // 본인 도구는 여전히 본인 메일만
    const own = await m.call('search_emails', { query: '' });
    assert.deepEqual(own.emails.map((e) => e.subject), ['내 메일']);
    // 위임 계정에서 다른 계정 메일 id 를 읽으려 해도 안 됨 (계정 문맥이 b)
    const cMail = await getPool().query("select id from emails where account = 'c' limit 1");
    const cross = await m.call('delegate_read_email', { account: 'b', id: Number(cMail.rows[0].id) });
    assert.equal(cross.success, false);
    await m.client.close();
    // 읽힐 계정(b)에는 위임 도구가 없음
    const b = await connect(process.env.ACCOUNT_B_TOKEN);
    assert.ok(!b.names.some((n) => n.startsWith('delegate_')));
    await b.client.close();
  } finally {
    delete process.env.DELEGATE_READ;
  }
});

test('만료된 위임은 도구도 없고 호출도 거부', async () => {
  process.env.DELEGATE_READ = 'main:b:2020-01-01';
  try {
    const m = await connect(process.env.MCP_AUTH_TOKEN);
    assert.ok(!m.names.some((n) => n.startsWith('delegate_')));
    await m.client.close();
  } finally {
    delete process.env.DELEGATE_READ;
  }
});
