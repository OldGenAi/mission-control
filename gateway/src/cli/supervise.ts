// The supervisor `mc start` runs: it starts the gateway, restarts it after a crash under the crash guard's rules, and
// restarts it at once when the Health page's Restart button asks (exit code 75).
//
// Security-sensitive (process control). Do not modify without Claude review.
//
// It only ever starts the one gateway file next to it, never a command from settings or the network. Its pid file lives
// in ~/.missioncontrol (only this user can write there), and the gateway reports this process as its supervisor in
// /health, so `mc stop` stops it only when both agree.

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOG_FILE, SUPERVISOR_PID_FILE } from '../paths.js'
import { CrashGuard, liveSupervisor } from './crash-guard.js'

// The gateway next to this file. The tests pass a stand-in gateway as the first argument; mc start never passes one.
const GATEWAY_ENTRY = process.argv[2] ?? join(__dirname, '..', 'index.js')
const RESTART_DELAY_MS = Number(process.env['MC_RESTART_DELAY_MS'] ?? 2000)
const STOP_TIMEOUT_MS = 10_000

const guard = new CrashGuard()
let child: ChildProcess | null = null
let stopping = false

function note(line: string): void {
  console.log(`[supervisor] ${new Date().toISOString()} ${line}`)
}

function startGateway(): void {
  const log = openSync(LOG_FILE, 'a', 0o600)
  child = spawn(process.execPath, [GATEWAY_ENTRY], {
    stdio: ['ignore', log, log],
    env: { ...process.env, MC_SUPERVISED: '1' },
    windowsHide: true,
  })
  closeSync(log)   // the gateway has its own copy
  child.once('exit', (code, signal) => {
    child = null
    if (stopping) return finish(0)
    const decision = guard.decide(signal ? 1 : code)
    if (decision === 'restart_now') {
      note('restart requested from the Health page')
      startGateway()
    } else if (decision === 'restart_after_crash') {
      note(`the gateway stopped unexpectedly (${signal ?? `code ${code}`}); restarting (${guard.recent} of 3 in 30 minutes)`)
      setTimeout(startGateway, RESTART_DELAY_MS)   // not unref'd: with the gateway gone, this timer is what keeps us running
    } else if (decision === 'give_up') {
      note('the gateway crashed 3 times in 30 minutes, so it is left stopped. Read the lines above, then run mc start again.')
      finish(1)
    } else {
      finish(0)
    }
  })
}

function finish(code: number): void {
  try {
    if ((JSON.parse(readFileSync(SUPERVISOR_PID_FILE, 'utf-8')) as { pid?: number }).pid === process.pid) rmSync(SUPERVISOR_PID_FILE)
  } catch {
    // Already gone or unreadable: nothing of ours to remove.
  }
  process.exit(code)
}

function stop(): void {
  stopping = true
  if (!child) return finish(0)
  child.kill('SIGTERM')
  setTimeout(() => { child?.kill('SIGKILL'); finish(0) }, STOP_TIMEOUT_MS).unref()
}

const other = liveSupervisor()
if (other !== null) {
  note(`another supervisor (pid ${other}) is already running Mission Control; this one stops`)
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
rmSync(SUPERVISOR_PID_FILE, { force: true })   // a stale file from a supervisor that was killed
writeFileSync(SUPERVISOR_PID_FILE, JSON.stringify({ pid: process.pid }) + '\n', { mode: 0o600, flag: 'wx' })
startGateway()
