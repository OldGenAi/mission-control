// The mc command: start, stop, status, open, logs, doctor, version, help.
//
// Security-sensitive (process control). Do not modify without Claude review.
//
// `mc stop` only ever stops a process when two independent facts agree: the gateway's
// /health reports a pid, and the pid file that gateway wrote into ~/.missioncontrol (a
// folder only this user can write) names the same pid. Something else listening on the
// port can make up a pid in /health; it cannot write our pid file.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { planShortcut, type ShortcutInput } from '../install/desktop-shortcut.js'
import { openSignedIn } from './launch.js'
import { formatDoctor, formatStatus, helpText } from './format.js'
import type { DoctorCheck } from './report-types.js'
import { DATA_DIR, LOG_FILE, PID_FILE, SETTINGS_FILE, gatewayPort, resolveUiDir } from '../paths.js'
import { GATEWAY_VERSION } from '../version.js'
import { redact } from '../store/redact.js'

const PORT = gatewayPort()
const BASE = `http://127.0.0.1:${PORT}`
const GATEWAY_ENTRY = join(__dirname, '..', 'index.js')
const START_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 10_000
const LOG_MAX_BYTES = 5 * 1024 * 1024

interface Health { pid: number; uptime: number; version: string }

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

function pidFromFile(): number | null {
  try {
    const pid = (JSON.parse(readFileSync(PID_FILE, 'utf-8')) as { pid?: unknown }).pid
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

async function start(): Promise<boolean> {
  if (await health()) {
    console.log(`Mission Control is already running at ${BASE}`)
    return true
  }
  mkdirSync(dirname(LOG_FILE), { recursive: true, mode: 0o700 })
  // Keep the log from growing forever: one previous log is kept beside it.
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`)
  const log = openSync(LOG_FILE, 'a', 0o600)
  const gateway = spawn(process.execPath, [GATEWAY_ENTRY], { detached: true, stdio: ['ignore', log, log], windowsHide: true })
  let exited = false
  gateway.once('exit', () => { exited = true })
  gateway.unref()

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
  process.kill(running.pid, 'SIGTERM')
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(300)
    if (!(await health())) {
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
  checks.push(settings.execEnabled
    ? { name: 'Shell tool', status: 'warn', detail: 'on: commands can read anything your user account can', fix: 'Turn it off in Settings unless you need it' }
    : { name: 'Shell tool', status: 'ok', detail: 'off' })

  console.log(formatDoctor(checks))
  return checks.every((c) => c.status !== 'fail')
}

function desktopDir(): string {
  if (process.platform === 'win32') {
    // OneDrive and company policies can move the Desktop; ask Windows where it is.
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf-8' }).trim()
  }
  if (process.platform === 'linux') {
    try {
      const localised = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf-8' }).trim()
      if (localised) return localised
    } catch {
      // No xdg-user-dir (not a freedesktop system): fall back to ~/Desktop.
    }
  }
  return join(homedir(), 'Desktop')
}

// An existing app bundle of ours is replaced; anything else with the same name is left alone.
function clearOldMacApp(app: string, bundleId: string): boolean {
  if (!existsSync(app)) return true
  if (!readFileSync(join(app, 'Contents', 'Info.plist'), 'utf-8').includes(bundleId)) {
    console.error(`${redact(app)} exists and is not one of ours, so it was left alone. Move it, then run: mc shortcuts`)
    return false
  }
  rmSync(app, { recursive: true, force: true })
  return true
}

// Adds (or puts back) the Mission Control and Stop Mission Control desktop icons. Works from
// an installed package, where bin/ and icons/ sit next to gateway/.
function shortcuts(): boolean {
  const platform = process.platform
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
    console.error(`Desktop icons are not supported on ${platform}.`)
    return false
  }
  const root = resolve(__dirname, '..', '..', '..')
  const launcher = (kind: string) => join(root, 'bin', platform === 'win32' ? `mc-${kind}.cmd` : `mc-${kind}`)
  if (!existsSync(launcher('open'))) {
    console.error('mc shortcuts works in an installed Mission Control (it needs bin/mc-open next to the gateway).')
    return false
  }
  const iconExt = { win32: '.ico', darwin: '.icns', linux: '.png' }[platform]
  const desktop = desktopDir()

  for (const [kind, icon, bundleId] of [
    ['open', 'mission-control', 'local.oldgenai.mission-control'],
    ['stop', 'stop-mission-control', 'local.oldgenai.stop-mission-control'],
  ] as const) {
    const input: ShortcutInput = { kind, platform, home: homedir(), desktopDir: desktop, appDir: root, launcher: launcher(kind), icon: join(root, 'icons', icon + iconExt) }
    const plan = planShortcut(input)
    if (platform === 'darwin' && !clearOldMacApp(plan.created[0]!, bundleId)) return false
    for (const file of plan.files) {
      // A computer without a desktop folder (a server) still gets the app-menu entry.
      if (dirname(file.path) === desktop && !existsSync(desktop)) continue
      mkdirSync(dirname(file.path), { recursive: true })
      writeFileSync(file.path, file.content)
      if (file.mode !== undefined) chmodSync(file.path, file.mode)
    }
    for (const step of plan.commands) {
      // No shell: every argument reaches the program exactly as planned.
      const result = spawnSync(step.cmd, step.args, { stdio: 'ignore', windowsHide: true })
      if (result.status !== 0 && !step.optional) {
        console.error(`Could not create the ${basename(plan.created[0]!)} icon (${step.cmd} failed).`)
        return false
      }
    }
    console.log(`Added ${plan.created.map((p) => redact(p)).join(' and ')}`)
  }
  return true
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
