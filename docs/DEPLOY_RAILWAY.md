# Railway 배포

구성: PostgreSQL 1개 + 같은 저장소에서 빌드하는 서비스 2개(mcp-server, mail-worker).

## 1. 프로젝트와 PostgreSQL
1. Railway 새 프로젝트 → **Add Database → PostgreSQL**. (표준 이미지라 `pg_trgm` 확장 생성이 가능하다. 마이그레이션이 자동으로 만든다.)
2. 외부 공개 접속(TCP Proxy)은 켜지 않는다. 서비스는 내부 주소 `${{Postgres.DATABASE_URL}}` 로 연결한다.

## 2. mcp-server 서비스
1. **New → GitHub Repo** 로 이 저장소를 연결한다 (브랜치 선택).
2. Settings → **Config-as-code → Config File Path** 에 `railway.server.json` 을 지정한다. (Dockerfile 빌드, 시작 명령, `/health` 헬스체크가 들어 있다.)
3. Variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `MCP_AUTH_TOKEN` = `openssl rand -hex 32` 결과 (Claude Code·백업 업로드용, claude.ai 커넥터에는 넣지 않음)
   - `OAUTH_LOGIN_PASSWORD` = 12자 이상, 본인만 아는 값 (claude.ai 커넥터 OAuth 로그인)
   - `HIWORKS_USERNAME`, `HIWORKS_PASSWORD` (sync_emails 도구로 즉시 동기화하려면 필요)
   - `ANTHROPIC_API_KEY` (AI 업무일지)
   - `PROJECT_RULES` (선택)
   - 팀원 계정 (선택): `ACCOUNT_<KEY>_USERNAME`, `ACCOUNT_<KEY>_PASSWORD`, `ACCOUNT_<KEY>_TOKEN`. [TEAM_SETUP.md](TEAM_SETUP.md)
4. Settings → Networking → **Generate Domain**. HTTPS 는 Railway 가 자동 적용한다.
5. 배포 후 `https://<domain>/health` 가 `{"ok":true,...}` 를 돌려주면 완료.

## 3. mail-worker 서비스
1. 같은 저장소로 서비스를 하나 더 만든다.
2. Config File Path: `railway.worker.json`. (Playwright 웹메일 수집을 쓸 때만 `build.dockerfilePath` 를 `Dockerfile.worker` 로 바꾼다.)
3. Variables: `DATABASE_URL`, `HIWORKS_USERNAME`, `HIWORKS_PASSWORD`, `SYNC_INTERVAL_MINUTES`(기본 10), `SENT_SYNC_MODE`(기본 import), `PROJECT_RULES`, `EMAIL_RETENTION_DAYS`(선택). 팀원 계정이 있으면 `ACCOUNT_<KEY>_USERNAME`, `ACCOUNT_<KEY>_PASSWORD` 를 `${{hiworks-mcp.ACCOUNT_<KEY>_USERNAME}}` 처럼 참조로 넣는다 (토큰은 필요 없다).
4. 공개 도메인은 필요 없다. `/health` 는 Railway 내부 헬스체크용이다.

### 대안: Railway Cron 으로 실행
항상 떠 있는 Worker 대신 Settings → **Cron Schedule** (예: `*/10 * * * *`) 을 걸고 `WORKER_MODE=once` 로 두면, 실행마다 한 번 동기화하고 종료한다. 이 경우 `railway.worker.json` 의 `healthcheckPath` 를 지우고 `restartPolicyType` 을 `NEVER` 로 바꾼다.

## 4. 자동 배포와 마이그레이션
- GitHub 브랜치에 push 하면 두 서비스가 모두 다시 빌드·배포된다.
- 마이그레이션(`drizzle/*.sql`)은 각 서비스가 **기동할 때 advisory lock 안에서 자동 적용** 한다. 두 서비스가 동시에 떠도 한 번만 실행된다.
- 스키마를 바꾸면 `npm run db:generate` 로 SQL 을 만들어 커밋한다.

## 5. 중복 실행 방지와 재시도
- 동기화는 계정마다 `pg_try_advisory_lock(hashtext('hiworks-mail-sync'))` (main) / `hiworks-mail-sync:<key>` (팀원) 를 잡은 프로세스만 실행한다 (Worker 와 서버의 `sync_emails` 가 겹쳐도 안전). Worker 는 계정을 차례로 동기화하고, 한 계정이 실패해도 나머지는 계속한다.
- 실패하면 `email_sync_state` 에 오류와 연속 실패 횟수를 기록하고 `next_retry_at` 까지 지수 백오프(최대 2시간)한다. `sync_runs` 에 실행 이력이 남는다.
- Worker 의 `/health` 는 연속 5회 이상 실패 시 503 을 돌려주므로 Railway 가 재시작한다.

## 6. 보안 체크리스트
- 비밀번호·토큰·API 키는 Railway Variables 에만 둔다. 저장소에는 `.env.example` 만 있다.
- 서버는 `MCP_AUTH_TOKEN`(16자 이상)과 `OAUTH_LOGIN_PASSWORD`(12자 이상)가 둘 다 없으면 기동을 거부한다. 팀원 토큰이 16자 미만이거나 다른 계정과 겹치면 그 계정만 건너뛴다.
- 모든 메일·할 일·업무일지 조회는 접속 토큰의 계정(`account` 열)으로 걸러진다.
- 메일 삭제 도구는 없다. 원격 서버는 읽기 전용이며 SMTP 발송 도구도 노출하지 않는다 (로컬 stdio 서버에만 send/reply/forward 가 있다).
- 로그에는 메일 원문·자격증명을 남기지 않는다 (`NODE_ENV=development` 일 때만 디버그 로그).
- 보관기간: `EMAIL_RETENTION_DAYS` 로 오래된 메일을 자동 삭제할 수 있다.

## 검증 상태
Railway 계정과 네트워크가 없는 환경에서 작성했다. Dockerfile 은 로컬 Docker 데몬이 없어 **이미지 빌드를 실행하지 못했다** (표준 multi-stage 구성이며 `npm ci → tsc → prune` 순서). 실제 배포 시 빌드 로그를 확인해야 한다.
