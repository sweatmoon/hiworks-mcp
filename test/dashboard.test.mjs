// /dashboard 정적 웹앱 라우트 검증 (DB 불필요). 실행: npm run build && node --test test/dashboard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createHttpServer } = await import('../build/remote/server.js');

async function withServer(fn) {
  const server = createHttpServer();
  await new Promise((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test('dashboard: static files, security headers, config from env', async () => {
  process.env.DASHBOARD_GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
  process.env.DASHBOARD_SOURCES = JSON.stringify({
    hyeonho: { spreadsheetId: 'A'.repeat(44), range: '업무일지!A1:G2000' },
    bad: { spreadsheetId: 'x', range: 'y' },
    tasks: { spreadsheetId: 'B'.repeat(44), range: '작업배정!A1:F1000' },
  });
  await withServer(async (base) => {
    const redirect = await fetch(`${base}/dashboard`, { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/dashboard/');

    const page = await fetch(`${base}/dashboard/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
    assert.match(await page.text(), /제안팀 업무 현황판/);

    for (const f of ['app.js', 'app.css', 'runtime.js', 'd3.min.js', 'manifest.webmanifest', 'icon.svg']) {
      assert.equal((await fetch(`${base}/dashboard/${f}`)).status, 200, f);
    }
    assert.equal((await fetch(`${base}/dashboard/server.js`)).status, 404);
    assert.equal((await fetch(`${base}/dashboard/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/dashboard/`, { method: 'POST' })).status, 405);

    const cfgRes = await fetch(`${base}/dashboard/config.js`);
    assert.equal(cfgRes.headers.get('cache-control'), 'no-store');
    const cfgText = await cfgRes.text();
    const cfg = JSON.parse(cfgText.replace(/^window\.DASHBOARD_CONFIG = /, '').replace(/;\s*$/, ''));
    assert.equal(cfg.clientId, 'client-123.apps.googleusercontent.com');
    assert.deepEqual(Object.keys(cfg.sources).sort(), ['hyeonho', 'tasks']);
    assert.deepEqual(cfg.errors, []);
  });

  delete process.env.DASHBOARD_GOOGLE_CLIENT_ID;
  process.env.DASHBOARD_SOURCES = '{not json';
  await withServer(async (base) => {
    const cfgText = await (await fetch(`${base}/dashboard/config.js`)).text();
    assert.match(cfgText, /DASHBOARD_GOOGLE_CLIENT_ID 환경변수가 없습니다/);
    assert.match(cfgText, /올바른 JSON 이 아닙니다/);
  });
});
