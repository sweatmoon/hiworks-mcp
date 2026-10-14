# 보낸메일 수집 — 검증 결과와 운영 절차

## 요약
| 경로 | 상태 | 비고 |
|---|---|---|
| 편지함 백업 파일 가져오기 (EML ZIP / EML / mbox) | **구현·검증 완료** (합성 데이터) | `/import` HTTP 업로드, `import_emails` MCP 도구, `npm run import` CLI |
| 숨은참조(BCC) 자기 사본 자동 분류 | **구현·검증 완료** (목 POP3) | 발신자가 본인 계정이면 `direction=sent` 로 저장 |
| 하이웍스 공식 API 보낸메일 조회 | **미확인** | 문서 원문에 접근 불가(개발 환경 네트워크 차단). 메일 발송·내 정보 API 는 존재, 메일함 조회 API 유무는 미확인 |
| Playwright 웹메일 수집 | **미검증 골격** | 셀렉터를 환경변수로 주입. 실제 화면에서 `npm run webmail:probe` 로 맞춘 뒤 사용 |

실제 하이웍스 백업 파일로는 테스트하지 못했다. 백업 파일 형식이 EML ZIP 이 아니면(예: 독자 형식) `extractMessages()` 에 변환을 추가해야 한다.

## 1. 편지함 백업 가져오기 (권장 경로)

하이웍스 웹메일 **메일 > 환경설정 > 편지함 백업** 에서 보낸메일함을 선택해 백업을 신청한다. 공식 안내 기준:
- 당일 송수신 메일은 제외된다.
- 생성까지 최대 3일, 생성 후 1주일간 다운로드 가능, 4GB 단위 분할, 동시 5건.

다운로드한 파일을 올린다.

```bash
# HTTP 업로드 (Railway 에 배포된 서버, 최대 512MB)
curl -X POST "https://<your-app>.up.railway.app/import?direction=sent&filename=sent-2025.zip" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @sent-2025.zip

# 또는 서버 컨테이너/로컬에서 CLI
DATABASE_URL=... npm run import -- ./sent-2025.zip sent
```

응답 예: `{"newCount":1234,"skippedCount":0,"files":1234,"failed":0,"errors":[]}`

중복은 Message-ID(없으면 발신자·수신자·제목·일시·본문 지문)로 걸러지므로 같은 파일을 여러 번 올려도 안전하다.

## 2. 이후 발신 메일을 자동으로 모으기 (BCC 규칙)

웹메일에서 메일을 보낼 때 **자기 자신을 숨은참조에 넣으면** 그 사본이 받은편지함(POP3)으로 들어오고, Worker 가 발신자 = 본인 계정임을 보고 `direction=sent` 로 저장한다. 백업 파일로 과거분을 채우고, BCC 규칙으로 이후분을 채우면 보낸메일이 끊기지 않는다. 하이웍스 웹메일에 "보낸 메일 자동 BCC" 설정이 있는지는 확인하지 못했다. 없다면 발송 시 수동으로 BCC 를 넣는다.

## 3. Playwright 웹메일 수집 (미검증)

`SENT_SYNC_MODE=webmail` 로 Worker 를 띄우면 `src/sync/sent/webmail.ts` 가 로그인 → 보낸메일함 → 각 메일의 "원본" 응답(EML)을 받아 가져오기 경로로 저장한다. 모든 셀렉터는 `WEBMAIL_*` 환경변수다.

절차:
1. 로컬에서 `HIWORKS_USERNAME/PASSWORD` 를 넣고 `npm run webmail:probe` 실행 → `webmail-probe/` 에 로그인 화면 스크린샷·HTML·입력 요소 목록이 저장된다.
2. 로그인 폼 셀렉터 3개(`WEBMAIL_USERNAME_SELECTOR`, `WEBMAIL_PASSWORD_SELECTOR`, `WEBMAIL_SUBMIT_SELECTOR`)를 채우고 다시 프로브 → 로그인 후 화면과 보낸메일함 화면 덤프.
3. `WEBMAIL_LOGGED_IN_SELECTOR`, `WEBMAIL_SENT_FOLDER_URL`, `WEBMAIL_MAIL_LINK_SELECTOR`, `WEBMAIL_ORIGINAL_LINK_SELECTOR`(원본 보기/EML 다운로드) 를 채운다.
4. Worker 를 `Dockerfile.worker`(Chromium 포함)로 빌드하고 `SENT_SYNC_MODE=webmail`.

제약:
- CAPTCHA, 2단계 인증, 추가 인증이 나오면 수집을 중단하고 `email_sync_state.error_message` 에 기록한다. 우회하지 않는다.
- 하이웍스 약관상 자동화 접근이 허용되는지 확인이 필요하다.
- 화면 구조가 바뀌면 셀렉터를 다시 잡아야 한다.

## 4. 공식 API 확인 방법
developers.hiworks.com 에서 애플리케이션을 등록하면 메일 API 문서(Postman)를 볼 수 있다. 보낸메일함 목록/본문 조회 엔드포인트가 있다면 `src/sync/sent/` 에 `api.ts` 수집원을 추가하고 `runner.ts` 의 source 목록에 넣으면 된다. 저장은 `importMessages()` 또는 `prepareEmail()/insertEmail()` 을 그대로 쓴다.
