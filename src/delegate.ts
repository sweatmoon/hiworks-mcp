import { accountByKey, currentAccount, withAccount, type Account } from './account.js';

/**
 * 위임 읽기 (2026-11-16 사용자 요청: 메일함 주인이 동의한 경우 관리자가 기한을 정해 다른 계정 메일을 읽기 전용으로 분석).
 *
 * Railway 변수 DELEGATE_READ = "읽는계정:읽힐계정:YYYY-MM-DD" (쉼표로 여러 개, 날짜는 KST 그날까지 포함).
 *   예: DELEGATE_READ=main:reese79:2026-11-30
 * - 변수에 있는 (읽는 계정 → 읽힐 계정) 쌍만, 만료일까지만. 변수를 지우거나 날짜가 지나면 즉시 막힌다.
 * - 읽기 전용(검색·본문·첨부 읽기). 메일함 주인의 할 일·업무일지·초안 등은 건드리지 않는다.
 * - 사용할 때마다 서버 로그에 [delegate-read] 줄(누가·누구·도구·건수 — 제목·본문은 남기지 않음).
 */

export interface DelegateGrant {
  reader: string;
  target: string;
  /** 이 시각 이전까지 유효 (만료일 다음 날 00:00 KST) */
  until: Date;
  untilText: string;
}

export function parseDelegateGrants(raw: string | undefined = process.env['DELEGATE_READ']): DelegateGrant[] {
  const out: DelegateGrant[] = [];
  for (const part of String(raw ?? '').split(',')) {
    const m = /^\s*([a-z0-9_-]+)\s*:\s*([a-z0-9_-]+)\s*:\s*(\d{4})-(\d{2})-(\d{2})\s*$/i.exec(part);
    if (!m) continue;
    const [, reader, target, y, mo, d] = m;
    if (reader!.toLowerCase() === target!.toLowerCase()) continue;
    // KST 그날 끝 = 다음 날 00:00 KST = 그날 15:00 UTC
    const until = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 15, 0, 0));
    // 13월·40일 같은 값은 Date 가 다음 달로 넘겨 버리므로 직접 확인
    const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    if (Number.isNaN(until.getTime()) || day.getUTCMonth() !== Number(mo) - 1 || day.getUTCDate() !== Number(d)) continue;
    out.push({ reader: reader!.toLowerCase(), target: target!.toLowerCase(), until, untilText: `${y}-${mo}-${d}` });
  }
  return out;
}

/** 지금 계정이 쓸 수 있는(만료 안 된) 위임 */
export function activeGrantsFor(readerKey: string, now = new Date()): DelegateGrant[] {
  return parseDelegateGrants().filter((g) => g.reader === readerKey.toLowerCase() && now < g.until);
}

/** 위임이 있으면 그 계정 문맥에서 fn 을 실행한다. 없거나 만료면 오류 */
export async function asDelegate<T>(target: string, tool: string, fn: (acc: Account) => Promise<T>): Promise<T> {
  const reader = currentAccount();
  const key = String(target ?? '').trim().toLowerCase();
  const grant = activeGrantsFor(reader.key).find((g) => g.target === key);
  if (!grant) throw new Error(`'${key}' 계정 메일을 읽을 위임이 없거나 만료됐습니다. 메일함 주인의 동의를 받아 관리자가 DELEGATE_READ 에 기한을 넣어야 합니다.`);
  const acc = accountByKey(grant.target);
  if (!acc) throw new Error(`'${key}' 계정을 서버에서 찾을 수 없습니다.`);
  const result = await withAccount(acc, () => fn(acc));
  console.error(`[delegate-read] ${reader.key} -> ${acc.key} tool=${tool} until=${grant.untilText}`);
  return result;
}
