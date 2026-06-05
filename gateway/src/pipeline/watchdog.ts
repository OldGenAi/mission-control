import type Database from 'better-sqlite3'
import type { MonitorBuffer } from '../store/monitor-buffer.js'

interface StuckRow { id: string; name: string; updated_at: number }

// Live snapshot of what the watchdog is doing, surfaced to the Monitor's right rail
// so the operator can SEE it is alive and watching — not just notice it when it acts.
export interface WatchdogStats {
  running: boolean
  lastRunAt: number | null     // when the last sweep ran
  nextRunAt: number | null     // when the next sweep is due
  intervalMs: number           // sweep cadence
  lifetimeFailed: number       // stuck runs auto-failed since boot
  lifetimeExpired: number      // expired approval gates aborted since boot
  lastActionAt: number | null  // last time it actually had to step in
}

export interface WatchdogHandle {
  stop: () => void
  getStats: () => WatchdogStats
}

export function startWatchdog(
  db: Database.Database,
  monitorBuffer: MonitorBuffer,
  intervalMs = 120_000
): WatchdogHandle {
  const stuckStmt = db.prepare<[number], StuckRow>(
    `SELECT id, name, updated_at FROM pipeline_runs WHERE status = 'running' AND updated_at < ?`
  )
  const failStuckStmt = db.prepare(
    `UPDATE pipeline_runs SET status='failed', error='watchdog: stuck run auto-failed after 15 minutes',
     updated_at=?, revision=revision+1 WHERE id=? AND status='running'`
  )
  const expiredStmt = db.prepare<[number], StuckRow>(
    `SELECT id, name, updated_at FROM pipeline_runs WHERE status = 'paused' AND updated_at < ?`
  )
  const abortExpiredStmt = db.prepare(
    `UPDATE pipeline_runs SET status='aborted', error='watchdog: approval gate expired',
     updated_at=?, revision=revision+1 WHERE id=? AND status='paused'`
  )

  const stats: WatchdogStats = {
    running: true,
    lastRunAt: null,
    nextRunAt: Date.now() + intervalMs,
    intervalMs,
    lifetimeFailed: 0,
    lifetimeExpired: 0,
    lastActionAt: null,
  }

  function tick(): void {
    try {
      const now = Date.now()
      stats.lastRunAt = now
      stats.nextRunAt = now + intervalMs

      for (const row of stuckStmt.all(now - 15 * 60 * 1000)) {
        failStuckStmt.run(now, row.id)
        stats.lifetimeFailed++
        stats.lastActionAt = now
        console.warn('[watchdog] auto-failed stuck run', row.id, row.name)
        monitorBuffer.enqueue({
          kind: 'error', correlationId: row.id, agentId: 'watchdog', sessionId: undefined,
          code: 'WATCHDOG_STUCK_RUN', message: `auto-failed stuck run ${row.id} (${row.name})`,
        })
      }

      for (const row of expiredStmt.all(now - 48 * 60 * 60 * 1000)) {
        abortExpiredStmt.run(now, row.id)
        stats.lifetimeExpired++
        stats.lastActionAt = now
        console.warn('[watchdog] aborted expired paused run', row.id, row.name)
        monitorBuffer.enqueue({
          kind: 'error', correlationId: row.id, agentId: 'watchdog', sessionId: undefined,
          code: 'WATCHDOG_EXPIRED_GATE', message: `aborted expired approval gate on run ${row.id} (${row.name})`,
        })
      }
    } catch (e) {
      console.error('[watchdog] tick error:', e)
    }
  }

  // Run one sweep immediately so the Monitor shows a live heartbeat from boot
  // (and any runs orphaned by a crash/restart get cleaned up right away).
  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref()

  return {
    stop: () => { clearInterval(timer); stats.running = false },
    getStats: () => ({ ...stats }),
  }
}
