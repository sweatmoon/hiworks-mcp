# 팀원별 하이웍스 MCP 설치 안내

하이웍스 MCP 서버는 **메일함 하나 전용**이다. 팀원이 같이 쓰려면 서버 하나를 나눠 쓰지 않고, **각자 자기 서버를 하나씩** 띄운다.
그래야 내 메일은 나만 읽고, 비밀번호·토큰도 각자 자기 Railway 에만 남는다.

```
김현호  → 김현호의 Railway 프로젝트 (Postgres + mcp-server + mail-worker) → 김현호의 claude.ai 커넥터
진민주  → 진민주의 Railway 프로젝트 (Postgres + mcp-server + mail-worker) → 진민주의 claude.ai 커넥터
...
```

- 비용: 각자 Railway 요금이 든다 (Hobby 요금제, 월 5달러 정도에서 시작. 사용량에 따라 다름).
- 다른 사람의 토큰이나 서버 주소를 받아 쓰지 않는다. 그 서버의 메일함이 그대로 열린다.

---

## A. 관리자가 한 번만: Railway 템플릿 만들기

팀원이 버튼 한 번으로 같은 구성을 띄울 수 있게, 이미 운영 중인 프로젝트를 템플릿으로 만든다. (Railway 화면 이름은 바뀔 수 있다.)

1. Railway 에서 지금 쓰는 hiworks 프로젝트를 연다 → 프로젝트 **Settings** → **Generate Template from Project**.
2. 템플릿 편집 화면에서 서비스 3개(Postgres, mcp-server, mail-worker)가 들어갔는지 확인한다.
   - mcp-server: 저장소 `sweatmoon/hiworks-mcp`, 브랜치 지정, Config File Path `railway.server.json`, **Public Networking(도메인 생성) 켬**
   - mail-worker: 같은 저장소·브랜치, Config File Path `railway.worker.json`, 공개 도메인 없음
3. 변수는 아래처럼 바꾼다. **관리자 본인의 값이 템플릿에 남지 않게** 반드시 비운다.

   | 서비스 | 변수 | 템플릿 값 |
   |---|---|---|
   | mcp-server | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | mcp-server | `MCP_AUTH_TOKEN` | `${{secret(64, "abcdef0123456789")}}` (배포할 때마다 새로 만들어짐) |
   | mcp-server | `HIWORKS_USERNAME` | 비움, **Required**, 설명 "하이웍스 메일 주소" |
   | mcp-server | `HIWORKS_PASSWORD` | 비움, **Required**, 설명 "하이웍스 비밀번호" |
   | mail-worker | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | mail-worker | `HIWORKS_USERNAME` | `${{mcp-server.HIWORKS_USERNAME}}` |
   | mail-worker | `HIWORKS_PASSWORD` | `${{mcp-server.HIWORKS_PASSWORD}}` |
   | mail-worker | `SYNC_INTERVAL_MINUTES` | `10` |
   | mail-worker | `SENT_SYNC_MODE` | `import` |

   `ANTHROPIC_API_KEY`, `PROJECT_RULES` 는 넣지 않는다 (선택 기능. 필요한 팀원이 나중에 각자 넣는다).
4. 템플릿을 저장하고 **공개 범위는 링크가 있는 사람만**(비공개/Unlisted)으로 둔다. 만들어진 템플릿 링크를 팀원에게 준다.

> 템플릿을 만들지 않아도 된다. 그때는 팀원이 `docs/DEPLOY_RAILWAY.md` 의 순서대로 서비스 3개를 직접 만든다.

---

## B. 팀원 각자: 내 하이웍스 MCP 만들기 (약 15분)

### 1. 하이웍스에서 POP3 켜기
하이웍스 웹메일 → 환경설정 → **POP3/SMTP 사용** 을 켠다. (이게 꺼져 있으면 메일을 가져오지 못한다.)

### 2. Railway 가입
[railway.com](https://railway.com) 에 가입하고 결제 수단을 등록한다 (Hobby 요금제).

### 3. 템플릿으로 배포
1. 관리자에게 받은 **템플릿 링크**를 연다 → **Deploy Now**.
2. 입력 칸에 **내** 하이웍스 메일 주소와 비밀번호를 넣는다.
3. **Deploy** 를 누르고 세 서비스가 모두 초록색(Active)이 될 때까지 기다린다 (5분 안팎).

### 4. 서버 주소와 토큰 확인
1. **mcp-server** 서비스 → **Settings → Networking** 에서 도메인을 확인한다 (없으면 **Generate Domain**).
   예: `https://hiworks-mcp-production-xxxx.up.railway.app`
2. 브라우저에서 `https://<내 도메인>/health` 를 열어 `"ok":true` 가 보이면 서버가 정상이다.
3. **mcp-server → Variables** 에서 `MCP_AUTH_TOKEN` 값을 복사한다.
   - 이 값은 내 메일함 열쇠다. 메신저·메일·채팅 창에 붙여 넣지 않는다 (Claude 와의 대화 포함).
   - 유출됐다고 생각되면 이 변수 값을 새로 바꾸고, 아래 6번 커넥터의 헤더 값도 바꾼다.

### 5. 메일이 들어오는지 확인
mail-worker 가 10분마다 받은편지함을 가져온다. 처음에는 메일 양에 따라 시간이 걸린다.

### 6. claude.ai 에 커넥터 추가
1. claude.ai → **설정 → 커넥터 → 사용자 지정 커넥터 추가**.
2. 이름: `hiworks`
3. 원격 MCP 서버 URL: `https://<내 도메인>/mcp`
4. 고급 설정 → 요청 헤더 추가: 이름 `x-api-key`, 값 = 4번에서 복사한 `MCP_AUTH_TOKEN`.
   (OAuth 로그인은 쓰지 않는다.)
5. 저장 후 새 대화에서 커넥터를 켜고 물어본다.
   > 하이웍스 동기화 상태 보여 줘.
   > 이번 주 나에게 온 요청 메일 정리해 줘.

회사(조직) 설정에서 사용자 지정 커넥터 추가가 막혀 있으면, 조직 관리자에게 허용을 요청한다.

Claude Code 에서 이 저장소를 열어 쓰는 경우에는 내 서버 주소와 토큰을 환경 변수로 넣는다. 저장소의 `.mcp.json` 이 이 값을 읽는다.

```bash
export HIWORKS_MCP_URL="https://<내 도메인>/mcp"
export HIWORKS_MCP_TOKEN="<내 MCP_AUTH_TOKEN>"
```

클라우드 세션(claude.ai/code)이면 환경 설정의 환경 변수에 같은 두 값을 넣는다.

### 7. (선택) 보낸메일 넣기
POP3 는 받은메일만 가져온다. 보낸메일까지 쓰려면 하이웍스에서 보낸편지함을 백업(.zip/.eml)으로 내려받아 서버에 올린다. 방법은 `docs/SENT_MAIL.md`.

---

## 무엇이 각자 다르고 무엇이 같은가

| 항목 | 각자 | 같음 |
|---|---|---|
| 메일 DB·서버·토큰 | 각자의 Railway | |
| 하이웍스 계정 | 각자의 계정 | |
| claude.ai 커넥터 | 각자 추가 | |
| 서버 코드·도구(검색, 요약, 업무일지, 할 일) | | 같은 저장소 |
| 기능 업데이트 | | 저장소에 반영되면 각자 서버가 자동 재배포 (템플릿 브랜치 기준) |

## 보안 원칙 (모든 팀원 공통)
- 원격 서버는 **읽기 전용**이다. 메일 삭제 도구가 없고, 메일 발송 도구도 원격 서버에는 없다.
- 비밀번호·토큰은 Railway 변수에만 둔다. 저장소·문서·채팅에 남기지 않는다.
- 서버 로그에는 메일 원문과 자격증명을 남기지 않는다.
- 하이웍스가 추가 인증(CAPTCHA, 2단계 인증)을 요구하면 우회하지 않는다. 동기화가 멈추면 웹메일에서 직접 로그인해 해제한다.
