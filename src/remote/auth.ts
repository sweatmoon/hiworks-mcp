import type { IncomingMessage } from 'http';
import { accountByToken, type Account } from '../account.js';

/**
 * 외부 연결 인증. 토큰이 어느 계정의 것인지 찾아 돌려준다 (없으면 null). 다음 중 하나로 토큰을 전달한다.
 *  - Authorization: Bearer <token>      (Claude Code, Claude Desktop, MCP Inspector)
 *  - X-API-Key: <token>
 *  - URL 경로 /mcp/<token>              (ChatGPT 커넥터처럼 헤더를 못 넣는 클라이언트용 비밀 URL)
 * 계정마다 토큰이 달라서, 토큰이 곧 "누구의 메일함인가" 이다.
 */
export function authorizedAccount(req: IncomingMessage, pathToken: string | undefined): Account | null {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    const acc = accountByToken(header.slice(7));
    if (acc) return acc;
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string') {
    const acc = accountByToken(apiKey);
    if (acc) return acc;
  }
  if (pathToken) return accountByToken(pathToken);
  return null;
}
