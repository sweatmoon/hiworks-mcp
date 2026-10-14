# 업무관리 에이전트 설정

에이전트는 Claude Code(또는 Claude 앱) 자체다. 원격 MCP 서버가 메일과 할 일을 보관·조회하고, Claude 가 읽고 판단해 등록·갱신·초안 작성을 한다. 서버에는 LLM 키가 필요 없다.

```
Claude Code ──(HTTP MCP)──▶ hiworks-remote  : 메일 검색/읽기, 할 일, 브리핑, 답장 맥락   (읽기 + 할 일 쓰기)
            ──(stdio MCP)─▶ hiworks         : reply_email / send_email                 (발송, 사용자 확인 후)
```

## 1. MCP 서버 연결

```bash
# 원격 (Railway 배포 후)
claude mcp add --transport http hiworks-remote https://<your-app>.up.railway.app/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"

# 로컬 발송용 (선택, 답장 발송을 쓸 때)
claude mcp add hiworks -e HIWORKS_USERNAME=... -e HIWORKS_PASSWORD=... -- npx -y hiworks-mail-mcp@latest
```

## 2. 스킬 설치

이 저장소의 `.claude/skills/work-manager/SKILL.md` 가 에이전트 지침이다. 이 저장소 안에서 Claude Code 를 열면 자동으로 쓸 수 있고, 다른 프로젝트에서도 쓰려면 개인 스킬 폴더로 복사한다.

```bash
mkdir -p ~/.claude/skills && cp -r .claude/skills/work-manager ~/.claude/skills/
```

## 3. 사용 예

| 말 | 에이전트가 하는 일 |
|---|---|
| "브리핑해 줘" | `daily_brief` → 지연/오늘/임박/새 요청/완료 요약, 새 요청은 등록 제안 |
| "이번 주 온 요청 정리해서 할 일로 등록해" | `find_actionable_emails` → `read_email` → 표로 제안 → 확인 후 `create_task` |
| "B사업 할 일 뭐 남았어" | `list_tasks({ project: "B사업" })` |
| "3번 끝났어" | `update_task({ id: 3, status: "done" })` |
| "3번 답장 초안 써 줘" | `get_reply_context({ taskId: 3 })` → 초안 → 승인 후 로컬 `reply_email` |

## 4. 아침 브리핑 자동 실행

Claude Code 의 예약 실행(루틴)에 아래 프롬프트를 평일 아침으로 등록한다. 세션이 열리면 스킬 지침대로 브리핑을 작성한다.

> work-manager 스킬로 오늘 브리핑을 작성해 줘. 새 요청 메일은 등록 제안까지만 하고, 등록·발송은 하지 마.

루틴에서는 할 일 등록이나 발송을 하지 않도록 프롬프트에 명시한다. 사람이 보고 결정한 뒤 대화에서 등록한다.

## 5. 안전장치
- 원격 서버에는 삭제·발송 도구가 없다. 할 일 테이블만 쓴다.
- 발송은 로컬 stdio 서버로만 가능하고, 스킬 지침이 사용자 승인을 요구한다. 이 승인은 Claude 가 지침을 따르는 것이지 기술적 차단이 아니므로, 더 강하게 막으려면 로컬 서버를 연결하지 않으면 된다.
- 할 일은 근거 메일 id 를 가진다. `get_task` 로 언제든 원문을 확인할 수 있다.

## 검증 상태
- 할 일 도구 7개와 브리핑·답장 맥락 로직: 실제 PostgreSQL 통합 테스트 통과.
- Claude Code 에서 스킬을 실제로 돌려 본 것은 아니다 (배포된 서버가 없음). 배포 후 첫 브리핑을 같이 돌려 보며 지침을 다듬는 것을 권한다.
