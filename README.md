<a href="https://glama.ai/mcp/servers/@beylessai/hiworks-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@beylessai/hiworks-mcp/badge" />
</a>

# Hiworks Mail MCP

하이웍스 메일을 AI 도구(Claude, ChatGPT, Cursor)에서 검색·분석할 수 있게 해주는 MCP(Model Context Protocol) 서버입니다. 두 가지 형태로 쓸 수 있습니다.

| 형태 | 용도 | 저장소 | 실행 |
|---|---|---|---|
| **원격 서버 (v2)** | Railway 에 배포, Claude Code·ChatGPT 에서 HTTPS 로 연결. PostgreSQL 에 메일을 동기화해 검색·통계·AI 업무일지 제공 | PostgreSQL | `mcp-server` + `mail-worker` 서비스 |
| **로컬 stdio (v1)** | 내 PC 의 Claude Desktop/Cursor 에서 POP3/SMTP 를 직접 호출 (읽기·보내기·답장) | 없음 | `npx hiworks-mail-mcp` |

하이웍스는 POP3/SMTP 만 제공하므로(IMAP 없음) 원격 서버는 받은편지함을 POP3 로 증분 수집하고, 보낸메일은 **편지함 백업 파일 가져오기** 와 **숨은참조 자기 사본** 으로 모읍니다. 자세한 검증 결과는 [docs/SENT_MAIL.md](docs/SENT_MAIL.md) 와 [docs/VERIFICATION.md](docs/VERIFICATION.md) 를 보세요.

## 아키텍처 (원격)

```
Claude Code / ChatGPT ──HTTPS──▶ mcp-server (/mcp, /health, /import)
                                      │ DATABASE_URL (Railway 내부망)
                                      ▼
                                 PostgreSQL ◀── mail-worker (POP3 증분 동기화, 10분 주기)
                                      ▲
                     편지함 백업 ZIP ──┘ (/import 또는 npm run import)
```

- 동기화 중복 실행은 PostgreSQL advisory lock 으로 막습니다. 실패는 `email_sync_state`/`sync_runs` 에 기록하고 지수 백오프로 재시도합니다.
- 검색은 `pg_trgm` 부분 일치(한글 조사 변화에 강함) + `tsvector('simple')` 랭킹입니다.
- AI 업무일지는 발신 메일 중심으로 활동을 추출하고 **모든 활동에 근거 메일 id** 를 붙입니다. 근거가 없거나 확신이 낮으면 `[확인 필요]` 로 표시합니다.

## 원격 서버 도구

| 도구 | 설명 |
|---|---|
| `sync_emails` | POP3 동기화 즉시 실행 (잠금·백오프 적용) |
| `search_emails` | 조건 검색 (query/from/to/subject/since/before/hasAttachments/project, limit/offset, 정렬) |
| `get_sent_emails` | 보낸 메일만 조회 |
| `read_email` | 본문·첨부 목록, 스레드 |
| `get_email_statistics` | 발신·수신 건수, 일/주/월 추이, 주요 상대, 사업별 건수, 미처리 요청 후보 |
| `extract_work_activities` | 날짜별 업무 활동 추출 (LLM 또는 규칙), work_activities 저장 |
| `generate_daily_worklog` / `get_daily_worklog` | 업무일지 생성(Markdown+JSON, daily_worklogs 저장) / 조회 |
| `get_sync_status` | 수집원별 상태·오류·최근 실행·메일 수 |
| `import_emails` | 백업 파일(EML ZIP/EML/mbox) base64 가져오기 (큰 파일은 `/import`) |
| `search` / `fetch` | ChatGPT 커넥터 규약용 |
| `ping` | 연결 확인 |

**업무관리 (에이전트용)** — 자세한 사용법은 [docs/AGENT.md](docs/AGENT.md), 에이전트 지침은 [.claude/skills/work-manager/SKILL.md](.claude/skills/work-manager/SKILL.md)

| 도구 | 설명 |
|---|---|
| `daily_brief` | 지연·오늘 마감·임박·진행 중·새 요청 메일·최근 완료·동기화 상태 (브리핑 원자료) |
| `find_actionable_emails` | 요청·기한 표현이 있고 미등록·미회신인 수신 메일 후보 (규칙 기반, 판단은 Claude) |
| `create_task` / `update_task` / `list_tasks` / `get_task` | 할 일 등록(근거 메일 연결)·상태/마감/메모 갱신·조회·상세 |
| `get_reply_context` | 답장 초안용 맥락 (원문, 스레드, 같은 상대에게 보낸 최근 메일). 발송은 하지 않음 |

원격 서버는 메일에 대해 **읽기 전용** 입니다(쓰기는 할 일 테이블만). 메일 삭제·발송 도구는 없습니다.

## 빠른 시작 (원격)

1. [docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md) 대로 PostgreSQL, mcp-server, mail-worker 를 만들고 [.env.example](.env.example) 의 변수를 설정합니다.
2. 하이웍스 웹메일 **메일 > 환경설정 > 기본 설정** 에서 POP3/SMTP 사용을 켭니다.
3. 보낸메일 과거분은 **편지함 백업** 파일을 `/import?direction=sent` 로 올립니다. 이후분은 발송 시 자신을 숨은참조에 넣으면 자동 수집됩니다.
4. [docs/CONNECT_CLIENTS.md](docs/CONNECT_CLIENTS.md) 대로 Claude Code 또는 ChatGPT 에 연결합니다.

```bash
claude mcp add --transport http hiworks-remote https://<your-app>.up.railway.app/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

## 로컬 stdio 서버 (v1 호환)

```json
{
  "mcpServers": {
    "hiworks-mail": {
      "command": "npx",
      "args": ["-y", "hiworks-mail-mcp@latest"],
      "env": { "HIWORKS_USERNAME": "your.email@yourcompany.com", "HIWORKS_PASSWORD": "your_password" }
    }
  }
}
```

도구: `search_email`, `read_email`, `check_new_emails`(새 메일만), `list_attachments`, `save_attachment`, `send_email`, `reply_email`, `forward_email`, `read_username`. 모든 날짜는 KST(+09:00)입니다. 환경변수 `HIWORKS_STATE_DIR`, `HIWORKS_DOWNLOAD_DIR` 로 상태·다운로드 폴더를 바꿀 수 있습니다.

## 개발

```bash
npm install
npm run build
npm run test:local                       # 목 POP3/SMTP 로 stdio 서버 검증 (DB 불필요)
DATABASE_URL=postgres://... npm run test:remote   # 실제 PostgreSQL 로 원격 스택 검증 (public 스키마를 초기화하므로 전용 DB 사용)
npm run db:generate                      # 스키마 변경 후 마이그레이션 SQL 생성
npm run start:server / npm run start:worker
```

프로젝트 구조:

```
src/index.ts            로컬 stdio MCP
src/remote/             원격 HTTP MCP 서버 (server.ts, tools.ts, auth.ts)
src/worker/main.ts      Mail Worker
src/sync/               POP3 증분 동기화, 가져오기, 잠금, 상태, (미검증) 웹메일 수집기
src/search/ src/stats/  검색, 통계
src/worklog/            AI 업무일지 (Anthropic SDK, 근거 검증)
src/tasks/              업무관리 (할 일, 브리핑, 후보 메일, 답장 맥락)
.claude/skills/         work-manager 에이전트 스킬
src/db/ drizzle/        Drizzle 스키마, 마이그레이션
docs/                   계획, 검증 결과, 배포, 연결, 보낸메일 가이드
```

## 보안
- 자격증명·토큰은 환경변수로만 전달하고 로그에 남기지 않습니다.
- 원격 서버는 `MCP_AUTH_TOKEN` 없이는 기동하지 않으며 모든 `/mcp`, `/import` 요청에 인증이 필요합니다.
- 단일 개인 계정 전용입니다. `EMAIL_RETENTION_DAYS` 로 보관기간을 둘 수 있습니다.

## 라이선스
MIT. [LICENSE](./LICENSE)
