# 클라이언트 연결 가이드 (Claude Code / Claude Desktop / ChatGPT)

서버 주소를 `https://<your-app>.up.railway.app` 라고 가정한다. 인증 토큰은 Railway 의 `MCP_AUTH_TOKEN`.

## Claude Code (원격 HTTP)

```bash
claude mcp add --transport http hiworks-remote https://<your-app>.up.railway.app/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
claude mcp list        # 연결 확인
```

세션에서:
> `get_sync_status` 로 동기화 상태를 보여 줘.
> 지난주 보낸 메일을 사업별로 요약해 줘.
> 2025-09-02 업무일지를 만들어 줘.

## Claude Desktop

`claude_desktop_config.json` 에 HTTP 서버를 직접 넣을 수 없는 버전이면 `mcp-remote` 브리지를 쓴다.

```json
{
  "mcpServers": {
    "hiworks-remote": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-app>.up.railway.app/mcp", "--header", "Authorization: Bearer <MCP_AUTH_TOKEN>"]
    }
  }
}
```

## ChatGPT (커스텀 커넥터 / 개발자 모드)

ChatGPT 커넥터는 인증 방식으로 OAuth 또는 "없음" 만 고른다. 그래서 이 서버는 **URL 경로에 토큰을 넣는 비밀 URL** 을 지원한다.

1. ChatGPT → 설정 → 커넥터 → "만들기" (개발자 모드 필요).
2. MCP 서버 URL: `https://<your-app>.up.railway.app/mcp/<MCP_AUTH_TOKEN>`
3. 인증: 없음.
4. 저장 후 대화에서 커넥터를 켜고 사용한다. ChatGPT 가 요구하는 `search` / `fetch` 도구가 포함되어 있어 딥리서치에서도 쓸 수 있다.

비밀 URL 은 토큰과 같으므로 공유하지 않는다. 유출 시 Railway 에서 `MCP_AUTH_TOKEN` 을 바꾸면 즉시 무효화된다.

## MCP Inspector 로 점검

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: https://<your-app>.up.railway.app/mcp
# Headers: Authorization: Bearer <MCP_AUTH_TOKEN>
```

## curl 로 상태 확인

```bash
curl https://<your-app>.up.railway.app/health
curl -X POST https://<your-app>.up.railway.app/mcp \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 검증 상태
- Streamable HTTP 서버, Bearer/X-API-Key/경로 토큰 인증, 14개 도구 호출: 공식 MCP TypeScript SDK 클라이언트로 통합 테스트 통과.
- 실제 Claude Code / ChatGPT 앱에서의 연결: 이 개발 환경에서는 배포 서버가 없어 **미검증**. 위 절차는 각 제품의 공개 문서 기준이다.
