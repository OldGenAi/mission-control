// What the supervisor (cli/supervise.ts) does when the gateway exits: restart it after a crash, at most 3 times in 30
// minutes, then give up and leave the error in the log (no restart loops). Exit code 75 is the Health page's Restart
// button: restarted at once and not counted as a crash. A clean exit (code 0, e.g. mc stop) is left stopped.

import { RESTART_EXIT_CODE } from '../paths.js'

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
