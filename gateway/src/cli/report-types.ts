// Shapes the mc command gathers (cli/mc.ts) and prints (cli/format.ts).

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info'

export interface DoctorCheck {
  name: string
  status: CheckStatus
  detail: string
  fix?: string
}

export interface StatusReport {
  version: string
  running: boolean
  url: string
  pid?: number
  uptimeSec?: number
  dataDir: string
  logFile: string
}
