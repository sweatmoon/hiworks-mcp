# 클라이언트 연결 가이드 (Claude Code / Claude Desktop / ChatGPT)

서버 주소를 `https://<your-app>.up.railway.app` 라고 가정한다. 인증 토큰은 Railway 의 `MCP_AUTH_TOKEN`.

## claude.ai 커넥터 (OAuth 로그인, 권장)

Team 조직의 소유자가 추가한 사용자 지정 커넥터는 **조직 전체에 보인다**. 헤더(`x-api-key`)나 URL 경로에 고정 토큰을 넣으면
그 토큰이 조직에 공유되어 팀원도 이 메일함을 읽을 수 있다. claude.ai 에는 반드시 OAuth 로 연결한다.

1. Railway 서버 변수 `OAUTH_LOGIN_PASSWORD` 에 12자 이상 비밀번호를 넣는다(본인만 알고, 메일 비밀번호와 다르게).
2. claude.ai → 설정 → 커넥터 → **사용자 지정 커넥터 추가**
   - URL: `https://<your-app>.up.railway.app/mcp` (경로에 토큰을 붙이지 않는다)
   - 인증: OAuth(로그인). 요청 헤더는 비워 둔다. OAuth 클라이언트 ID·시크릿도 비워 둔다(동적 등록).
3. **연결**을 누르면 「hiworks 메일 연결」 화면이 뜬다. 메일 주소와 연결 비밀번호로 로그인한다.
4. 팀원이 같은 커넥터를 켜도 로그인 화면에서 막힌다(자기 계정의 `ACCOUNT_<KEY>_OAUTH_PASSWORD` 가 있으면 자기 메일함만 열린다).

- 접속 토큰 24시간, 갱신 토큰 90일(쓸 때마다 새로 발급). `OAUTH_ACCESS_TTL_HOURS`, `OAUTH_REFRESH_TTL_DAYS` 로 바꾼다.
- 로그인 실패는 같은 IP 15분 5회, 전체 1시간 30회에서 잠긴다.
- **모든 연결을 끊으려면** `OAUTH_LOGIN_PASSWORD` 를 바꾼다. 이전에 받은 토큰이 모두 무효가 된다.
- 고정 토큰 방식을 아예 막으려면 `STATIC_TOKEN_AUTH=off`. (Claude Code·백업 업로드도 고정 토큰을 쓰므로, 쓰지 않을 때만)

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
