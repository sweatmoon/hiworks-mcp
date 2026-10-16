import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface, McpToolResult } from 'claude-code'

import type { Dashboard, DashMail, DashTask } from '../types'

const PANE = 'hiworks-dashboard'
const SERVER = 'hiworks-remote'
const REFRESH_MS = 5 * 60 * 1000

const EMPTY: Dashboard = {
  updatedAt: null,
  isLoading: false,
  error: null,
  sync: null,
  counts: null,
  overdue: [],
  dueToday: [],
  dueSoon: [],
  doing: [],
  actionable: [],
}

const dashboard = atom({ plugin: 'hiworks-dashboard', key: 'dashboard' } as const, EMPTY)

type AnyRecord = Record<string, unknown>

/** MCP 결과의 첫 text 블록을 JSON 으로 해석한다. */
function parseResult(result: McpToolResult): AnyRecord {
  const block = result.content.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined
  if (!block) throw new Error('도구 응답에 텍스트가 없습니다')
  const parsed = JSON.parse(block.text) as AnyRecord
  if (result.isError || parsed['success'] === false) {
    throw new Error(String(parsed['error'] ?? '도구 호출 실패'))
  }
  return parsed
}

function toTask(raw: unknown): DashTask {
  const t = raw as AnyRecord
  return {
    id: Number(t['id']),
    title: String(t['title'] ?? ''),
    dueDate: (t['dueDate'] as string | null) ?? null,
    daysLeft: typeof t['daysLeft'] === 'number' ? (t['daysLeft'] as number) : null,
    priority: String(t['priority'] ?? 'normal'),
    status: String(t['status'] ?? 'todo'),
    requester: (t['requester'] as string | null) ?? null,
    projectName: (t['projectName'] as string | null) ?? null,
  }
}

function toMail(raw: unknown): DashMail {
  const m = raw as AnyRecord
  return {
    id: Number(m['id']),
    subject: String(m['subject'] ?? '(제목 없음)'),
    sender: String(m['sender'] ?? '').replace(/<[^>]*>/g, '').replace(/"/g, '').trim(),
    date: String(m['date'] ?? ''),
    reasons: Array.isArray(m['reasons']) ? (m['reasons'] as string[]) : [],
  }
}

function hhmm(iso: string | null): string {
  if (!iso) return '--:--'
  const m = /T(\d{2}:\d{2})/.exec(iso)
  return m ? m[1]! : iso
}

function mmdd(iso: string | null): string {
  if (!iso) return ''
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[1]}/${m[2]}` : iso
}

/** 서버에서 브리핑 원자료와 동기화 상태를 받아 패널 상태를 갱신한다. */
async function refresh($: EngineInterface): Promise<void> {
  await update($, dashboard, d => ({ ...d, isLoading: true }))
  try {
    const [briefRes, syncRes] = await Promise.all([
      $.mcp.call(SERVER, 'daily_brief', { lookbackDays: 2 }),
      $.mcp.call(SERVER, 'get_sync_status', { runs: 1 }),
    ])
    const brief = parseResult(briefRes)
    const sync = parseResult(syncRes)
    const source = ((sync['sources'] as AnyRecord[] | undefined) ?? [])[0]
    const emailCounts = (sync['emailCounts'] as AnyRecord[] | undefined) ?? []
    const counts = brief['counts'] as Dashboard['counts']
    const stats = (source?.['stats'] as AnyRecord | undefined) ?? {}
    await update($, dashboard, () => ({
      updatedAt: String(brief['generatedAt'] ?? ''),
      isLoading: false,
      error: null,
      sync: source
        ? {
            status: String(source['status'] ?? 'unknown'),
            lastSuccessAt: (source['lastSuccessAt'] as string | null) ?? null,
            error: (source['errorMessage'] as string | null) ?? null,
            remaining: typeof stats['remaining'] === 'number' ? (stats['remaining'] as number) : null,
            emails: emailCounts.reduce((n, c) => n + Number(c['count'] ?? 0), 0),
          }
        : null,
      counts,
      overdue: ((brief['overdue'] as unknown[]) ?? []).map(toTask),
      dueToday: ((brief['dueToday'] as unknown[]) ?? []).map(toTask),
      dueSoon: ((brief['dueSoon'] as unknown[]) ?? []).map(toTask),
      doing: ((brief['doing'] as unknown[]) ?? []).map(toTask),
      actionable: ((brief['newActionableEmails'] as unknown[]) ?? []).map(toMail),
    }))
    const c = counts
    if (c) $.ui.status(`메일 지연${c.overdue} 오늘${c.dueToday} 요청${c.newActionable}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, dashboard, d => ({ ...d, isLoading: false, error: message }))
    $.ui.status('메일 대시보드 오류')
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hiworks', description: '하이웍스 메일 업무 대시보드 패널을 연다' })
    await $.command.register({ name: 'hiworks-refresh', description: '대시보드를 지금 갱신한다' })
    void $.ui.open({ id: PANE, title: '하이웍스 업무' })
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'hiworks' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: '하이웍스 업무' })
    void refresh($)
    return { text: opened.isPlaced ? '대시보드 패널을 열었습니다.' : `패널을 아직 그릴 수 없습니다: ${opened.reason}` }
  })

  on('command.run', { command: 'hiworks-refresh' }, async $ => {
    await refresh($)
    const d = await read($, dashboard)
    return { text: d.error ? `갱신 실패: ${d.error}` : `갱신 완료 (${hhmm(d.updatedAt)})` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const d = await read($, dashboard)
    const rows = e.viewport?.rows ?? 24
    const room = Math.max(4, rows - 8)

    const syncLine = d.sync
      ? d.sync.status === 'error'
        ? `동기화 오류: ${(d.sync.error ?? '').slice(0, 40)}`
        : `동기화 ${d.sync.status === 'running' ? '진행 중' : '정상'} · 메일 ${d.sync.emails}통${d.sync.remaining ? ` · 남음 ${d.sync.remaining}` : ''} · 성공 ${hhmm(d.sync.lastSuccessAt)}`
      : '동기화 상태 없음'

    const taskLine = (t: DashTask, mark: string) => (
      <Text key={`t${t.id}`} wrap="truncate-end">
        {mark} #{t.id} {t.title}
        {t.dueDate ? ` (${mmdd(t.dueDate)}${t.daysLeft !== null && t.daysLeft < 0 ? `, ${-t.daysLeft}일 지남` : ''})` : ''}
        {t.requester ? ` · ${t.requester.replace(/<[^>]*>/g, '').replace(/"/g, '').trim()}` : ''}
      </Text>
    )

    const sections: Array<{ title: string; items: DashTask[]; mark: string; color?: string }> = [
      { title: '지연', items: d.overdue, mark: '!', color: 'red' },
      { title: '오늘 마감', items: d.dueToday, mark: '●', color: 'yellow' },
      { title: '임박 (3일)', items: d.dueSoon, mark: '○' },
      { title: '진행 중', items: d.doing, mark: '▶' },
    ]
    let used = 0
    const blocks: JSX.Element[] = []
    for (const s of sections) {
      if (s.items.length === 0 || used >= room) continue
      const take = s.items.slice(0, Math.max(1, Math.min(s.items.length, room - used)))
      used += take.length + 1
      blocks.push(
        <Box key={s.title} flexDirection="column">
          <Text bold color={s.color}>{s.title} {s.items.length}건</Text>
          {take.map(t => taskLine(t, s.mark))}
        </Box>,
      )
    }
    const mailRoom = Math.max(0, room - used)
    const mails = d.actionable.slice(0, mailRoom)

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>하이웍스 업무 {d.isLoading ? '(갱신 중…)' : d.updatedAt ? `· ${hhmm(d.updatedAt)} 갱신` : ''}</Text>
        {d.error && <Text color="red">오류: {d.error.slice(0, 60)}</Text>}
        <Text dimColor={d.sync?.status !== 'error'} color={d.sync?.status === 'error' ? 'red' : undefined}>{syncLine}</Text>
        {d.counts && (
          <Text>
            할 일 {d.counts.todo + d.counts.doing + d.counts.waiting}건 · 지연 {d.counts.overdue} · 오늘 {d.counts.dueToday} · 임박 {d.counts.dueSoon} · 새 요청 메일 {d.counts.newActionable}
          </Text>
        )}
        {blocks}
        {mails.length > 0 && (
          <Box flexDirection="column">
            <Text bold color="cyan">새 요청 메일 {d.actionable.length}건</Text>
            {mails.map(m => (
              <Text key={`m${m.id}`} wrap="truncate-end">
                ✉ #{m.id} {m.subject} · {m.sender} {mmdd(m.date)}
              </Text>
            ))}
          </Box>
        )}
        {!d.counts && !d.error && !d.isLoading && <Text dimColor>/hiworks-refresh 로 갱신하세요.</Text>}
        <Text dimColor>/hiworks-refresh 갱신 · 5분마다 자동 · 등록은 "N번 등록해"</Text>
      </Box>
    )
  })
}
