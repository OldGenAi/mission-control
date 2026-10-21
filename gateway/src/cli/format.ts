// Text for `mc status`, `mc doctor` and `mc help`. Pure: cli/mc.ts gathers the facts.

import type { StatusReport, DoctorCheck } from './report-types.js'

export function formatUptime(seconds: number): string {
  const total = Math.floor(seconds)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function formatStatus(report: StatusReport): string {
  const state = !report.running
    ? 'not running (start it with: mc start)'
    : report.pid !== undefined && report.uptimeSec !== undefined
      ? `running (pid ${report.pid}, up ${formatUptime(report.uptimeSec)})`
      : 'running'
  return [
    `Mission Control ${report.version}`,
    `Status:   ${state}`,
    `Address:  ${report.url}`,
    `Data:     ${report.dataDir}`,
    `Log:      ${report.logFile}`,
  ].join('\n')
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const lines: string[] = []
  for (const check of checks) {
    // FAIL in capitals so a problem stands out in a list of [ok] lines.
    const label = `[${check.status === 'fail' ? 'FAIL' : check.status}]`.padEnd(6)
    lines.push(`${label} ${check.name}: ${check.detail}`)
    if (check.fix) lines.push(`       fix: ${check.fix}`)
  }
  const problems = checks.filter((c) => c.status === 'fail').length
  const warnings = checks.filter((c) => c.status === 'warn').length
  lines.push('', problems + warnings === 0 ? 'All checks passed.' : `${plural(problems, 'problem')}, ${plural(warnings, 'warning')}.`)
  return lines.join('\n')
}

const COMMANDS: Array<[string, string]> = [
  ['mc start', 'Start Mission Control in the background'],
  ['mc stop', 'Stop it'],
  ['mc status', 'Show whether it is running, and where'],
  ['mc open', 'Open it in your browser, signed in (starts it first if needed)'],
  ['mc logs [lines]', 'Show the end of the log (default 50 lines)'],
  ['mc doctor', 'Check your setup and say what to fix'],
  ['mc version', 'Show the version'],
  ['mc help', 'Show this help'],
]

export function helpText(version: string): string {
  const width = Math.max(...COMMANDS.map(([command]) => command.length))
  return [
    `Mission Control ${version}`,
    '',
    'Usage:',
    ...COMMANDS.map(([command, description]) => `  ${command.padEnd(width)}  ${description}`),
  ].join('\n')
}
