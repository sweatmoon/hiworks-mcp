# 기능별 검증 결과

검증 환경: Ubuntu 컨테이너, Node 22, PostgreSQL 16 (로컬 설치, pg_trgm), 목 POP3/SMTP 서버, 가짜 LLM.
이 환경에서는 hiworks.com, Railway, Anthropic API 에 접근할 수 없었다. 아래 "검증" 은 자동 테스트(`npm test`)로 확인한 범위다.

| # | 기능 | 상태 | 검증 방법 / 제한 |
|---|---|---|---|
| 1 | PostgreSQL 스키마 (emails, email_attachments, email_sync_state, sync_runs, work_activities, daily_worklogs) | ✅ 검증 | 실제 PostgreSQL 16 에 마이그레이션 2회 적용(멱등). `drizzle/0000_init.sql` |
| 2 | 중복 방지 (Message-ID / 지문, source+uid 부분 유니크) | ✅ 검증 | 같은 ZIP 재가져오기 → 0건 추가, Message-ID 없는 메일 재가져오기 → 0건 |
| 3 | 한글 검색 (pg_trgm ILIKE + tsvector simple 랭킹) | ✅ 검증 | "견적" 으로 "견적서를/견적서" 매칭, 다중 단어 AND, 보낸사람/받는사람/제목/기간/첨부/사업 필터, limit/offset, relevance 정렬 |
| 4 | 수신메일 증분 동기화 (POP3 UIDL) | ✅ 검증 (목 POP3) | 2회차 0건, 신규 1건 감지, 백업으로 먼저 들어온 메일의 uid 보강 |
| 5 | BCC 자기 사본 → 발신으로 분류 | ✅ 검증 (목 POP3) | 발신자=본인 메일이 `direction=sent` |
| 6 | 보낸메일 가져오기 (EML ZIP / EML / mbox) | ✅ 검증 (합성 파일) | 실제 하이웍스 백업 파일 형식은 미확인 |
| 7 | 하이웍스 공식 API 보낸메일 조회 | ❌ 미확인 | 문서 원문 접근 불가. `docs/SENT_MAIL.md` 참고 |
| 8 | Playwright 웹메일 보낸메일 수집 | ⚠️ 골격만, 미검증 | 셀렉터 환경변수 주입, 프로브 스크립트 제공. CAPTCHA/추가 인증 시 중단 |
| 9 | 동기화 중복 실행 방지 (advisory lock) | ✅ 검증 | 다른 세션이 잠금 보유 시 `acquired=false` |
| 10 | 동기화 오류 기록·지수 백오프·강제 재시도 | ✅ 검증 | 잘못된 비밀번호 → status=error, failures=1, next_retry_at; 백오프 중 skip; force 로 복구 |
| 11 | 원격 MCP 서버 (Streamable HTTP, stateless) | ✅ 검증 | 공식 SDK `StreamableHTTPClientTransport` 로 tools/list, tools/call. 실제 기동 후 curl 로 tools/list 확인. `MCP_AUTH_TOKEN` 16자 미만이면 기동 거부 확인 |
| 12 | 외부 연결 인증 (Bearer / X-API-Key / 경로 토큰) | ✅ 검증 | 401 (무토큰·오토큰), 200 (Bearer, 경로 토큰) |
| 13 | Health Check (`/health`, DB 확인) | ✅ 검증 | 서버 `/health` 200 (통합 테스트 + 실제 기동 스모크). Worker `/health` 200 (loop 모드 기동 스모크) |
| 14 | `/import` HTTP 업로드 | ✅ 검증 | ZIP 업로드 → 1건 저장, 무인증 401 |
| 15 | MCP 도구 sync_emails / search_emails / read_email / get_email_statistics / get_sent_emails / extract_work_activities / generate_daily_worklog / get_daily_worklog / get_sync_status / import_emails / search / fetch / ping | ✅ 검증 | 통합 테스트에서 각 도구 호출 |
| 16 | 통계 (발신·수신 건수, 일/주/월 추이, 주요 상대, 사업별, 미처리 요청 후보) | ✅ 검증 | 합성 데이터로 수치 확인. 미처리 후보: 답장 있는 스레드 제외 확인 |
| 17 | AI 업무일지 — LLM 호출 (claude-opus-5-5, 구조화 출력) | ⚠️ 코드만, 미검증 | API 키 없음. 가짜 LLM 으로 파이프라인만 검증 |
| 18 | AI 업무일지 — 근거 검증 (입력에 없는 id 제거, 확인 필요 표시), 스레드 중복 제거, 본문 최소 전달 | ✅ 검증 | 지어낸 활동 → needs_review, evidence 비움; 스레드당 1통, 본문 ≤1200자 |
| 19 | 업무일지 Markdown/JSON 생성·저장·재사용 | ✅ 검증 | daily_worklogs 업서트, reuseActivities 시 LLM 미호출 |
| 20 | 규칙 기반 추출 (LLM 없이) | ✅ 검증 | 전부 needs_review=true |
| 21 | Worker 루프/once 모드 | ✅ 검증 (스모크) | `WORKER_MODE=once` 실행 후 종료 코드 0, loop 모드에서 동기화 1회 + `/health` 응답 확인. 보관기간 삭제(`EMAIL_RETENTION_DAYS`)는 코드만 |
| 22 | Dockerfile / Dockerfile.worker | ⚠️ 미검증 | Docker 데몬 없음. 표준 multi-stage |
| 23 | Railway 배포 (railway.*.json, 자동 배포, 변수, HTTPS) | ⚠️ 미검증 | 계정·네트워크 없음. `docs/DEPLOY_RAILWAY.md` |
| 24 | Claude Code / ChatGPT 실제 앱 연결 | ⚠️ 미검증 | 프로토콜 수준(SDK 클라이언트)만 검증. `docs/CONNECT_CLIENTS.md` |
| 25 | 로컬 stdio MCP (9개 도구) | ✅ 검증 | `test/e2e.mjs` 39건 |
| 26 | 업무관리: tasks 테이블, create/update/list/get, 지연·마감 계산, 메모 덧붙이기 | ✅ 검증 | 실제 PostgreSQL 통합 테스트 (마이그레이션 0001) |
| 27 | 할 일 후보 메일 (요청 표현, 미등록, 미회신, 자동 발신 제외) | ✅ 검증 | 답장한 스레드·뉴스레터 제외, 등록 후 후보에서 제외, includeLinked 시 연결 id 표시 |
| 28 | daily_brief, get_reply_context | ✅ 검증 | 구조·수치 확인. MCP 경유 daily_brief/create_task/list_tasks 호출 |
| 29 | work-manager 스킬로 Claude Code 에서 실제 운용 | ⚠️ 미검증 | 배포 서버 없음. 지침 문서만 제공 |

## 테스트 실행
```bash
npm run test:local                              # 목 POP3/SMTP, DB 불필요
DATABASE_URL=postgres://u:p@localhost:5432/db npm run test:remote   # 실제 PostgreSQL 필요 (테스트가 public 스키마를 초기화한다!)
```
`test:remote` 는 **public 스키마를 drop** 하므로 전용 테스트 DB 를 쓴다.
