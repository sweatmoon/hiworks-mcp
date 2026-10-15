import fs from 'fs';
import type { ServerResponse } from 'http';
import { fileURLToPath } from 'url';

/**
 * 팀 업무 현황판 웹앱 (/dashboard).
 *
 * 서버는 정적 파일과 설정만 내려준다. 시트 데이터는 브라우저가 사용자의 Google 로그인(OAuth 토큰, 읽기 전용)으로
 * Sheets API 에서 직접 읽으므로, 서버에는 Google 자격증명도 업무 데이터도 남지 않는다.
 * 시트를 볼 권한은 Google 시트 공유 설정이 그대로 결정한다.
 */

const asset = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

const FILES: Record<string, { file: string; type: string; cache: string }> = {
  '': { file: asset('../../web/dashboard/index.html'), type: 'text/html; charset=utf-8', cache: 'no-cache' },
  'app.css': { file: asset('../../web/dashboard/app.css'), type: 'text/css; charset=utf-8', cache: 'no-cache' },
  'app.js': { file: asset('../../web/dashboard/app.js'), type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
  'runtime.js': { file: asset('../../web/dashboard/runtime.js'), type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
  'manifest.webmanifest': { file: asset('../../web/dashboard/manifest.webmanifest'), type: 'application/manifest+json; charset=utf-8', cache: 'no-cache' },
  'icon.svg': { file: asset('../../web/dashboard/icon.svg'), type: 'image/svg+xml', cache: 'public, max-age=86400' },
  'd3.min.js': { file: asset('../../node_modules/d3/dist/d3.min.js'), type: 'text/javascript; charset=utf-8', cache: 'public, max-age=604800' },
};

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com/gsi/",
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    "connect-src 'self' https://sheets.googleapis.com https://oauth2.googleapis.com https://accounts.google.com/gsi/",
    'frame-src https://accounts.google.com/gsi/',
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  // Google 로그인 팝업이 창을 닫고 토큰을 돌려줄 수 있어야 한다
  'cross-origin-opener-policy': 'same-origin-allow-popups',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export interface DashboardSource {
  spreadsheetId: string;
  range: string;
}

/**
 * DASHBOARD_SOURCES: 현황판 데이터셋 id → 시트 위치. 시트 ID 는 소스코드에 두지 않고 환경변수로만 받는다.
 * 예: {"hyeonho":{"spreadsheetId":"1D01…","range":"업무일지!A1:G2000"}, "tasks":{…}, "holidays":{…}}
 */
export function dashboardSources(): { sources: Record<string, DashboardSource>; error?: string } {
  const raw = process.env['DASHBOARD_SOURCES'];
  if (!raw) return { sources: {}, error: 'DASHBOARD_SOURCES 환경변수가 없습니다.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { sources: {}, error: 'DASHBOARD_SOURCES 가 올바른 JSON 이 아닙니다.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { sources: {}, error: 'DASHBOARD_SOURCES 는 JSON 객체여야 합니다.' };
  const sources: Record<string, DashboardSource> = {};
  for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
    const s = v as Partial<DashboardSource> | null;
    if (!/^[a-z0-9_]{1,40}$/i.test(id) || !s || typeof s.spreadsheetId !== 'string' || typeof s.range !== 'string') continue;
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(s.spreadsheetId) || s.range.length > 200) continue;
    sources[id] = { spreadsheetId: s.spreadsheetId, range: s.range };
  }
  return { sources };
}

function configScript(): string {
  const { sources, error } = dashboardSources();
  const clientId = process.env['DASHBOARD_GOOGLE_CLIENT_ID'] || '';
  const errors = [...(clientId ? [] : ['DASHBOARD_GOOGLE_CLIENT_ID 환경변수가 없습니다.']), ...(error ? [error] : [])];
  const body = JSON.stringify({ clientId, sources, errors }).replace(/</g, '\\u003c');
  return `window.DASHBOARD_CONFIG = ${body};\n`;
}

/** /dashboard 하위 요청을 처리한다. 처리했으면 true. */
export async function handleDashboard(pathname: string, method: string, res: ServerResponse): Promise<boolean> {
  if (pathname !== '/dashboard' && !pathname.startsWith('/dashboard/')) return false;
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return true;
  }
  if (pathname === '/dashboard') {
    res.writeHead(308, { location: '/dashboard/' });
    res.end();
    return true;
  }
  const name = pathname.slice('/dashboard/'.length);
  if (name === 'config.js') {
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(method === 'HEAD' ? undefined : configScript());
    return true;
  }
  const entry = FILES[name];
  if (!entry) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return true;
  }
  const data = await fs.promises.readFile(entry.file);
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': entry.type, 'cache-control': entry.cache, 'content-length': String(data.length) });
  res.end(method === 'HEAD' ? undefined : data);
  return true;
}
