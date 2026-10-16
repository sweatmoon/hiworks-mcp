export type DashTask = {
  id: number
  title: string
  dueDate: string | null
  daysLeft: number | null
  priority: string
  status: string
  requester: string | null
  projectName: string | null
}

export type DashMail = {
  id: number
  subject: string
  sender: string
  date: string
  reasons: string[]
}

export type DashSync = {
  status: string
  lastSuccessAt: string | null
  error: string | null
  remaining: number | null
  emails: number
}

export type Dashboard = {
  updatedAt: string | null
  isLoading: boolean
  error: string | null
  sync: DashSync | null
  counts: { overdue: number; dueToday: number; dueSoon: number; doing: number; waiting: number; todo: number; newActionable: number } | null
  overdue: DashTask[]
  dueToday: DashTask[]
  dueSoon: DashTask[]
  doing: DashTask[]
  actionable: DashMail[]
}

declare module 'claude-code' {
  interface PluginState {
    'hiworks-dashboard': { dashboard: Dashboard }
  }
}
