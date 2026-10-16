import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import { serviceConfig } from '../config.js';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * 외부 연결 인증. 다음 중 하나로 토큰을 전달한다.
 *  - Authorization: Bearer <token>      (Claude Code, Claude Desktop, MCP Inspector)
 *  - X-API-Key: <token>
 *  - URL 경로 /mcp/<token>              (ChatGPT 커넥터처럼 헤더를 못 넣는 클라이언트용 비밀 URL)
 */
export function isAuthorized(req: IncomingMessage, pathToken: string | undefined): boolean {
  const expected = serviceConfig.authToken;
  if (!expected || expected.length < 16) return false;
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    if (safeEqual(header.slice(7).trim(), expected)) return true;
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && safeEqual(apiKey.trim(), expected)) return true;
  if (pathToken && safeEqual(pathToken, expected)) return true;
  return false;
}
