/**
 * [미검증] Playwright 기반 하이웍스 웹메일 보낸메일함 수집기 골격.
 *
 * 이 코드는 실제 하이웍스 웹메일 DOM 을 확인하지 못한 상태에서 작성되었다(개발 환경에서 hiworks.com 접속 불가).
 * 로그인 폼·보낸메일함·원본 보기 링크의 셀렉터는 모두 환경변수로 주입하며, 아래 절차로 현장에서 맞춘 뒤 사용한다.
 *   1. `npm run webmail:probe` 로 로그인 후 화면 스크린샷/HTML 을 덤프해 셀렉터를 확인한다.
 *   2. WEBMAIL_* 환경변수를 채우고 SENT_SYNC_MODE=webmail 로 Worker 를 띄운다.
 * CAPTCHA 나 2단계 인증이 나타나면 수집을 중단하고 오류로 기록한다. 우회하지 않는다.
 */
import type { Db } from '../../db/client.js';
import { log } from '../../config.js';
import { currentAccount } from '../../account.js';
import { importMessages } from '../import.js';
import type { RunOutcome } from '../state.js';

export interface WebmailSelectors {
  loginUrl: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  /** 로그인 성공을 판단할 셀렉터 또는 URL 조각 */
  loggedInSelector: string;
  sentFolderUrl: string;
  /** 메일 목록의 각 행(클릭 가능한 제목 링크) */
  mailLinkSelector: string;
  /** 메일 상세 화면에서 원본(EML) 을 여는 링크/버튼 */
  originalLinkSelector: string;
  nextPageSelector: string;
  maxPages: number;
}

export function webmailSelectorsFromEnv(): WebmailSelectors {
  const env = (k: string, d = '') => process.env[k] || d;
  return {
    loginUrl: env('WEBMAIL_LOGIN_URL', 'https://login.hiworks.com/'),
    usernameSelector: env('WEBMAIL_USERNAME_SELECTOR'),
    passwordSelector: env('WEBMAIL_PASSWORD_SELECTOR'),
    submitSelector: env('WEBMAIL_SUBMIT_SELECTOR'),
    loggedInSelector: env('WEBMAIL_LOGGED_IN_SELECTOR'),
    sentFolderUrl: env('WEBMAIL_SENT_FOLDER_URL'),
    mailLinkSelector: env('WEBMAIL_MAIL_LINK_SELECTOR'),
    originalLinkSelector: env('WEBMAIL_ORIGINAL_LINK_SELECTOR'),
    nextPageSelector: env('WEBMAIL_NEXT_PAGE_SELECTOR'),
    maxPages: Number(env('WEBMAIL_MAX_PAGES', '3')) || 3,
  };
}

function assertConfigured(s: WebmailSelectors): void {
  const required: Array<keyof WebmailSelectors> = [
    'usernameSelector',
    'passwordSelector',
    'submitSelector',
    'loggedInSelector',
    'sentFolderUrl',
    'mailLinkSelector',
    'originalLinkSelector',
  ];
  const missing = required.filter((k) => !s[k]);
  if (missing.length) {
    throw new Error(
      `웹메일 수집기가 설정되지 않았습니다. 누락: ${missing.map((k) => `WEBMAIL_${k.replace(/([A-Z])/g, '_$1').toUpperCase()}`).join(', ')}. ` +
        'npm run webmail:probe 로 셀렉터를 확인한 뒤 설정하세요. (이 수집기는 실제 하이웍스 화면으로 검증되지 않았습니다)'
    );
  }
}

async function loadPlaywright(): Promise<typeof import('playwright')> {
  try {
    return await import('playwright');
  } catch {
    throw new Error('playwright 가 설치되어 있지 않습니다. Worker 이미지를 Dockerfile.worker(Playwright 포함)로 빌드하세요.');
  }
}

export async function syncSentFromWebmail(db: Db, selectors: WebmailSelectors = webmailSelectorsFromEnv()): Promise<RunOutcome> {
  assertConfigured(selectors);
  const { username, password } = currentAccount();
  const creds = { username, password };
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let newCount = 0;
  let skippedCount = 0;
  let fetched = 0;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(selectors.loginUrl, { waitUntil: 'domcontentloaded' });
    await page.fill(selectors.usernameSelector, creds.username);
    await page.fill(selectors.passwordSelector, creds.password);
    await page.click(selectors.submitSelector);
    try {
      await page.waitForSelector(selectors.loggedInSelector, { timeout: 30000 });
    } catch {
      const body = (await page.textContent('body')) || '';
      if (/captcha|보안문자|인증번호|2단계|추가 인증/i.test(body)) {
        throw new Error('로그인에 CAPTCHA 또는 추가 인증이 필요합니다. 자동 수집을 중단합니다 (우회하지 않음).');
      }
      throw new Error('로그인 성공을 확인하지 못했습니다. WEBMAIL_LOGGED_IN_SELECTOR 를 확인하세요.');
    }

    for (let pageNo = 1; pageNo <= selectors.maxPages; pageNo++) {
      await page.goto(pageNo === 1 ? selectors.sentFolderUrl : page.url(), { waitUntil: 'domcontentloaded' });
      const links = await page.$$(selectors.mailLinkSelector);
      if (links.length === 0) break;
      for (let i = 0; i < links.length; i++) {
        const rowLinks = await page.$$(selectors.mailLinkSelector);
        const link = rowLinks[i];
        if (!link) break;
        const [detail] = await Promise.all([context.waitForEvent('page', { timeout: 15000 }).catch(() => null), link.click()]);
        const target = detail ?? page;
        await target.waitForLoadState('domcontentloaded');
        const [response] = await Promise.all([
          target.waitForEvent('response', { predicate: (r) => /message\/rfc822|\.eml|octet-stream/i.test(r.headers()['content-type'] || '') || /eml|original|source/i.test(r.url()), timeout: 15000 }).catch(() => null),
          target.click(selectors.originalLinkSelector).catch(() => null),
        ]);
        if (response) {
          const raw = Buffer.from(await response.body());
          fetched++;
          const r = await importMessages(db, raw, { direction: 'sent', source: 'webmail', selfEmail: creds.username });
          newCount += r.newCount;
          skippedCount += r.skippedCount;
        } else {
          log('원본 응답을 찾지 못함 (WEBMAIL_ORIGINAL_LINK_SELECTOR 확인 필요)');
        }
        if (detail) await detail.close();
        else await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => null);
      }
      if (!selectors.nextPageSelector) break;
      const next = await page.$(selectors.nextPageSelector);
      if (!next) break;
      await next.click();
      await page.waitForLoadState('domcontentloaded');
    }
    await context.close();
  } finally {
    await browser.close();
  }
  return { newCount, skippedCount, details: { fetched, verified: false } };
}
