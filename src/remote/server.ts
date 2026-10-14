#!/usr/bin/env node
import http, { type IncomingMessage, type ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { sql } from 'drizzle-orm';
import { PACKAGE_VERSION, log, serviceConfig } from '../config.js';
import { closeDb, getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { importMessages } from '../sync/import.js';
import { listSyncStates } from '../sync/state.js';
import { isAuthorized } from './auth.js';
import { buildMcpServer } from './tools.js';

const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

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
  const body = await readBody(req, MAX_IMPORT_BYTES);
  if (body.length === 0) return json(res, 400, { error: '파일 본문이 비어 있습니다.' });
  const result = await importMessages(getDb(), body, { direction: direction as 'sent' | 'received' | undefined, filename, selfEmail: serviceConfig.selfEmail });
  json(res, 200, result);
}

export function createHttpServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    try {
      if (url.pathname === '/health' || url.pathname === '/') return await handleHealth(res);

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
}

async function main(): Promise<void> {
  if (!serviceConfig.authToken || serviceConfig.authToken.length < 16) {
    console.error('MCP_AUTH_TOKEN 환경변수를 16자 이상으로 설정해야 서버를 시작할 수 있습니다. 예: openssl rand -hex 32');
    process.exit(1);
  }
  await runMigrations();
  const server = createHttpServer();
  server.listen(serviceConfig.port, '0.0.0.0', () => {
    console.error(`hiworks MCP server ${PACKAGE_VERSION} listening on :${serviceConfig.port} (/mcp, /health, /import)`);
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
