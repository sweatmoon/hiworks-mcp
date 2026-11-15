// 스스로 등록(activo.kr 같은 허용 도메인 메일 → 하이웍스 메일 비밀번호로 연결) 통합 테스트 (실제 PostgreSQL 필요).
// 실행: DATABASE_URL=postgres://... node --test test/selfsignup.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import net from 'net';

// 사용자별 비밀번호를 바꿀 수 있는 작은 POP3 목 서버
const MAILBOX_PW = { 'new@hiworks.com': 'mail-pw-1', 'owner@hiworks.com': 'secret', 'staff@hiworks.com': 'staff-mail-pw' };
const pop = net.createServer((sock) => {
  let user = '';
  sock.write('+OK ready\r\n');
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      const [cmd, ...args] = line.split(' ');
      const c = cmd.toUpperCase();
      if (c === 'USER') { user = args[0]; sock.write('+OK\r\n'); }
      else if (c === 'PASS') sock.write(MAILBOX_PW[user] && MAILBOX_PW[user] === args.join(' ') ? '+OK Logged in.\r\n' : '-ERR [AUTH] Authentication failed.\r\n');
      else if (c === 'STAT') sock.write('+OK 0 0\r\n');
      else if (c === 'UIDL' || c === 'LIST') sock.write('+OK\r\n.\r\n');
      else if (c === 'QUIT') { sock.write('+OK Bye\r\n'); sock.end(); }
      else sock.write('-ERR unknown\r\n');
    }
  });
  sock.on('error', () => {});
});
await new Promise((r) => pop.listen(0, '127.0.0.1', r));

process.env.HIWORKS_USERNAME = 'owner@hiworks.com';
process.env.HIWORKS_PASSWORD = 'secret';
process.env.OAUTH_LOGIN_PASSWORD = 'owner-login-pass-1234';
process.env.ACCOUNT_STAFF_USERNAME = 'staff@hiworks.com';
process.env.ACCOUNT_STAFF_PASSWORD = 'staff-mail-pw';
process.env.ACCOUNT_STAFF_OAUTH_PASSWORD = 'staff-connect-pass-99';
process.env.HIWORKS_POP3_HOST = '127.0.0.1';
process.env.HIWORKS_POP3_PORT = String(pop.address().port);
process.env.HIWORKS_POP3_TLS = 'false';
process.env.SELF_SIGNUP_DOMAINS = 'hiworks.com';
process.env.ACCOUNT_SECRET = 'a'.repeat(40);
delete process.env.MCP_AUTH_TOKEN;
delete process.env.PUBLIC_BASE_URL;
delete process.env.RAILWAY_PUBLIC_DOMAIN;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없어 selfsignup 테스트를 건너뜁니다.');
  pop.close();
  process.exit(0);
}

const { closeDb, getDb, getPool } = await import('../build/db/client.js');
const { runMigrations } = await import('../build/db/migrate.js');
const { createHttpServer } = await import('../build/remote/server.js');
const { resetLoginLimits, accountByAccessToken } = await import('../build/remote/oauth.js');
const { refreshRegisteredAccounts, decryptPassword } = await import('../build/registered.js');
const { listAccounts, accountByEmail } = await import('../build/account.js');

let server;
let base;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

before(async () => {
  await runMigrations();
  await getPool().query('DELETE FROM registered_accounts');
  await refreshRegisteredAccounts(getDb());
  server = createHttpServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((res) => server.close(res));
  await new Promise((res) => pop.close(res));
  await closeDb();
});

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
async function client() {
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }) });
  return (await r.json()).client_id;
}
async function login(email, password) {
  const id = await client();
  const { verifier, challenge } = pkce();
  const form = new URLSearchParams({ client_id: id, redirect_uri: REDIRECT, state: 's', code_challenge: challenge, code_challenge_method: 'S256', response_type: 'code', email, password });
  const r = await fetch(`${base}/oauth/authorize`, { method: 'POST', body: form, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  if (r.status !== 302) return { status: r.status, html: await r.text() };
  const code = new URL(r.headers.get('location')).searchParams.get('code');
  const t = await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: id, redirect_uri: REDIRECT, code_verifier: verifier }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return { status: 302, tokens: await t.json() };
}
const rows = async () => (await getPool().query('SELECT key, email, password_enc, disabled FROM registered_accounts ORDER BY key')).rows;

test('로그인 화면: 허용 도메인 안내와 "비밀번호" 칸', async () => {
  const id = await client();
  const { challenge } = pkce();
  const r = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ client_id: id, redirect_uri: REDIRECT, state: 's', code_challenge: challenge, code_challenge_method: 'S256', response_type: 'code' })}`);
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /@hiworks\.com<\/b> 메일은 <b>하이웍스 메일 비밀번호<\/b>로 로그인/);
  assert.match(html, /<label for="password">비밀번호<\/label>/);
});

test('스스로 등록: 틀린 메일 비밀번호는 거부·등록 안 됨, 맞으면 등록·토큰·본인 계정, 비밀번호는 암호화 저장', async () => {
  resetLoginLimits();
  const bad = await login('new@hiworks.com', 'wrong');
  assert.equal(bad.status, 401); assert.match(bad.html, /하이웍스 계정이 잠길 수 있으니/);
  assert.deepEqual(await rows(), []);
  const ok = await login('New@hiworks.com', 'mail-pw-1');
  assert.equal(ok.status, 302); assert.ok(ok.tokens.access_token);
  const r = await rows();
  assert.equal(r.length, 1); assert.equal(r[0].key, 'new'); assert.equal(r[0].email, 'new@hiworks.com');
  assert.ok(!r[0].password_enc.includes('mail-pw-1')); assert.equal(decryptPassword(r[0].password_enc), 'mail-pw-1');
  const acc = await accountByAccessToken(ok.tokens.access_token);
  assert.equal(acc.key, 'new'); assert.equal(acc.selfService, true);
  // worker 는 같은 목록으로 동기화한다 (주소·비밀번호 포함)
  const forWorker = listAccounts(process.env, { requireToken: false }).find((a) => a.key === 'new');
  assert.deepEqual([forWorker.username, forWorker.password], ['new@hiworks.com', 'mail-pw-1']);
});

test('하이웍스 비밀번호를 바꾸면: 새 비밀번호로 다시 로그인 → 저장 갱신, 이전 토큰 무효', async () => {
  resetLoginLimits();
  const first = await login('new@hiworks.com', 'mail-pw-1');
  MAILBOX_PW['new@hiworks.com'] = 'mail-pw-2';
  try {
    assert.equal((await login('new@hiworks.com', 'mail-pw-1')).status, 401, '옛 비밀번호는 하이웍스가 거부');
    const again = await login('new@hiworks.com', 'mail-pw-2');
    assert.equal(again.status, 302);
    assert.equal((await rows()).length, 1, '새 계정을 만들지 않고 갱신');
    assert.equal(decryptPassword((await rows())[0].password_enc), 'mail-pw-2');
    assert.equal(await accountByAccessToken(first.tokens.access_token), null, '이전 토큰 무효');
    assert.equal((await accountByAccessToken(again.tokens.access_token)).key, 'new');
  } finally {
    MAILBOX_PW['new@hiworks.com'] = 'mail-pw-1';
  }
});

test('허용 도메인이 아니면 등록 불가, 관리자가 등록한 계정은 연결 비밀번호 그대로', async () => {
  resetLoginLimits();
  MAILBOX_PW['x@other.com'] = 'pw';
  assert.equal((await login('x@other.com', 'pw')).status, 401);
  assert.ok(!(await rows()).some((r) => r.email === 'x@other.com'));
  resetLoginLimits();
  // staff 는 Railway 변수 계정: 메일 비밀번호로는 안 되고 연결 비밀번호로만
  assert.equal((await login('staff@hiworks.com', 'staff-mail-pw')).status, 401);
  const s = await login('staff@hiworks.com', 'staff-connect-pass-99');
  assert.equal(s.status, 302);
  assert.equal((await accountByAccessToken(s.tokens.access_token)).key, 'staff');
  assert.ok(!(await rows()).some((r) => r.email === 'staff@hiworks.com'), '변수 계정은 등록 표에 넣지 않음');
  resetLoginLimits();
  assert.equal((await login('owner@hiworks.com', 'owner-login-pass-1234')).status, 302);
});

test('ACCOUNT_SECRET 이 없으면 스스로 등록 꺼짐, 등록 계정도 목록에서 빠짐', async () => {
  resetLoginLimits();
  const saved = process.env.ACCOUNT_SECRET;
  delete process.env.ACCOUNT_SECRET;
  try {
    MAILBOX_PW['other@hiworks.com'] = 'pw-other';
    assert.equal((await login('other@hiworks.com', 'pw-other')).status, 401);
    await refreshRegisteredAccounts(getDb());
    assert.equal(accountByEmail('new@hiworks.com'), null);
  } finally {
    process.env.ACCOUNT_SECRET = saved;
    await refreshRegisteredAccounts(getDb());
  }
  assert.equal(accountByEmail('new@hiworks.com').key, 'new');
});

test('비활성화(disabled)하면 목록에서 빠지고 토큰도 무효', async () => {
  resetLoginLimits();
  const t = await login('new@hiworks.com', 'mail-pw-1');
  await getPool().query("UPDATE registered_accounts SET disabled = true WHERE key = 'new'");
  await refreshRegisteredAccounts(getDb());
  assert.equal(await accountByAccessToken(t.tokens.access_token), null);
  assert.ok(!listAccounts(process.env, { requireToken: false }).some((a) => a.key === 'new'));
  await getPool().query("UPDATE registered_accounts SET disabled = false WHERE key = 'new'");
  await refreshRegisteredAccounts(getDb());
});
