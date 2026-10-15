#!/usr/bin/env node
import http, { type IncomingMessage, type ServerResponse } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { sql } from 'drizzle-orm';
import { PACKAGE_VERSION, log, serviceConfig } from '../config.js';
import { closeDb, getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { importFile, type ImportProgress } from '../sync/import.js';
import { listSyncStates } from '../sync/state.js';
import { isAuthorized } from './auth.js';
import { handleDashboard } from './dashboard.js';
import { buildMcpServer } from './tools.js';

/** 하이웍스 편지함 백업은 4GB 단위로 분할된다. */
const MAX_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;
let importRunning = false;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > limit) throw new Error(`요청 본문이 ${limit} bytes 를 초과했습니다.`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 요청마다 서버·전송 계층을 새로 만든다 (stateless). Railway 의 다중 인스턴스/재시작에 안전하다.
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: process.env['MCP_JSON_RESPONSE'] === 'true',
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  let parsedBody: unknown;
  if (req.method === 'POST') {
    const raw = await readBody(req, 8 * 1024 * 1024);
    parsedBody = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
  }
  await transport.handleRequest(req, res, parsedBody);
}

async function handleHealth(res: ServerResponse): Promise<void> {
  try {
    await getDb().execute(sql`select 1`);
    const states = await listSyncStates(getDb());
    json(res, 200, {
      ok: true,
      service: 'mcp-server',
      version: PACKAGE_VERSION,
      db: 'ok',
      sync: states.map((s) => ({ source: s.source, status: s.status, lastSuccessAt: s.lastSuccessAt, error: s.errorMessage })),
    });
  } catch (err) {
    json(res, 503, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleImport(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const direction = url.searchParams.get('direction');
  const filename = url.searchParams.get('filename') || undefined;
  if (direction && direction !== 'sent' && direction !== 'received') return json(res, 400, { error: 'direction 은 sent 또는 received' });
  if (importRunning) return json(res, 409, { error: '다른 가져오기가 진행 중입니다. 끝난 뒤 다시 시도하세요.' });
  importRunning = true;
  const tmp = path.join(os.tmpdir(), `hiworks-upload-${Date.now()}-${randomBytes(4).toString('hex')}`);
  try {
    // 1) 본문을 메모리에 올리지 않고 임시 파일로 흘려 받는다
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > MAX_IMPORT_BYTES) cb(new Error(`요청 본문이 ${MAX_IMPORT_BYTES} bytes 를 초과했습니다.`));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(req, limiter, fs.createWriteStream(tmp));
    } catch (err) {
      return json(res, 413, { error: err instanceof Error ? err.message : String(err) });
    }
    if (size === 0) return json(res, 400, { error: '파일 본문이 비어 있습니다.' });

    // 2) 처리 중에는 NDJSON 으로 진행 상황을 흘려보내 프록시·클라이언트 타임아웃을 막는다. 마지막 줄이 최종 결과다.
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    const line = (obj: unknown): void => {
      if (!res.destroyed) res.write(JSON.stringify(obj) + '\n');
    };
    line({ status: 'uploaded', bytes: size, filename });
    let last: ImportProgress = { files: 0, newCount: 0, skippedCount: 0, failed: 0 };
    let lastSent = Date.now();
    const heartbeat = setInterval(() => line({ status: 'processing', ...last }), 15_000);
    try {
      const result = await importFile(getDb(), tmp, {
        filename,
        direction: direction as 'sent' | 'received' | undefined,
        selfEmail: serviceConfig.selfEmail,
        onProgress: (p) => {
          last = p;
          if (p.files % 200 === 0 || Date.now() - lastSent > 5_000) {
            lastSent = Date.now();
            line({ status: 'processing', ...p });
          }
        },
      });
      log(`import done (${filename ?? 'upload'}): files=${result.files} new=${result.newCount} skipped=${result.skippedCount} failed=${result.failed}`);
      line({ status: 'done', ...result });
    } catch (err) {
      log('import error:', err);
      line({ status: 'error', error: err instanceof Error ? err.message : String(err), ...last });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  } finally {
    importRunning = false;
    await fs.promises.rm(tmp, { force: true });
  }
}

export function createHttpServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    try {
      if (url.pathname === '/health' || url.pathname === '/') return await handleHealth(res);
      // 팀 업무 현황판: 정적 파일만 내려주고 데이터는 브라우저가 Google 로그인으로 직접 읽는다 (토큰 인증 대상 아님)
      if (await handleDashboard(url.pathname, req.method || 'GET', res)) return;

      // /mcp 또는 /mcp/<token>, /import 또는 /import/<token>
      const route = segments[0];
      const pathToken = segments[1];
      if (route !== 'mcp' && route !== 'import') return json(res, 404, { error: 'not found' });
      if (!isAuthorized(req, pathToken)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="hiworks-mcp"');
        return json(res, 401, { error: 'unauthorized' });
      }
      if (route === 'import') {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        return await handleImport(req, res, url);
      }
      if (!['POST', 'GET', 'DELETE'].includes(req.method || '')) return json(res, 405, { error: 'method not allowed' });
      await handleMcp(req, res);
    } catch (err) {
      log('request error:', err);
      if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
      else res.end();
    }
  });
  // 대용량 백업 업로드(수 GB)가 Node 기본 요청 타임아웃(5분)에 끊기지 않도록 한다. 헤더 타임아웃은 유지.
  server.requestTimeout = 0;
  return server;
}

async function main(): Promise<void> {
  if (!serviceConfig.authToken || serviceConfig.authToken.length < 16) {
    console.error('MCP_AUTH_TOKEN 환경변수를 16자 이상으로 설정해야 서버를 시작할 수 있습니다. 예: openssl rand -hex 32');
    process.exit(1);
  }
  await runMigrations();
  const server = createHttpServer();
  // 호스트를 지정하지 않으면 '::' 듀얼스택으로 IPv4·IPv6 모두 받는다 (Railway 프록시는 IPv6 로 접속한다)
  server.listen(serviceConfig.port, () => {
    console.error(`hiworks MCP server ${PACKAGE_VERSION} listening on :${serviceConfig.port} (/mcp, /health, /import, /dashboard)`);
  });
  const shutdown = () => {
    server.close(() => {
      void closeDb().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const isEntry = process.argv[1] && /remote[\\/]server\.js$/.test(process.argv[1]);
if (isEntry) {
  main().catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
  });
}
