# Claude Code mod: hiworks-dashboard

Claude Code 세션 안에 "하이웍스 업무" 패널을 띄운다. `hiworks-remote` MCP 서버의 `daily_brief` 와 `get_sync_status` 를 5분마다 호출해 동기화 상태, 지연·오늘 마감·임박·진행 중 할 일, 새 요청 메일을 보여준다. 상태 표시줄에도 `메일 지연N 오늘N 요청N` 이 뜬다.

## 명령
- `/hiworks` 패널 열기
- `/hiworks-refresh` 지금 갱신

## 사용 조건
`hiworks-remote` MCP 서버가 연결돼 있어야 한다 (저장소의 `.mcp.json` 또는 `claude mcp add`). 패널은 터미널 폭 110열 이상에서 옆에 붙고, 좁으면 프롬프트 위에 인라인으로 그려진다.

## 불러오기
```bash
# 이 저장소에서
claude --plugin-dir mods/hiworks-dashboard
```
항상 쓰려면 `~/.claude/settings.json` 의 플러그인 설정에 폴더를 추가하거나, 클라우드 세션에서는 plugin-authoring 스킬의 핫리로드 폴더에 복사한다.

## 검증
```bash
claude plugin validate mods/hiworks-dashboard
claude plugin test mods/hiworks-dashboard   # 가짜 MCP 응답으로 패널 렌더링 2건
```
