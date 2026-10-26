import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { oauthClients, oauthCodes, oauthTokens } from '../db/schema.js';
import { accountByEmail, accountByKey, type Account } from '../account.js';
import { log } from '../config.js';
import { publicBaseUrl } from '../attachments/download.js';

/**
 * claude.ai 커넥터용 OAuth 2.1 (MCP 인가 규격): 보호 자원·인가 서버 메타데이터, 동적 클라이언트 등록(DCR),
 * PKCE(S256) 인가 코드, 갱신 토큰.
 *
 * 왜 필요한가: Team 조직 소유자가 사용자 지정 커넥터를 추가하면 조직 전체에 보인다. 헤더·URL 토큰 방식은 그 토큰이
 * 조직에 공유되므로, 팀원이 켜기만 해도 이 메일함을 읽을 수 있다. OAuth 로는 사람마다 로그인해야 하고,
 * 로그인은 계정 주인만 아는 OAUTH_LOGIN_PASSWORD 로 막는다.
 *
 * 토큰·코드는 SHA-256 해시로만 저장한다. 비밀번호를 바꾸면(지문 불일치) 이전 토큰은 모두 무효가 된다.
 */

const ACCESS_TTL_S = Number(process.env['OAUTH_ACCESS_TTL_HOURS'] || 24) * 3600;
const REFRESH_TTL_S = Number(process.env['OAUTH_REFRESH_TTL_DAYS'] || 90) * 86400;
const CODE_TTL_S = 300;
const MIN_PASSWORD = 12;

/** 로그인 실패 제한: 같은 IP 15분 5회, 전체 1시간 30회 */
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX = 5;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_MAX = 30;
const failures = new Map<string, number[]>();
let globalFailures: number[] = [];

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (): string => crypto.randomBytes(32).toString('base64url');
/** 비밀번호 지문 (토큰 무효화 판단용, 비밀번호 자체는 저장하지 않음) */
export const passwordFingerprint = (pw: string): string => sha256('hiworks-oauth:' + pw).slice(0, 16);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(sha256(a));
  const bb = Buffer.from(sha256(b));
  return crypto.timingSafeEqual(ab, bb);
}

function baseUrl(req: IncomingMessage): string {
  const fixed = publicBaseUrl();
  if (fixed) return fixed;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] || 'http';
  return `${proto}://${req.headers['host'] || 'localhost'}`;
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new Error('요청 본문이 너무 큽니다');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    const o = raw ? JSON.parse(raw) : {};
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? JSON.stringify(v) : String(v ?? '')]));
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

// ── 메타데이터 ──

export function protectedResourceMetadata(req: IncomingMessage, res: ServerResponse): void {
  const base = baseUrl(req);
  json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], resource_name: 'hiworks-mcp' });
}

export function authorizationServerMetadata(req: IncomingMessage, res: ServerResponse): void {
  const base = baseUrl(req);
  json(res, 200, {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mail'],
  });
}

/** 401 응답에 붙여 클라이언트가 OAuth 를 찾게 한다 */
export function wwwAuthenticate(req: IncomingMessage): string {
  return `Bearer realm="hiworks-mcp", resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`;
}

// ── 리디렉션 주소 허용 목록 ──

function redirectAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  const extra = (process.env['OAUTH_ALLOWED_REDIRECT_HOSTS'] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'https:' && ['claude.ai', 'claude.com', ...extra].includes(host)) return true;
  // Claude Code·Desktop 의 로컬 콜백
  if (u.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) return true;
  return false;
}

// ── 동적 클라이언트 등록 ──

export async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return json(res, 405, { error: 'invalid_request' });
  let body: Record<string, unknown>;
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return json(res, 400, { error: 'invalid_client_metadata', error_description: 'JSON 이 아닙니다' });
  }
  const uris = Array.isArray(body['redirect_uris']) ? (body['redirect_uris'] as unknown[]).map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(redirectAllowed)) {
    return json(res, 400, { error: 'invalid_redirect_uri', error_description: '허용되지 않은 redirect_uri 입니다' });
  }
  const clientId = 'hwc_' + crypto.randomBytes(16).toString('hex');
  const name = String(body['client_name'] || '').slice(0, 100);
  await getDb().insert(oauthClients).values({ clientId, clientName: name, redirectUris: uris });
  json(res, 201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
}

// ── 인가 (로그인 화면) ──

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  response_type: string;
  scope: string;
  resource: string;
}

const PARAM_KEYS: (keyof AuthorizeParams)[] = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type', 'scope', 'resource'];

async function validateAuthorize(p: AuthorizeParams): Promise<{ ok: true; clientName: string } | { ok: false; error: string; redirect: boolean }> {
  if (!p.client_id || !p.redirect_uri) return { ok: false, error: 'client_id 와 redirect_uri 가 필요합니다', redirect: false };
  const [client] = await getDb().select().from(oauthClients).where(eq(oauthClients.clientId, p.client_id)).limit(1);
  if (!client) return { ok: false, error: '등록되지 않은 클라이언트입니다', redirect: false };
  if (!client.redirectUris.includes(p.redirect_uri)) return { ok: false, error: 'redirect_uri 가 등록된 값과 다릅니다', redirect: false };
  if (p.response_type !== 'code') return { ok: false, error: 'unsupported_response_type', redirect: true };
  if (!p.code_challenge || p.code_challenge_method !== 'S256') return { ok: false, error: 'invalid_request', redirect: true };
  return { ok: true, clientName: client.clientName };
}

function redirectWith(res: ServerResponse, uri: string, params: Record<string, string>): void {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' });
  res.end();
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function loginPage(res: ServerResponse, p: AuthorizeParams, clientName: string, message = '', status = 200): void {
  const hidden = PARAM_KEYS.map((k) => `<input type="hidden" name="${k}" value="${esc(p[k] || '')}">`).join('');
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>hiworks 메일 연결</title><style>
body{font-family:system-ui,-apple-system,"Malgun Gothic",sans-serif;background:#f5f5f4;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;color:#1c1917}
main{background:#fff;border:1px solid #e7e5e4;border-radius:12px;padding:28px 24px;width:min(360px,calc(100vw - 32px));box-sizing:border-box}
h1{font-size:18px;margin:0 0 6px}p{font-size:13px;color:#57534e;margin:0 0 18px;line-height:1.5}
label{display:block;font-size:13px;margin:12px 0 4px}input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d6d3d1;border-radius:8px;font-size:15px}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:8px;background:#1c1917;color:#fff;font-size:15px;cursor:pointer}
.err{color:#b91c1c;font-size:13px;margin:0 0 8px}</style></head><body><main>
<h1>hiworks 메일 연결</h1>
<p>${esc(clientName || 'Claude')} 에서 이 메일함에 접속하려고 합니다. 메일함 주인만 로그인할 수 있습니다.</p>
${message ? `<p class="err">${esc(message)}</p>` : ''}
<form method="post" action="/oauth/authorize" autocomplete="off">${hidden}
<label for="email">메일 주소</label><input id="email" name="email" type="email" required autofocus>
<label for="password">연결 비밀번호</label><input id="password" name="password" type="password" required>
<button type="submit">로그인하고 연결</button></form></main></body></html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
  });
  res.end(html);
}

function clientIp(req: IncomingMessage): string {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function prune(list: number[], windowMs: number): number[] {
  const now = Date.now();
  return list.filter((t) => now - t < windowMs);
}

function lockedOut(ip: string): boolean {
  globalFailures = prune(globalFailures, GLOBAL_WINDOW_MS);
  const mine = prune(failures.get(ip) || [], IP_WINDOW_MS);
  failures.set(ip, mine);
  return mine.length >= IP_MAX || globalFailures.length >= GLOBAL_MAX;
}

function recordFailure(ip: string): void {
  failures.set(ip, [...(failures.get(ip) || []), Date.now()]);
  globalFailures.push(Date.now());
  if (failures.size > 1000) failures.delete(failures.keys().next().value!);
}

/** 테스트용: 실패 기록 초기화 */
export function resetLoginLimits(): void {
  failures.clear();
  globalFailures = [];
}

export async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const isPost = req.method === 'POST';
  if (!isPost && req.method !== 'GET') return json(res, 405, { error: 'invalid_request' });
  const form = isPost ? await readForm(req) : Object.fromEntries(url.searchParams);
  const p = Object.fromEntries(PARAM_KEYS.map((k) => [k, String(form[k] || '')])) as unknown as AuthorizeParams;
  const v = await validateAuthorize(p);
  if (!v.ok) {
    if (v.redirect) return redirectWith(res, p.redirect_uri, { error: v.error, state: p.state });
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return void res.end(v.error);
  }
  if (!isPost) return loginPage(res, p, v.clientName);

  const ip = clientIp(req);
  if (lockedOut(ip)) {
    log(`oauth login locked (ip=${ip})`);
    return loginPage(res, p, v.clientName, '로그인 실패가 많아 잠시 막혔습니다. 나중에 다시 시도하세요.', 429);
  }
  const acc: Account | null = accountByEmail(String(form['email'] || ''));
  const password = String(form['password'] || '');
  // 계정이 없을 때도 같은 비교를 해서 응답 시간으로 계정 유무를 알 수 없게 한다
  const expected = acc && acc.loginPassword.length >= MIN_PASSWORD ? acc.loginPassword : crypto.randomBytes(24).toString('hex');
  const good = safeEqual(password, expected) && Boolean(acc) && expected === acc!.loginPassword;
  if (!good || !acc) {
    recordFailure(ip);
    log(`oauth login failed (ip=${ip})`);
    return loginPage(res, p, v.clientName, '메일 주소 또는 연결 비밀번호가 맞지 않습니다.', 401);
  }
  const code = randomToken();
  await getDb().insert(oauthCodes).values({
    codeHash: sha256(code),
    clientId: p.client_id,
    account: acc.key,
    redirectUri: p.redirect_uri,
    codeChallenge: p.code_challenge,
    pwFp: passwordFingerprint(acc.loginPassword),
    expiresAt: new Date(Date.now() + CODE_TTL_S * 1000),
  });
  log(`oauth login ok (account=${acc.key}, client=${p.client_id})`);
  redirectWith(res, p.redirect_uri, { code, state: p.state });
}

// ── 토큰 ──

async function issueTokens(clientId: string, account: Account): Promise<Record<string, unknown>> {
  const access = randomToken();
  const refresh = randomToken();
  const fp = passwordFingerprint(account.loginPassword);
  const now = Date.now();
  await getDb().insert(oauthTokens).values([
    { tokenHash: sha256(access), kind: 'access', clientId, account: account.key, pwFp: fp, expiresAt: new Date(now + ACCESS_TTL_S * 1000) },
    { tokenHash: sha256(refresh), kind: 'refresh', clientId, account: account.key, pwFp: fp, expiresAt: new Date(now + REFRESH_TTL_S * 1000) },
  ]);
  // 만료된 행 정리
  await getDb().delete(oauthTokens).where(lt(oauthTokens.expiresAt, new Date(now - 86400 * 1000)));
  await getDb().delete(oauthCodes).where(lt(oauthCodes.expiresAt, new Date(now)));
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: 'mail' };
}

export async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return json(res, 405, { error: 'invalid_request' });
  const f = await readForm(req);
  const db = getDb();
  if (f['grant_type'] === 'authorization_code') {
    const hash = sha256(f['code'] || '');
    // 코드는 한 번만: 지우면서 읽는다
    const [row] = await db.delete(oauthCodes).where(eq(oauthCodes.codeHash, hash)).returning();
    if (!row || row.expiresAt.getTime() < Date.now()) return json(res, 400, { error: 'invalid_grant' });
    if (row.clientId !== f['client_id'] || row.redirectUri !== f['redirect_uri']) return json(res, 400, { error: 'invalid_grant' });
    const verifier = f['code_verifier'] || '';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!verifier || challenge !== row.codeChallenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE 검증 실패' });
    const acc = accountByKey(row.account);
    if (!acc || passwordFingerprint(acc.loginPassword) !== row.pwFp) return json(res, 400, { error: 'invalid_grant' });
    return json(res, 200, await issueTokens(row.clientId, acc));
  }
  if (f['grant_type'] === 'refresh_token') {
    const hash = sha256(f['refresh_token'] || '');
    // 갱신 토큰은 쓰면 바로 폐기하고 새로 발급한다 (rotation)
    const [row] = await db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(oauthTokens.tokenHash, hash), eq(oauthTokens.kind, 'refresh'), isNull(oauthTokens.revokedAt), gt(oauthTokens.expiresAt, new Date())))
      .returning();
    if (!row || (f['client_id'] && f['client_id'] !== row.clientId)) return json(res, 400, { error: 'invalid_grant' });
    const acc = accountByKey(row.account);
    if (!acc || passwordFingerprint(acc.loginPassword) !== row.pwFp) return json(res, 400, { error: 'invalid_grant' });
    return json(res, 200, await issueTokens(row.clientId, acc));
  }
  return json(res, 400, { error: 'unsupported_grant_type' });
}

export async function handleRevoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return json(res, 405, { error: 'invalid_request' });
  const f = await readForm(req);
  if (f['token']) await getDb().update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.tokenHash, sha256(f['token'])));
  json(res, 200, {});
}

/** Bearer 접속 토큰 → 계정. 만료·폐기·비밀번호 변경이면 null */
export async function accountByAccessToken(token: string): Promise<Account | null> {
  if (!token || token.length < 20) return null;
  const [row] = await getDb()
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.tokenHash, sha256(token)), eq(oauthTokens.kind, 'access'), isNull(oauthTokens.revokedAt), gt(oauthTokens.expiresAt, sql`now()`)))
    .limit(1);
  if (!row) return null;
  const acc = accountByKey(row.account);
  if (!acc || acc.loginPassword.length < MIN_PASSWORD || passwordFingerprint(acc.loginPassword) !== row.pwFp) return null;
  return acc;
}
