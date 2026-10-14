<a href="https://glama.ai/mcp/servers/@beylessai/hiworks-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@beylessai/hiworks-mcp/badge" />
</a>

# Hiworks Mail MCP

하이웍스 메일(POP3/SMTP)을 Claude, Cursor 같은 AI 도구에서 읽고·검색하고·보내고·답장할 수 있게 해주는 MCP(Model Context Protocol) 서버입니다.
"새 메일 확인 → 요약 → 답장 초안 → 첨부 저장" 같은 메일 업무를 자연어로 자동화하는 데 쓸 수 있습니다.

## 사전 준비

하이웍스 웹메일에 로그인해 **메일 > 환경설정 > 기본 설정** 에서 **POP3/SMTP 사용** 을 켜야 합니다. 켜지 않으면 인증 오류가 납니다.

## MCP 설정

Claude Desktop, Claude Code, Cursor 의 MCP 서버 설정에 아래와 같이 추가합니다.

```json
{
  "mcpServers": {
    "hiworks-mail": {
      "command": "npx",
      "args": ["-y", "hiworks-mail-mcp@latest"],
      "env": {
        "HIWORKS_USERNAME": "your.email@yourcompany.com",
        "HIWORKS_PASSWORD": "your_password"
      }
    }
  }
}
```

Claude Code 에서는 한 줄로도 추가할 수 있습니다.

```bash
claude mcp add hiworks-mail -e HIWORKS_USERNAME=your.email@yourcompany.com -e HIWORKS_PASSWORD=your_password -- npx -y hiworks-mail-mcp@latest
```

### 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `HIWORKS_USERNAME` | (필수) | 하이웍스 이메일 주소 |
| `HIWORKS_PASSWORD` | (필수) | 하이웍스 비밀번호 |
| `HIWORKS_STATE_DIR` | `~/.hiworks-mcp` | `check_new_emails` 가 확인한 메일 UID 를 기록하는 폴더 |
| `HIWORKS_DOWNLOAD_DIR` | `~/Downloads/hiworks-mcp` | `save_attachment` 기본 저장 폴더 |
| `HIWORKS_POP3_HOST` / `HIWORKS_POP3_PORT` / `HIWORKS_POP3_TLS` | `pop3s.hiworks.com` / `995` / `true` | 수신 서버 |
| `HIWORKS_SMTP_HOST` / `HIWORKS_SMTP_PORT` / `HIWORKS_SMTP_SECURE` | `smtps.hiworks.com` / `465` / `true` | 발신 서버 |
| `HIWORKS_POP3_TIMEOUT_MS` | `60000` | POP3 소켓 타임아웃 |

모든 도구는 `username`, `password` 인자를 직접 받을 수도 있지만, 환경변수로 설정해 두는 것을 권장합니다.

## 도구 목록

### 읽기

| 도구 | 설명 |
|---|---|
| `search_email` | 최신 메일부터 조건에 맞는 메일 헤더 목록을 반환. `query`, `from`, `to`, `subject`, `since`, `before`, `hasAttachments`, `limit`, `offset`, `scanLimit` |
| `read_email` | 메일 한 통의 본문·첨부 목록. `messageId` 에는 `search_email` 결과의 `uid` 를 넘기는 것이 가장 빠름 (메일 순번, Message-ID 도 가능) |
| `check_new_emails` | **지난 호출 이후 새로 온 메일만** 반환. 확인한 UID 를 로컬에 기록해 다음 호출에서 제외. 정기 실행 자동화의 핵심 |
| `list_attachments` | 첨부 파일 이름·종류·크기 목록 |
| `save_attachment` | 첨부 파일을 로컬 폴더에 저장하고 경로 반환 (`index` 나 `filename` 미지정 시 전부 저장) |
| `read_username` | 현재 계정과 서버 설정 확인 (비밀번호는 반환하지 않음) |

### 쓰기

| 도구 | 설명 |
|---|---|
| `send_email` | 새 메일 발송. `to`/`cc`/`bcc` 는 문자열(쉼표 구분) 또는 배열. 첨부는 로컬 `path` 또는 `content`(텍스트/base64) |
| `reply_email` | 받은 메일에 답장. `Re:` 제목, In-Reply-To/References 헤더, 원본 인용을 자동 처리. `replyAll` 지원 |
| `forward_email` | 메일 전달. 원본 본문과 첨부를 그대로 포함 |

### 날짜

모든 날짜는 KST(`+09:00`) ISO 8601 문자열입니다. `since`/`before` 에 `2025-01-02` 처럼 날짜만 넣으면 KST 기준 그 날의 0시 / 23:59:59 로 해석합니다.

### POP3 의 한계

하이웍스는 IMAP 을 제공하지 않아 POP3 를 사용합니다. 그래서

- 서버 쪽 검색·폴더·읽음 표시가 없습니다. `search_email` 은 최신 메일부터 `scanLimit`(기본 200)개의 헤더를 내려받아 로컬에서 거릅니다. 오래된 메일을 찾으려면 `scanLimit` 을 늘리세요.
- "읽지 않은 메일" 대신 `check_new_emails` 가 로컬 기록으로 "아직 확인하지 않은 메일" 을 관리합니다.
- 메일 순번(`msgNum`)은 메일이 삭제되면 바뀝니다. 메일을 다시 참조할 때는 `uid` 를 쓰세요.

## 업무 자동화 예시

MCP 를 연결한 뒤 Claude 에게 이렇게 말하면 됩니다.

**아침 메일 브리핑**
> 새 메일을 확인해서 보낸사람·제목·핵심 요청을 한 줄씩 정리해 줘. 회신이 필요한 메일은 따로 표시해 줘.

**특정 거래처 메일 추적**
> 이번 달 `@vendor.com` 에서 온 메일을 모두 찾아서 날짜순으로 요약해 줘.

**답장 초안 → 확인 후 발송**
> 방금 온 "회의 일정 조율" 메일에 "다음 주 화요일 오후 2시 가능합니다" 라고 정중하게 답장 초안을 써서 보여 줘. 내가 OK 하면 보내 줘.

**첨부 파일 정리**
> 첨부가 있는 최근 메일 중 제목에 "견적" 이 들어간 것의 첨부를 모두 `~/Documents/견적` 에 저장해 줘.

**정기 실행 (Claude Code 루틴 / cron)**
Claude Code 의 예약 실행이나 OS 스케줄러로 아래 프롬프트를 주기적으로 돌리면 새 메일만 골라 처리할 수 있습니다. `check_new_emails` 는 한 번 확인한 메일을 다시 돌려주지 않습니다.
> `check_new_emails` 로 새 메일을 확인하고, "[긴급]" 이 제목에 있거나 상사가 보낸 메일이 있으면 내용을 요약해서 알려 줘. 광고·뉴스레터는 무시해.

## 주의사항

- 비밀번호는 평문 환경변수로 전달됩니다. 설정 파일 권한을 관리하고 공용 PC 에서는 사용하지 마세요.
- `send_email`, `reply_email`, `forward_email` 은 실제로 메일을 발송합니다. 자동화 프롬프트에서는 "보내기 전에 내용을 보여 주고 확인받아" 와 같이 승인 단계를 두는 것을 권장합니다.
- 대량 발송 시 하이웍스 정책을 준수하세요.

## 개발

```bash
npm install
npm run build      # TypeScript → build/
npm test           # 목 POP3/SMTP 서버로 모든 도구를 검증하는 통합 테스트 (실제 계정 불필요)
NODE_ENV=development node build/index.js   # stderr 로 디버그 로그 출력
```

MCP Inspector 로 직접 호출해 볼 수도 있습니다.

```bash
HIWORKS_USERNAME=... HIWORKS_PASSWORD=... npx @modelcontextprotocol/inspector node build/index.js
```

## 라이선스

MIT. 자세한 내용은 [LICENSE](./LICENSE) 파일을 참고하세요.
