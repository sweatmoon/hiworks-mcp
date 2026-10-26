# 팀원 메일함 추가 (중앙 관리)

하이웍스 MCP 는 **서버 하나, DB 하나로 여러 사람의 메일함**을 나눠 담는다. 관리자가 Railway 변수에 팀원 계정을 추가하면 된다.

```
Railway 프로젝트 (관리자)
 ├─ Postgres       ← 한 DB. 모든 행에 account 열(main, jinminju, ...)이 붙어 서로 섞이지 않는다
 ├─ hiworks-mcp    ← 접속 토큰으로 누구의 메일함인지 가린다
 └─ mail-worker    ← 등록된 계정을 차례로 10분마다 동기화
```

- 팀원마다 **접속 토큰이 다르다.** 토큰이 곧 "누구의 메일함인가"이다. 김현호 토큰으로는 김현호 메일만, 진민주 토큰으로는 진민주 메일만 보인다.
- 기존 계정(`HIWORKS_USERNAME` / `HIWORKS_PASSWORD` / `MCP_AUTH_TOKEN`)은 `main` 계정이다. 기존 데이터도 그대로 `main` 으로 남는다.
- 관리자는 Railway 변수와 DB 를 볼 수 있으므로 팀원의 비밀번호와 메일을 볼 수 있다. 팀원에게 이 점을 알리고 동의를 받는다.

---

## 1. 팀원 계정 키 정하기

영문 대문자·숫자·`_` 로 짧게 정한다. 예: 진민주 → `JINMINJU`. (`MAIN` 은 쓸 수 없다)
아래 `<KEY>` 자리에 넣는다.

## 2. 토큰 만들기

64자 무작위 값을 만든다. Railway 변수 편집 화면에서 값 칸에 `${{secret(64, "abcdef0123456789")}}` 를 넣으면 Railway 가 만들어 준다. 직접 만들 때는 `openssl rand -hex 32`.

- 16자 미만이거나 다른 계정과 같은 토큰은 서버가 받지 않는다 (그 계정은 건너뛴다).

## 3. Railway 변수 추가

**hiworks-mcp** 서비스 → Variables:

| 변수 | 값 |
|---|---|
| `ACCOUNT_<KEY>_USERNAME` | 팀원 하이웍스 메일 주소 |
| `ACCOUNT_<KEY>_PASSWORD` | 팀원 하이웍스 비밀번호 |
| `ACCOUNT_<KEY>_TOKEN` | 2번에서 만든 토큰 |

**mail-worker** 서비스 → Variables (값을 다시 적지 않고 hiworks-mcp 의 값을 참조한다):

| 변수 | 값 |
|---|---|
| `ACCOUNT_<KEY>_USERNAME` | `${{hiworks-mcp.ACCOUNT_<KEY>_USERNAME}}` |
| `ACCOUNT_<KEY>_PASSWORD` | `${{hiworks-mcp.ACCOUNT_<KEY>_PASSWORD}}` |

Worker 는 접속을 받지 않으므로 토큰이 필요 없다. **Deploy** 를 눌러 두 서비스를 다시 띄운다.

확인:
- mail-worker 로그 첫 줄에 `accounts=main,<key>` 가 보인다.
- `https://<서버 도메인>/health` 의 `accounts` 숫자가 늘었다.

## 4. 팀원 쪽: 하이웍스 POP3 켜기

팀원이 하이웍스 웹메일 → 환경설정 → **POP3/SMTP 사용** 을 켠다. 꺼져 있으면 동기화가 실패한다.

## 5. 팀원 쪽: claude.ai 커넥터 추가

claude.ai 커넥터는 **OAuth 로그인**으로 연결한다. 조직 소유자가 추가한 커넥터는 조직 전체에 보이므로, 헤더 토큰을 넣으면 그 토큰이 모두에게 공유된다.

1. 관리자가 서버 변수 `ACCOUNT_<KEY>_OAUTH_PASSWORD`(12자 이상)를 넣고, 그 비밀번호를 팀원에게 직접(대면 또는 사내 보안 채널로) 전한다. 채팅·메일 본문에 붙여 넣지 않는다.
2. 조직 커넥터 `hiworks`(URL `https://<서버 도메인>/mcp`, 인증 OAuth)가 이미 있으면 팀원은 **연결**만 누른다. 없으면 관리자가 `docs/CONNECT_CLIENTS.md` 의 claude.ai 절차로 한 번 추가한다.
3. 로그인 화면에서 **팀원 본인의 메일 주소**와 연결 비밀번호를 넣는다. 그 팀원의 메일함만 열린다.
4. 새 대화에서 커넥터를 켜고 묻는다.
   > 하이웍스 동기화 상태 보여 줘.

Claude Code 에서 이 저장소를 쓰는 경우에는 환경 변수로 넣는다.

```bash
export HIWORKS_MCP_URL="https://<서버 도메인>/mcp"
export HIWORKS_MCP_TOKEN="<팀원 토큰>"
```

## 6. (선택) 보낸메일 넣기

POP3 는 받은메일만 가져온다. 보낸편지함 백업(.zip/.eml)을 **팀원 토큰으로** 올리면 그 팀원의 메일함에 들어간다. 방법은 `docs/SENT_MAIL.md` (토큰 자리에 팀원 토큰).

서버 컨테이너에서 파일로 직접 가져올 때는 `IMPORT_ACCOUNT=<key>` 를 붙인다 (없으면 main).

---

## 팀원 빼기 / 토큰 바꾸기

- 빼기: 두 서비스에서 `ACCOUNT_<KEY>_*` 변수를 지우고 다시 배포한다. 그 토큰은 바로 막힌다. DB 에 남은 메일은 그대로 있으니, 지우려면 관리자가 DB 에서 `account = '<key>'` 행을 직접 지운다 (MCP 도구로는 지울 수 없다).
- 토큰 유출: `ACCOUNT_<KEY>_TOKEN` 만 새 값으로 바꾸고 다시 배포한다.
- OAuth 연결 끊기: `ACCOUNT_<KEY>_OAUTH_PASSWORD` 를 바꾸면 그 팀원이 받은 OAuth 토큰이 모두 무효가 된다.

## 보안 원칙
- 원격 서버는 **읽기 전용**이다. 메일 삭제 도구가 없고, 메일 발송 도구도 원격 서버에는 없다.
- 모든 메일·할 일·업무일지 조회는 접속 토큰의 계정으로만 걸러진다. 계정 문맥 없이 메일 데이터에 접근하면 서버가 오류로 막는다.
- 비밀번호·토큰은 Railway 변수에만 둔다. 저장소·문서·채팅에 남기지 않는다.
- 서버 로그에는 메일 원문과 자격증명을 남기지 않는다. 계정 설정 오류도 이유만 남기고 값은 남기지 않는다.
- `/health` 는 계정 수만 보여 주고 계정 이름·오류는 보여 주지 않는다.
- 하이웍스가 추가 인증(CAPTCHA, 2단계 인증)을 요구하면 우회하지 않는다. 그 팀원이 웹메일에서 직접 로그인해 해제한다.
