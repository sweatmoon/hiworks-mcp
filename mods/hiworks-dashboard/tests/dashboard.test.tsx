import { test, expect } from 'claude-code/testing'

const brief = {
  success: true,
  date: '2026-10-15',
  generatedAt: '2026-10-15T09:00:00+09:00',
  counts: { overdue: 1, dueToday: 1, dueSoon: 0, doing: 1, waiting: 0, todo: 2, newActionable: 2 },
  overdue: [{ id: 7, title: '계약서 검토 의견 회신', dueDate: '2026-10-10', daysLeft: -5, priority: 'high', status: 'todo', requester: '"박아영" <a@b.com>', projectName: 'B사업' }],
  dueToday: [{ id: 8, title: '착수계 서명 회신', dueDate: '2026-10-15', daysLeft: 0, priority: 'normal', status: 'todo', requester: null, projectName: null }],
  dueSoon: [],
  doing: [{ id: 9, title: '제안서 작성', dueDate: null, daysLeft: null, priority: 'normal', status: 'doing', requester: null, projectName: null }],
  waiting: [],
  newActionableEmails: [
    { id: 637, subject: '하이웍스 비번 초기화 부탁드립니다.', sender: '"신미정" <m@activo.kr>', date: '2026-10-14T20:52:38+09:00', reasons: ['제목에 요청 표현'] },
    { id: 628, subject: '[전달] 상근인력별 감리경력 사업명 수정본', sender: '"고현정" <h@activo.kr>', date: '2026-10-15T10:15:33+09:00', reasons: ['본문에 요청 표현'] },
  ],
  recentlyCompleted: [],
  sync: [],
}
const syncStatus = {
  success: true,
  sources: [{ source: 'pop3', status: 'ok', lastSuccessAt: '2026-10-15T08:55:00+09:00', errorMessage: null, stats: { remaining: 120 } }],
  emailCounts: [{ direction: 'received', count: 700 }, { direction: 'sent', count: 70 }],
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false })

const PANE = { plugin: 'hiworks-dashboard', surface: 'terminal' as const, component: 'Pane' as const, requestId: 'hiworks-dashboard', props: { title: '하이웍스 업무', isFocused: false, bodyColumns: 100, dock: 'dock' as const } }

test('pane shows sync, task sections and request mails after refresh', async ($, on) => {
  on('mcp.call', ($, e) => {
    expect(e.server).toBe('hiworks-remote')
    if (e.tool === 'daily_brief') return { value: text(brief) }
    if (e.tool === 'get_sync_status') return { value: text(syncStatus) }
    throw new Error(`unexpected tool ${e.tool}`)
  })
  const run = await $.command.run({ command: 'hiworks-refresh' })
  expect(run.text).toMatch(/갱신 완료 \(09:00\)/)

  const ui = await $.ui.mount({ ...PANE })
  expect(await ui.find({ type: 'Text', text: /동기화 정상 · 메일 770통 · 남음 120/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /지연 1건/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#7 계약서 검토 의견 회신 \(10\/10, 5일 지남\) · 박아영/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /오늘 마감 1건/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /진행 중 1건/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /새 요청 메일 2건/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#637 하이웍스 비번 초기화 부탁드립니다\. · 신미정 10\/14/ })).toBeDefined()
  await ui.unmount()
})

test('pane reports a failing server instead of crashing', async ($, on) => {
  on('mcp.call', () => ({ value: { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'unauthorized' }) }], isError: true } }))
  const run = await $.command.run({ command: 'hiworks-refresh' })
  expect(run.text).toMatch(/갱신 실패: unauthorized/)
  const ui = await $.ui.mount({ ...PANE })
  expect(await ui.find({ type: 'Text', text: /오류: unauthorized/ })).toBeDefined()
  await ui.unmount()
})
