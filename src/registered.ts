import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { registeredAccounts } from './db/schema.js';
import { listAccounts, setRegisteredAccounts, type Account } from './account.js';
import { Pop3Session } from './services/pop3.js';
import { log } from './config.js';

/**
 * 스스로 등록한 메일 계정 (2026-11-15 사용자 요청: "activo.kr 메일이면 누구나 본인 계정으로 로그인해 본인 메일만").
 * - SELF_SIGNUP_DOMAINS(쉼표, 예: activo.kr) 메일이 연결 화면에서 하이웍스 메일 비밀번호로 로그인하면,
 *   서버가 POP3 로 실제 로그인해 확인하고 registered_accounts 에 등록(또는 비밀번호 갱신)한다.
 * - mail-worker 가 백그라운드로 메일을 받아야 해서 비밀번호를 보관하되 ACCOUNT_SECRET(32자 이상)으로 AES-256-GCM 암호화.
 *   관리자가 Railway 변수에 직원 비밀번호를 적을 필요가 없다. (DB·ACCOUNT_SECRET 을 둘 다 가진 사람은 풀 수 있다)
 * - 관리자가 넣은 계정(ACCOUNT_<KEY>_*, main)은 그대로 연결 비밀번호로 로그인한다.
 */

export function selfSignupDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env['SELF_SIGNUP_DOMAINS'] || '').split(/[,\s]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
}

function secret(env: NodeJS.ProcessEnv = process.env): string {
  const s = String(env['ACCOUNT_SECRET'] || '').trim();
  return s.length >= 32 ? s : '';
}

/** 스스로 등록이 켜져 있나 (도메인 + 암호화 키 둘 다 있어야) */
export function selfSignupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return selfSignupDomains(env).length > 0 && Boolean(secret(env));
}

export function emailAllowed(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const m = /^[^\s@]+@([^\s@]+)$/.exec(email.trim().toLowerCase());
  return Boolean(m && selfSignupDomains(env).includes(m[1]!));
}

const key32 = () => crypto.createHash('sha256').update('hiworks-account:' + secret()).digest();

export function encryptPassword(pw: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key32(), iv);
  const ct = Buffer.concat([c.update(pw, 'utf8'), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

export function decryptPassword(enc: string): string | null {
  try {
    if (!enc.startsWith('v1.')) return null;
    const buf = Buffer.from(enc.slice(3), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', key32(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** DB 에서 다시 읽어 계정 목록에 반영한다. 서버·worker 가 주기적으로 부른다 */
export async function refreshRegisteredAccounts(db: Db): Promise<number> {
  if (!secret()) {
    setRegisteredAccounts([]);
    return 0;
  }
  const rows = await db.select().from(registeredAccounts).where(eq(registeredAccounts.disabled, false));
  const list: Account[] = [];
  for (const r of rows) {
    const pw = decryptPassword(r.passwordEnc);
    if (pw === null) {
      log(`등록 계정 ${r.key}: 비밀번호를 풀 수 없어 건너뜁니다 (ACCOUNT_SECRET 이 바뀌었나?)`);
      continue;
    }
    list.push({ key: r.key, username: r.email, password: pw, token: '', loginPassword: pw, selfService: true });
  }
  setRegisteredAccounts(list);
  return list.length;
}

/** 하이웍스 POP3 로 실제 로그인되는지 */
export async function verifyMailLogin(email: string, password: string): Promise<{ ok: true } | { ok: false; auth: boolean; message: string }> {
  const s = new Pop3Session({ username: email, password });
  try {
    await s.count();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 인증 실패(-ERR … auth/password/login)와 연결 문제를 나눈다 — 연결 문제는 실패 횟수에 넣지 않는다
    const auth = /-ERR|auth|password|login|invalid|denied|incorrect/i.test(message) && !/timeout|ECONN|ENOTFOUND|socket/i.test(message);
    return { ok: false, auth, message };
  } finally {
    await s.close().catch(() => {});
  }
}

/** 메일 주소 → DB 키 (소문자·숫자·_). 이미 쓰인 키(환경변수 계정·다른 주소)면 _2, _3 … */
async function newKey(db: Db, email: string): Promise<string> {
  const base = (email.split('@')[0] || 'user').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'user';
  const taken = new Set([...listAccounts(process.env, { requireToken: false }).map((a) => a.key), 'main']);
  const rows = await db.select({ key: registeredAccounts.key }).from(registeredAccounts);
  for (const r of rows) taken.add(r.key);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${crypto.randomBytes(3).toString('hex')}`;
}

/** 등록(처음) 또는 비밀번호 갱신(다시 로그인). 확인은 호출 쪽이 verifyMailLogin 으로 먼저 한다 */
export async function upsertRegisteredAccount(db: Db, email: string, password: string): Promise<{ key: string; created: boolean }> {
  const e = email.trim().toLowerCase();
  const [existing] = await db.select().from(registeredAccounts).where(eq(registeredAccounts.email, e)).limit(1);
  if (existing) {
    await db.update(registeredAccounts).set({ passwordEnc: encryptPassword(password), disabled: false, updatedAt: new Date() }).where(eq(registeredAccounts.key, existing.key));
    await refreshRegisteredAccounts(db);
    return { key: existing.key, created: false };
  }
  const key = await newKey(db, e);
  await db.insert(registeredAccounts).values({ key, email: e, passwordEnc: encryptPassword(password) });
  await refreshRegisteredAccounts(db);
  log(`등록 계정 추가: ${key}`);
  return { key, created: true };
}
