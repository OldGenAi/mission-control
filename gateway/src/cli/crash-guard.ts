// What the supervisor (cli/supervise.ts) does when the gateway exits: restart it after a crash, at most 3 times in 30
// minutes, then give up and leave the error in the log (no restart loops). Exit code 75 is the Health page's Restart
// button: restarted at once and not counted as a crash. A clean exit (code 0, e.g. mc stop) is left stopped.

import { readFileSync } from 'node:fs'
import { RESTART_EXIT_CODE, SUPERVISOR_PID_FILE } from '../paths.js'

export type ExitDecision = 'restart_now' | 'restart_after_crash' | 'stay_stopped' | 'give_up'

export class CrashGuard {
  private crashes: number[] = []

  constructor(private readonly limit = 3, private readonly windowMs = 30 * 60_000) {}

  decide(code: number | null, now = Date.now()): ExitDecision {
    if (code === RESTART_EXIT_CODE) return 'restart_now'
    if (code === 0) return 'stay_stopped'
    this.crashes = this.crashes.filter((t) => now - t < this.windowMs)
    if (this.crashes.length >= this.limit) return 'give_up'
    this.crashes.push(now)
    return 'restart_after_crash'
  }

  /** Crashes counted in the current window (for the log line). */
  get recent(): number {
    return this.crashes.length
  }
}

/** The pid of a supervisor that is still running, from its pid file, or null. */
export function liveSupervisor(): number | null {
  let pid: unknown
  try {
    pid = (JSON.parse(readFileSync(SUPERVISOR_PID_FILE, 'utf-8')) as { pid?: unknown }).pid
  } catch {
    return null  // no file: none running
  }
  if (typeof pid !== 'number' || pid === process.pid) return null
  try {
    process.kill(pid, 0)  // signal 0 only asks whether the process exists
    return pid
  } catch {
    return null  // stale file from a supervisor that was killed
  }
}
