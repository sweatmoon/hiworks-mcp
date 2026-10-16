#!/usr/bin/env node
/**
 * 하이웍스 웹메일 셀렉터 확인용 프로브. 로그인 페이지와(설정돼 있으면) 로그인 후 화면의
 * 스크린샷·HTML·링크 목록을 ./webmail-probe/ 에 저장한다. 실제 수집은 하지 않는다.
 */
import fs from 'fs';
import path from 'path';
import { resolveCredentials } from '../config.js';
import { webmailSelectorsFromEnv } from '../sync/sent/webmail.js';

async function main(): Promise<void> {
  const { chromium } = await import('playwright');
  const s = webmailSelectorsFromEnv();
  const out = path.resolve('webmail-probe');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(s.loginUrl, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: path.join(out, '1-login.png'), fullPage: true });
  fs.writeFileSync(path.join(out, '1-login.html'), await page.content());
  const inputs = await page.$$eval('input, button, a', (els) =>
    els.slice(0, 200).map((e) => `${e.tagName.toLowerCase()} id=${e.id} name=${(e as HTMLInputElement).name || ''} type=${(e as HTMLInputElement).type || ''} text=${(e.textContent || '').trim().slice(0, 40)} href=${(e as HTMLAnchorElement).href || ''}`)
  );
  fs.writeFileSync(path.join(out, '1-login-elements.txt'), inputs.join('\n'));
  console.log(`로그인 페이지 덤프 저장: ${out}`);

  if (s.usernameSelector && s.passwordSelector && s.submitSelector) {
    const creds = resolveCredentials();
    await page.fill(s.usernameSelector, creds.username);
    await page.fill(s.passwordSelector, creds.password);
    await page.click(s.submitSelector);
    await page.waitForTimeout(5000);
    await page.screenshot({ path: path.join(out, '2-after-login.png'), fullPage: true });
    fs.writeFileSync(path.join(out, '2-after-login.html'), await page.content());
    console.log(`로그인 후 URL: ${page.url()}`);
    if (s.sentFolderUrl) {
      await page.goto(s.sentFolderUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: path.join(out, '3-sent-folder.png'), fullPage: true });
      fs.writeFileSync(path.join(out, '3-sent-folder.html'), await page.content());
    }
  } else {
    console.log('WEBMAIL_USERNAME_SELECTOR / PASSWORD / SUBMIT 이 없어 로그인은 시도하지 않았습니다.');
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
