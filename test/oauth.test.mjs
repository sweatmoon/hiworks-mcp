// claude.ai 커넥터용 OAuth 로그인 통합 테스트 (실제 PostgreSQL 필요).
// 실행: DATABASE_URL=postgres://... node --test test/oauth.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.HIWORKS_USERNAME = 'owner@hiworks.com';
process.env.HIWORKS_PASSWORD = 'secret';
process.env.MCP_AUTH_TOKEN = 'static-token-0123456789abcdef';
process.env.OAUTH_LOGIN_PASSWORD = 'owner-login-pass-1234';
// 팀원 계정: 메일함은 있지만 OAuth 비밀번호가 없다 → 로그인 불가
process.env.ACCOUNT_TEAM_USERNAME = 'team@hiworks.com';
process.env.ACCOUNT_TEAM_PASSWORD = 'secret-team';
process.env.ACCOUNT_TEAM_TOKEN = 'team-token-0123456789abcdef';
delete process.env.PUBLIC_BASE_URL;
delete process.env.RAILWAY_PUBLIC_DOMAIN;
delete process.env.STATIC_TOKEN_AUTH;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없어 oauth 테스트를 건너뜁니다.');
  process.exit(0);
}

const { closeDb } = await import('../build/db/client.js');
const { runMigrations } = await import('../build/db/migrate.js');
const { createHttpServer } = await import('../build/remote/server.js');
const { resetLoginLimits } = await import('../build/remote/oauth.js');

let server;
let base;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

before(async () => {
  await runMigrations();
  server = createHttpServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((res) => server.close(res));
  await closeDb();
});

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
async function register(redirect = REDIRECT) {
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }) });
  return { status: r.status, body: await r.json() };
}
async function login(clientId, challenge, email, password, state = 'st1') {
  const form = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, state, code_challenge: challenge, code_challenge_method: 'S256', response_type: 'code', email, password });
  return fetch(`${base}/oauth/authorize`, { method: 'POST', body: form, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
}
async function token(params) {
  const r = await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams(params), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return { status: r.status, body: await r.json() };
}
async function fullLogin() {
  resetLoginLimits();
  const { body: c } = await register();
  const { verifier, challenge } = pkce();
  const r = await login(c.client_id, challenge, 'owner@hiworks.com', 'owner-login-pass-1234');
  assert.equal(r.status, 302);
  const code = new URL(r.headers.get('location')).searchParams.get('code');
  const t = await token({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  return { client: c, tokens: t.body };
}
async function listTools(accessToken) {
  const client = new Client({ name: 't', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } });
  await client.connect(transport);
  const tools = await client.listTools();
  await client.close();
  return tools.tools.map((t) => t.name);
}

test('메타데이터와 401 안내', async () => {
  const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(pr.resource, `${base}/mcp`);
  assert.deepEqual(pr.authorization_servers, [base]);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.token_endpoint, `${base}/oauth/token`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  const r = await fetch(`${base}/mcp`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);
});

test('허용되지 않은 redirect_uri 는 등록 거부', async () => {
  assert.equal((await register('https://evil.example.com/cb')).status, 400);
  assert.equal((await register('http://localhost:33418/callback')).status, 201);
});

test('로그인 화면은 프레임 삽입을 막는다', async () => {
  const { body: c } = await register();
  const { challenge } = pkce();
  const q = new URLSearchParams({ client_id: c.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: challenge, code_challenge_method: 'S256', response_type: 'code' });
  const r = await fetch(`${base}/oauth/authorize?${q}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(await r.text(), /연결 비밀번호/);
  // 등록과 다른 redirect_uri 는 거부(리디렉션하지 않음)
  q.set('redirect_uri', 'https://claude.ai/other');
  assert.equal((await fetch(`${base}/oauth/authorize?${q}`, { redirect: 'manual' })).status, 400);
});

test('팀원·틀린 비밀번호는 로그인 불가, 반복 실패는 잠금', async () => {
  resetLoginLimits();
  const { body: c } = await register();
  const { challenge } = pkce();
  assert.equal((await login(c.client_id, challenge, 'owner@hiworks.com', 'wrong-password-xxxx')).status, 401);
  // 팀원 계정: 메일함 비밀번호를 알아도 OAuth 비밀번호가 없으므로 실패
  assert.equal((await login(c.client_id, challenge, 'team@hiworks.com', 'secret-team')).status, 401);
  // 고정 토큰을 비밀번호로 넣어도 실패
  assert.equal((await login(c.client_id, challenge, 'owner@hiworks.com', 'static-token-0123456789abcdef')).status, 401);
  for (let i = 0; i < 2; i++) await login(c.client_id, challenge, 'x@y.com', 'nope-nope-nope');
  // 5회 실패 뒤에는 맞는 비밀번호도 잠금
  assert.equal((await login(c.client_id, challenge, 'owner@hiworks.com', 'owner-login-pass-1234')).status, 429);
  resetLoginLimits();
});

test('주인 로그인 → 코드 교환 → MCP 접속', async () => {
  const { tokens } = await fullLogin();
  assert.equal(tokens.token_type, 'Bearer');
  const names = await listTools(tokens.access_token);
  assert.ok(names.includes('search_emails'), names.join(','));
});

test('코드 재사용·PKCE 불일치 거부', async () => {
  resetLoginLimits();
  const { body: c } = await register();
  const { verifier, challenge } = pkce();
  const r = await login(c.client_id, challenge, 'owner@hiworks.com', 'owner-login-pass-1234');
  const code = new URL(r.headers.get('location')).searchParams.get('code');
  assert.equal(new URL(r.headers.get('location')).searchParams.get('state'), 'st1');
  const bad = await token({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: 'wrong' });
  assert.equal(bad.status, 400);
  // 실패한 시도로 코드는 이미 소모됨
  const again = await token({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
  assert.equal(again.status, 400);
});

test('갱신 토큰은 한 번만 쓸 수 있다', async () => {
  const { client, tokens } = await fullLogin();
  const r1 = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(r1.status, 200);
  const r2 = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(r2.status, 400);
  assert.ok((await listTools(r1.body.access_token)).length > 0);
});

test('비밀번호를 바꾸면 이전 토큰은 무효', async () => {
  const { tokens } = await fullLogin();
  process.env.OAUTH_LOGIN_PASSWORD = 'changed-login-pass-5678';
  try {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(r.status, 401);
    assert.equal((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).status, 400);
  } finally {
    process.env.OAUTH_LOGIN_PASSWORD = 'owner-login-pass-1234';
  }
});

test('STATIC_TOKEN_AUTH=off 이면 고정 토큰 거부, OAuth 는 통과', async () => {
  const { tokens } = await fullLogin();
  process.env.STATIC_TOKEN_AUTH = 'off';
  try {
    const r = await fetch(`${base}/mcp/static-token-0123456789abcdef`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(r.status, 401);
    assert.ok((await listTools(tokens.access_token)).length > 0);
  } finally {
    delete process.env.STATIC_TOKEN_AUTH;
  }
});
