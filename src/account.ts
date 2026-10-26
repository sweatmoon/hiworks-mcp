import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import { log } from './config.js';

/**
 * 메일함 계정. 서버 하나가 여러 사람의 메일함을 나눠 담는다 (중앙 관리).
 *  - main: 기존 변수 HIWORKS_USERNAME / HIWORKS_PASSWORD / MCP_AUTH_TOKEN / OAUTH_LOGIN_PASSWORD
 *  - 그 밖: ACCOUNT_<KEY>_USERNAME / ACCOUNT_<KEY>_PASSWORD / ACCOUNT_<KEY>_TOKEN / ACCOUNT_<KEY>_OAUTH_PASSWORD (KEY 는 영문 대문자·숫자·_)
 * OAuth 로그인 비밀번호가 있는 계정만 claude.ai 커넥터 로그인(OAuth)으로 접속할 수 있다.
 * 접속 토큰으로 계정을 가리고, DB 의 모든 행은 account 열로 나뉜다.
 */
export interface Account {
  /** DB 에 저장하는 키 (소문자). main 이 기본 계정 */
  key: string;
  username: string;
  password: string;
  /** 이 계정 전용 MCP 접속 토큰 (16자 이상) */
  token: string;
  /** OAuth 로그인 화면에서 쓰는 비밀번호 (12자 이상, 없으면 OAuth 로그인 불가) */
  loginPassword: string;
}

export const MAIN_ACCOUNT = 'main';
const KEY_RE = /^ACCOUNT_([A-Z0-9_]+)_USERNAME$/;
/** 요청마다 목록을 읽으므로 같은 경고는 한 번만 남긴다 */
const warnedOnce = new Set<string>();

/**
 * 환경변수에서 계정 목록을 읽는다. 토큰이 짧거나 겹치는 계정은 빼고 로그에 이유만 남긴다 (값은 남기지 않음).
 * requireToken=false 는 Worker 용: 접속을 받지 않으므로 토큰 없이 주소·비밀번호만 있으면 동기화 대상으로 본다.
 */
export function listAccounts(env: NodeJS.ProcessEnv = process.env, opts: { requireToken?: boolean } = {}): Account[] {
  const requireToken = opts.requireToken ?? true;
  const warn = (msg: string) => {
    if (!warnedOnce.has(msg)) log(msg);
    warnedOnce.add(msg);
  };
  const out: Account[] = [];
  const main: Account = {
    key: MAIN_ACCOUNT,
    username: (env['HIWORKS_USERNAME'] || '').trim(),
    password: env['HIWORKS_PASSWORD'] || '',
    token: env['MCP_AUTH_TOKEN'] || '',
    loginPassword: env['OAUTH_LOGIN_PASSWORD'] || '',
  };
  if (requireToken ? main.token.length >= 16 || main.loginPassword.length >= 12 : Boolean(main.username && main.password)) out.push(main);
  for (const name of Object.keys(env).sort()) {
    const m = KEY_RE.exec(name);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === MAIN_ACCOUNT) {
      warn(`계정 ${name}: main 은 예약된 이름이라 건너뜁니다`);
      continue;
    }
    const acc: Account = {
      key,
      username: (env[name] || '').trim(),
      password: env[`ACCOUNT_${m[1]}_PASSWORD`] || '',
      token: env[`ACCOUNT_${m[1]}_TOKEN`] || '',
      loginPassword: env[`ACCOUNT_${m[1]}_OAUTH_PASSWORD`] || '',
    };
    if (!acc.username || !acc.password) {
      warn(`계정 ${key}: USERNAME 또는 PASSWORD 가 비어 있어 건너뜁니다`);
      continue;
    }
    if (requireToken && acc.token.length < 16 && acc.loginPassword.length < 12) {
      warn(`계정 ${key}: ACCOUNT_${m[1]}_TOKEN(16자 이상) 또는 ACCOUNT_${m[1]}_OAUTH_PASSWORD(12자 이상)가 없어 건너뜁니다`);
      continue;
    }
    if (requireToken && acc.token && out.some((a) => a.token === acc.token)) {
      warn(`계정 ${key}: 토큰이 다른 계정과 같아 건너뜁니다`);
      continue;
    }
    if (out.some((a) => a.username.toLowerCase() === acc.username.toLowerCase())) {
      warn(`계정 ${key}: 다른 계정과 메일 주소가 같아 건너뜁니다`);
      continue;
    }
    out.push(acc);
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** 접속 토큰에 해당하는 계정. 없으면 null */
export function accountByToken(token: string | undefined): Account | null {
  if (!token) return null;
  const t = token.trim();
  let found: Account | null = null;
  // 모든 계정과 비교한다 (일찍 끝내지 않아 응답 시간으로 계정 수를 알 수 없게)
  for (const acc of listAccounts()) {
    if (acc.token.length >= 16 && safeEqual(t, acc.token) && !found) found = acc;
  }
  return found;
}

/** 계정 키로 찾는다 (OAuth 토큰에 저장된 키) */
export function accountByKey(key: string): Account | null {
  return listAccounts().find((a) => a.key === key) ?? null;
}

/** 메일 주소로 찾는다 (OAuth 로그인 화면) */
export function accountByEmail(email: string): Account | null {
  const e = email.trim().toLowerCase();
  return listAccounts().find((a) => a.username.toLowerCase() === e) ?? null;
}

const store = new AsyncLocalStorage<Account>();

/** fn 을 이 계정의 문맥에서 실행한다. 그 안의 모든 DB 접근은 이 계정의 행만 읽고 쓴다. */
export function withAccount<T>(account: Account, fn: () => T): T {
  return store.run(account, fn);
}

/** 지금 문맥의 계정. 문맥 없이 DB 를 건드리면 다른 사람 메일이 섞일 수 있으므로 오류로 막는다. */
export function currentAccount(): Account {
  const acc = store.getStore();
  if (!acc) throw new Error('계정 문맥 없이 메일 데이터에 접근했습니다 (withAccount 로 감싸야 합니다)');
  return acc;
}

/** 지금 계정의 메일 주소 (소문자). 발신자가 이 주소면 보낸메일로 본다 */
export function selfEmail(): string {
  return currentAccount().username.toLowerCase();
}

/** 지금 문맥의 계정 키 (DB account 열 값) */
export function acct(): string {
  return currentAccount().key;
}
