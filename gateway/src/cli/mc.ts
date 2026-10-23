// The mc command: start, stop, status, open, logs, doctor, version, help. The commands that
// change the computer outside Mission Control's data (shortcuts, uninstall) live in
// install-commands.ts.
//
// Security-sensitive (process control). Do not modify without Claude review.
//
// `mc stop` only ever stops a process when two independent facts agree: the gateway's
// /health reports a pid, and the pid file that gateway wrote into ~/.missioncontrol (a
// folder only this user can write) names the same pid. Something else listening on the
// port can make up a pid in /health; it cannot write our pid file.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { shortcuts, uninstall } from './install-commands.js'
import { openSignedIn } from './launch.js'
import { formatDoctor, formatStatus, helpText } from './format.js'
import type { DoctorCheck } from './report-types.js'
import { DATA_DIR, LOG_FILE, PID_FILE, RUNNING_MARKER, SETTINGS_FILE, SUPERVISOR_PID_FILE, gatewayPort, resolveUiDir } from '../paths.js'
import { liveSupervisor } from './crash-guard.js'
import { GATEWAY_VERSION } from '../version.js'
import { redact } from '../store/redact.js'
import { shellAvailability } from '../tools/shell-policy.js'
import { networkChecks, type WatchedServer } from './network-exposure.js'
import { comfyChecks } from './comfy-check.js'

const PORT = gatewayPort()
const BASE = `http://127.0.0.1:${PORT}`
// mc start runs the supervisor, which runs the gateway and restarts it after a crash (cli/supervise.ts).
const SUPERVISOR_ENTRY = join(__dirname, 'supervise.js')
const START_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 10_000
const LOG_MAX_BYTES = 5 * 1024 * 1024

interface Health { pid: number; uptime: number; version: string; supervisor?: number | null }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function health(): Promise<Health | null> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    const body = (await res.json()) as Partial<Health>
    return typeof body.pid === 'number' ? (body as Health) : null
  } catch {
    // Nothing listening, or not answering in time: not running.
    return null
  }
}

function pidFromFile(file = PID_FILE): number | null {
  try {
    const pid = (JSON.parse(readFileSync(file, 'utf-8')) as { pid?: unknown }).pid
    return typeof pid === 'number' ? pid : null
  } catch {
    // No pid file (never started, or stopped cleanly).
    return null
  }
}

function tail(file: string, lines: number): string {
  if (!existsSync(file)) return ''
  return readFileSync(file, 'utf-8').trimEnd().split('\n').slice(-lines).map(redact).join('\n')
}

function portIsFree(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(PORT, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

/** What would stop the gateway starting, in plain words, checked before it is started. Empty = good to go. */
async function startProblems(): Promise<string[]> {
  const problems: string[] = []
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < 22) problems.push(`Node.js ${process.version} is too old. Install Node.js 22 or newer from nodejs.org.`)
  if (!(await portIsFree())) {
    problems.push(`Port ${PORT} is already used by another program. Close it, or set GATEWAY_PORT to another port.`)
  }
  if (existsSync(SETTINGS_FILE)) {
    try {
      JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'))
    } catch {
      // Starting anyway would replace the unreadable file with defaults and lose the saved keys.
      problems.push(`The settings file ${redact(SETTINGS_FILE)} is damaged. Restore it from a backup, or rename it to start with fresh settings.`)
    }
  }
  return problems
}

async function start(): Promise<boolean> {
  if (await health()) {
    console.log(`Mission Control is already running at ${BASE}`)
    return true
  }
  const starting = liveSupervisor()
  if (starting !== null) {
    console.log(`Mission Control is already starting (supervisor pid ${starting}). Give it a few seconds, then check with mc status.`)
    return true
  }
  if (!resolveUiDir()) console.warn('Note: the app screens are not built, so only the developer server (npm run dev in app) can show them.')
  const problems = await startProblems()
  if (problems.length > 0) {
    console.error(`Mission Control can't start yet:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    return false
  }
  mkdirSync(dirname(LOG_FILE), { recursive: true, mode: 0o700 })
  // Keep the log from growing forever: one previous log is kept beside it.
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`)
  const log = openSync(LOG_FILE, 'a', 0o600)
  const supervisor = spawn(process.execPath, [SUPERVISOR_ENTRY], { detached: true, stdio: ['ignore', log, log], windowsHide: true })
  let exited = false
  supervisor.once('exit', () => { exited = true })
  supervisor.unref()

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline && !exited) {
    await sleep(300)
    if (await health()) {
      console.log(`Mission Control is running at ${BASE}`)
      return true
    }
  }
  console.error(`Mission Control did not start. The end of its log (${redact(LOG_FILE)}):\n${tail(LOG_FILE, 20)}`)
  return false
}

async function stop(): Promise<boolean> {
  const running = await health()
  const recorded = pidFromFile()
  if (!running) {
    if (recorded !== null) rmSync(PID_FILE, { force: true })
    console.log('Mission Control is not running.')
    return true
  }
  if (running.pid !== recorded) {
    console.error(`Something is answering at ${BASE}, but it is not a Mission Control started by this user (no matching pid file). Stop it where it was started.`)
    return false
  }
  // Stop the supervisor first so it doesn't start the gateway again. On Linux and macOS it stops the gateway itself; on
  // Windows a stop is immediate, so the gateway is stopped here too. Only a supervisor the gateway itself names, with a
  // matching pid file, is ever stopped.
  const supervisor = typeof running.supervisor === 'number' && running.supervisor === pidFromFile(SUPERVISOR_PID_FILE) ? running.supervisor : null
  try {
    if (supervisor !== null) process.kill(supervisor, 'SIGTERM')
    if (supervisor === null || process.platform === 'win32') process.kill(running.pid, 'SIGTERM')
  } catch {
    // It ended between the health check and here: the wait below confirms it is gone.
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(300)
    if (!(await health())) {
      if (supervisor !== null && pidFromFile(SUPERVISOR_PID_FILE) === supervisor) rmSync(SUPERVISOR_PID_FILE, { force: true })
      // A forced stop skips the gateway's own cleanup, which would leave a false "didn't shut down properly" notice.
      rmSync(RUNNING_MARKER, { force: true })
      // A forced stop (Windows always, POSIX if it hung) skips the gateway's own cleanup.
      if (pidFromFile() === running.pid) rmSync(PID_FILE, { force: true })
      console.log('Mission Control stopped.')
      return true
    }
  }
  console.error(`Mission Control (pid ${running.pid}) did not stop within ${STOP_TIMEOUT_MS / 1000} s.`)
  return false
}

async function status(): Promise<boolean> {
  const running = await health()
  console.log(formatStatus({
    version: running?.version ?? GATEWAY_VERSION,
    running: running !== null,
    url: BASE,
    pid: running?.pid,
    uptimeSec: running?.uptime,
    dataDir: redact(DATA_DIR),
    logFile: redact(LOG_FILE),
  }))
  return true
}

async function open(): Promise<boolean> {
  if (!(await health()) && !(await start())) return false
  await openSignedIn(BASE)
  return true
}

function logs(arg: string | undefined): boolean {
  const lines = arg === undefined ? 50 : Number(arg)
  if (!Number.isInteger(lines) || lines < 1) {
    console.error(`mc logs takes a number of lines, got "${arg}".`)
    return false
  }
  const text = tail(LOG_FILE, lines)
  console.log(text || `No log yet. The log starts when Mission Control is started with mc start (${redact(LOG_FILE)}).`)
  return true
}

interface SettingsView {
  localProviderUrl?: string
  comfyUrl?: string
  execEnabled?: boolean
  provider?: string
  activeInstanceId?: string | null
  instances?: Array<{ id: string; provider: string }>
}

// Only the fields doctor reports on. Keys in this file are encrypted and never printed.
function readSettings(): SettingsView {
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) as SettingsView
  } catch {
    // Not created yet: the gateway's defaults apply.
    return {}
  }
}

async function modelCheck(settings: SettingsView): Promise<DoctorCheck> {
  const active = settings.instances?.find((i) => i.id === settings.activeInstanceId) ?? settings.instances?.[0]
  const provider = active?.provider ?? settings.provider ?? 'local'
  if (provider !== 'local') {
    return { name: 'Model source', status: 'info', detail: `${provider} (if chat fails, check the key in Settings, Providers)` }
  }
  const url = settings.localProviderUrl ?? 'http://127.0.0.1:1234/v1'
  try {
    const res = await fetch(`${url}/models`, { signal: AbortSignal.timeout(3000) })
    // A server that requires a key answers 401. Mission Control sends the key saved in Settings (encrypted, so not checked here).
    if (res.status === 401 || res.status === 403) {
      return { name: 'Model server', status: 'info', detail: `${redact(url)} answers and requires an API key`, fix: 'If chat fails, check the key in Settings, Providers, Local provider' }
    }
    const body = (await res.json()) as { data?: unknown[] }
    const count = Array.isArray(body.data) ? body.data.length : 0
    if (res.ok && count > 0) return { name: 'Model server', status: 'ok', detail: `${redact(url)} answers, ${count} model${count === 1 ? '' : 's'}` }
    return { name: 'Model server', status: 'warn', detail: `${redact(url)} answers but lists no models`, fix: 'Load a model in LM Studio (or pull one in Ollama)' }
  } catch {
    return {
      name: 'Model server', status: 'warn', detail: `no answer from ${redact(url)}`,
      fix: 'Start LM Studio, Ollama or llama.cpp and load a model, or change the local server address in Settings',
    }
  }
}

// Mission Control itself, the model server it is set to use, and the usual local AI servers.
function watchedServers(settings: SettingsView): WatchedServer[] {
  const servers: WatchedServer[] = [
    { name: 'Mission Control', port: PORT, fix: 'Remove GATEWAY_HOST and GATEWAY_ALLOWED_HOSTS unless you meant to share it on your network' },
    { name: 'LM Studio', port: 1234, fix: "In LM Studio's Developer tab, turn off Serve on Local Network" },
    { name: 'Ollama', port: 11434, fix: 'Set OLLAMA_HOST to 127.0.0.1 (or remove it) and restart Ollama' },
    { name: 'ComfyUI', port: 8188, fix: 'Start ComfyUI without --listen' },
  ]
  const extra: Array<[string | undefined, string, string]> = [
    [settings.localProviderUrl, 'Your model server', 'Set it to listen on 127.0.0.1 only'],
    [settings.comfyUrl, 'ComfyUI', 'Start ComfyUI without --listen'],
  ]
  for (const [address, name, fix] of extra) {
    try {
      const port = Number(new URL(address ?? '').port)
      if (port && !servers.some((s) => s.port === port)) servers.push({ name, port, fix })
    } catch {
      // No address set: the defaults above cover the usual ports.
    }
  }
  return servers
}

async function doctor(): Promise<boolean> {
  const checks: DoctorCheck[] = []

  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push(nodeMajor >= 22
    ? { name: 'Node.js', status: 'ok', detail: process.version }
    : { name: 'Node.js', status: 'fail', detail: `${process.version} is too old`, fix: 'Install Node.js 22 or newer' })

  if (!existsSync(DATA_DIR)) {
    checks.push({ name: 'Data folder', status: 'info', detail: `${redact(DATA_DIR)} not created yet (made on first start)` })
  } else if (process.platform === 'win32') {
    checks.push({ name: 'Data folder', status: 'info', detail: `${redact(DATA_DIR)}, protected by your Windows user folder` })
  } else {
    const readableByOthers = (statSync(DATA_DIR).mode & 0o077) !== 0
    checks.push(readableByOthers
      ? { name: 'Data folder', status: 'warn', detail: `${redact(DATA_DIR)} can be read by other users`, fix: `chmod 700 ${redact(DATA_DIR)}` }
      : { name: 'Data folder', status: 'ok', detail: `${redact(DATA_DIR)}, private to you` })
  }

  const running = await health()
  if (running) {
    checks.push(running.pid === pidFromFile()
      ? { name: 'Gateway', status: 'ok', detail: `running at ${BASE} (version ${running.version}, pid ${running.pid})` }
      : { name: 'Gateway', status: 'warn', detail: `something answers at ${BASE}, but not with this user's pid file`, fix: 'If you did not start it, find and close it, or set GATEWAY_PORT to another port' })
  } else if (await portIsFree()) {
    checks.push({ name: 'Gateway', status: 'fail', detail: 'not running', fix: 'mc start' })
  } else {
    checks.push({ name: 'Gateway', status: 'fail', detail: `port ${PORT} is taken by another program`, fix: 'Close that program, or set GATEWAY_PORT to another port' })
  }

  checks.push(resolveUiDir()
    ? { name: 'App screens', status: 'ok', detail: 'built' }
    : { name: 'App screens', status: 'fail', detail: 'not built', fix: 'cd app && npm run build' })

  const settings = readSettings()
  checks.push(await modelCheck(settings))
  checks.push(...await comfyChecks(settings.comfyUrl))
  checks.push(...await networkChecks(watchedServers(settings)))
  const shell = shellAvailability()
  if (!shell.available) {
    checks.push({ name: 'Shell tool', status: 'ok', detail: `locked. ${shell.reason}` })
  } else {
    checks.push(settings.execEnabled
      ? { name: 'Shell tool', status: 'warn', detail: 'on, without a sandbox: commands can read anything your user account can', fix: 'Turn it off in Settings unless you need it' }
      : { name: 'Shell tool', status: 'ok', detail: 'off' })
  }

  console.log(formatDoctor(checks))
  return checks.every((c) => c.status !== 'fail')
}

async function main(): Promise<boolean> {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error(`GATEWAY_PORT must be a port number (1-65535), got "${process.env['GATEWAY_PORT']}".`)
    return false
  }
  const [command, arg] = process.argv.slice(2)
  switch (command) {
    case 'start': return start()
    case 'stop': return stop()
    case 'status': return status()
    case 'open': return open()
    case 'logs': return logs(arg)
    case 'doctor': return doctor()
    case 'shortcuts': return shortcuts()
    case 'uninstall': return uninstall(arg, stop)
    case 'version': console.log(GATEWAY_VERSION); return true
    case 'help': case undefined: console.log(helpText(GATEWAY_VERSION)); return true
    default:
      console.error(`Unknown command "${command}".\n\n${helpText(GATEWAY_VERSION)}`)
      return false
  }
}

main().then(
  (ok) => { process.exitCode = ok ? 0 : 1 },
  (err: Error) => { console.error(err.message); process.exitCode = 1 },
)
