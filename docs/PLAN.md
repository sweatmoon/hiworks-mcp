# 하이웍스 MCP 서버 (PostgreSQL + Railway) — 분석, 제약사항, 구현 계획

작성일: 2026-10-14

## 1. 기존 저장소 분석 (beylessai/hiworks-mcp → sweatmoon/hiworks-mcp)

| 항목 | 내용 |
|---|---|
| 구조 | 단일 패키지, stdio MCP 서버 1개 (`src/index.ts`), POP3(node-pop3) + SMTP(nodemailer) + mailparser |
| 원본 상태 (1.0.12) | 최신 MCP SDK에서 빌드 실패, `search_email`의 `query` 미적용, `read_email`이 전체 메일 RETR 스캔, `read_username`이 비밀번호 반환 |
| 선행 작업 (1.1.0, 이 브랜치) | 모듈 분리(`services/pop3.ts`, `services/smtp.ts`, `utils/`), 9개 도구, 목 POP3/SMTP 통합 테스트 39건 통과 |
| 재사용 | `Pop3Session`(UIDL/TOP/RETR 세션), mailparser 파싱, KST 날짜 유틸, 주소 정규화 유틸을 Worker 와 원격 서버가 그대로 사용 |

## 2. 핵심 제약사항 (검증 결과)

### 2.1 하이웍스 메일 프로토콜
- 하이웍스는 **POP3/SMTP만 공식 지원**하고 IMAP 은 제공하지 않는다 (공식 아웃룩 설정 안내: pop3s.hiworks.com:995 / smtps.hiworks.com:465).
- POP3 는 **받은편지함만** 노출한다. 서버 검색·폴더·읽음 상태가 없다. 따라서 수신메일은 UIDL 기반 증분 동기화로 PostgreSQL 에 적재하고, 검색은 DB 에서 수행한다.

### 2.2 보낸메일 수집 (최우선 요구사항) — 검증 결과
| 경로 | 결과 | 근거 |
|---|---|---|
| ① 하이웍스 공식 API | **보낸메일 조회 엔드포인트 확인 불가.** 개발자센터 문서(Postman)에는 "메일 발송", "내 정보 조회" 등 서비스 API 가 있고, 메일 API 는 애플리케이션 등록 후 사용 가능하다고만 안내. 메일함 목록 조회 API 존재 여부는 문서 원문을 열어야 확정되는데, **이 개발 환경에서는 hiworks.com / getpostman.com 접속이 차단**되어 원문을 열지 못했다. | developers.hiworks.com/support, documenter.getpostman.com/view/6863253/S1TVWcri |
| ② 웹메일 백업/내보내기 | **존재 확인.** 메일 > 환경설정 > **편지함 백업** 에서 편지함별(연도별) 백업 파일을 생성해 다운로드할 수 있다. 당일 메일 제외, 생성까지 최대 3일, 다운로드 1주일, 4GB 단위 분할, 동시 5건. 업로드(가져오기)는 .eml 을 ZIP 으로 압축한 파일을 받는다 → 백업 파일도 **EML ZIP** 형식일 가능성이 높다. 보낸메일함이 선택 가능한 편지함에 포함되는지는 실제 화면에서 확인 필요. | hiworks.com/cs/notice/9421, biz-solution.hiworks.com/product/function/mail/backup |
| ③ Playwright 웹메일 수집 | **이 환경에서 검증 불가.** 하이웍스 도메인 접속이 차단되어 있고 실제 계정도 없다. 로그인 폼·보낸메일함 DOM 셀렉터를 확인할 수 없으므로 "구현 완료" 로 표시하지 않는다. 셀렉터를 환경변수로 주입하는 수집기 골격과, 현장에서 셀렉터를 잡기 위한 프로브 스크립트(스크린샷/HTML 덤프)만 제공한다. CAPTCHA·추가 인증은 우회하지 않는다. | — |

**결론:** 보낸메일의 1차 수집 경로는 **편지함 백업 파일(EML/ZIP/mbox) 가져오기** 로 구현·검증한다 (합성 EML 로 테스트). 공식 API 와 Playwright 경로는 사용자가 실제 계정으로 확인한 뒤 활성화할 수 있도록 설정 포인트와 절차를 문서화한다. 추가로, 웹메일에서 발송 시 **자신을 숨은참조(BCC)에 넣는 규칙** 을 쓰면 이후 보낸메일이 POP3 로도 들어오므로 Worker 가 `direction=sent` 로 자동 분류하도록 구현한다 (발신자 = 본인 계정이면 sent).

### 2.3 개발 환경 제약
- 하이웍스 서버, Railway, Anthropic API 모두 이 컨테이너에서 접근 불가 → POP3 는 목 서버, LLM 은 가짜 클라이언트로 테스트. 실제 연동은 "미검증" 으로 명시.
- PostgreSQL 16 은 로컬에 설치해 **실제 DB 로 테스트** (pg_trgm 확장 포함).

### 2.4 한글 검색
- PostgreSQL 기본 텍스트 검색 설정(`simple`/`english`)은 한국어 형태소를 분석하지 못한다. 조사 붙은 단어("견적서를")는 토큰 단위 검색에 걸리지 않는다.
- **전략:** `pg_trgm` GIN 인덱스(제목+본문) 기반 `ILIKE`/trigram 부분 일치를 1차로 쓰고, `to_tsvector('simple')` 는 공백 단위 토큰·정확 일치 가속과 랭킹 보조로 사용한다. Railway PostgreSQL 은 표준 이미지라 `CREATE EXTENSION pg_trgm` 이 가능하다.

### 2.5 ChatGPT 연결
- ChatGPT 커스텀 커넥터(개발자 모드)는 Streamable HTTP MCP 를 받으며 인증은 OAuth 또는 "없음" 만 선택 가능하다. 그래서 Bearer 헤더 외에 **URL 경로 토큰**(`/mcp/<token>`)을 지원해 ChatGPT 에서는 비밀 URL 로 연결한다. ChatGPT 가 기대하는 `search` / `fetch` 도구도 함께 노출한다.

## 3. 아키텍처

```
Railway 프로젝트
├── mcp-server   (src/remote/server.ts)  HTTP :PORT  /mcp, /health, /import
├── mail-worker  (src/worker/main.ts)    주기 동기화 + /health
└── postgres     (Railway Postgres)      내부 네트워크 DATABASE_URL
```
- 두 서비스는 **같은 저장소·같은 Docker 이미지** 에서 시작 명령만 다르게 실행한다 (`railway.server.json`, `railway.worker.json`).
- 마이그레이션은 서비스 기동 시 `pg_advisory_lock` 안에서 자동 적용한다 (drizzle 마이그레이션 SQL).
- 동기화 중복 실행 방지: `pg_try_advisory_lock(hashtext('hiworks-mail-sync'))`.

## 4. 기술 선택
- ORM: **Drizzle** (SQL 친화적 — tsvector/trigram 쿼리를 그대로 쓸 수 있고, 마이그레이션이 평문 SQL 이라 검토가 쉽다)
- LLM: `@anthropic-ai/sdk`, 모델 `claude-opus-5-5`, 구조화 출력(`zodOutputFormat`)으로 JSON 강제. 증거 이메일 id 가 입력 집합에 없으면 `needs_review=true` 로 강등.
- 본문 최소 전달: 스레드별 대표 메일만, 제목 + 본문 앞 N자(기본 1,200자/발신, 600자/수신)만 LLM 에 전달.

## 5. 구현 순서와 상태
구현을 마쳤다. 항목별 검증 상태는 `docs/VERIFICATION.md`, 배포는 `docs/DEPLOY_RAILWAY.md`, 연결은 `docs/CONNECT_CLIENTS.md`, 보낸메일은 `docs/SENT_MAIL.md` 를 본다.

1. 저장소 분석 ✔
2. 보낸메일 수집 가능성 검증 ✔ (위 2.2)
3. PostgreSQL 스키마 / Drizzle
4. 수신메일 증분 동기화 (POP3 UIDL)
5. 보낸메일 수집기: EML/ZIP/mbox 가져오기 (검증) + Playwright 골격 (미검증)
6. 검색·조회 MCP Tool (Streamable HTTP, Bearer/URL 토큰 인증)
7. 통계
8. AI 업무일지 (증거 기반, 가짜 LLM 으로 테스트)
9. Railway 배포 구성 (Dockerfile, railway.*.json, .env.example)
10. Claude Code / ChatGPT 연결 가이드
