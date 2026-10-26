import type { IncomingMessage } from 'http';
import { accountByToken, type Account } from '../account.js';
import { accountByAccessToken } from './oauth.js';

/**
 * 외부 연결 인증. 토큰이 어느 계정의 것인지 찾아 돌려준다 (없으면 null). 다음 중 하나로 토큰을 전달한다.
 *  - Authorization: Bearer <OAuth 접속 토큰>  (claude.ai 커넥터 — 사람마다 로그인. 권장)
 *  - Authorization: Bearer <고정 토큰>        (Claude Code, Claude Desktop, MCP Inspector)
 *  - X-API-Key: <고정 토큰>
 *  - URL 경로 /mcp/<고정 토큰>                (헤더를 못 넣는 클라이언트용 비밀 URL)
 * 고정 토큰(MCP_AUTH_TOKEN 등)은 STATIC_TOKEN_AUTH=off 로 끌 수 있다. 조직 커넥터에 고정 토큰을 넣으면
 * 조직 전체에 공유되므로, claude.ai 에는 OAuth 로만 연결한다.
 */
export async function authorizedAccount(req: IncomingMessage, pathToken: string | undefined): Promise<Account | null> {
  const staticOn = (process.env['STATIC_TOKEN_AUTH'] || 'on').toLowerCase() !== 'off';
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    if (staticOn) {
      const acc = accountByToken(token);
      if (acc) return acc;
    }
    const oauth = await accountByAccessToken(token);
    if (oauth) return oauth;
  }
  if (!staticOn) return null;
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string') {
    const acc = accountByToken(apiKey);
    if (acc) return acc;
  }
  if (pathToken) return accountByToken(pathToken);
  return null;
}
