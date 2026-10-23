// Starts the doctor inside the gateway: builds what the checks may look at, then runs the engine on its timer.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type Database from 'better-sqlite3'
import { ownAddresses } from '../cli/network-exposure.js'
import { activeRunCount } from '../active-runs.js'
import { DATA_DIR, LOG_FILE, RUNNING_MARKER, SETTINGS_FILE, gatewayPort } from '../paths.js'
import type { SettingsStore } from '../store/settings.js'
import { GATEWAY_VERSION } from '../version.js'
import { CHECKS, FIXES } from './checks.js'
import { DoctorEngine } from './engine.js'
import type { DoctorContext, DoctorEvent } from './types.js'

export interface DoctorHandle {
  engine: DoctorEngine
  /** What a restart would cut short right now, in plain words; empty when it's safe to restart. */
  busy(): string[]
  setAppVersion(version: string): void
  stop(): void
}

export function startDoctor(db: Database.Database, settings: SettingsStore, emit: (event: DoctorEvent) => void): DoctorHandle {
  let uncleanSince: number | null = null
  if (existsSync(RUNNING_MARKER)) {
    const started = Number(readFileSync(RUNNING_MARKER, 'utf-8'))
    uncleanSince = Number.isFinite(started) && started > 0 ? started : Date.now()
  }
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(RUNNING_MARKER, String(Date.now()))

  const loop = monitorEventLoopDelay({ resolution: 20 })
  loop.enable()
  let appVersion: string | null = null

  const ctx: DoctorContext = {
    db,
    settings,
    dataDir: DATA_DIR,
    settingsFile: SETTINGS_FILE,
    logFile: LOG_FILE,
    gatewayVersion: GATEWAY_VERSION,
    gatewayPort: gatewayPort(),
    gatewayHost: process.env['GATEWAY_HOST'] ?? '127.0.0.1',
    appVersion: () => appVersion,
    ownAddresses,
    loopDelayMs: () => {
      const worst = loop.max / 1e6
      loop.reset()
      return worst
    },
    uncleanSince: () => uncleanSince,
    acknowledgeUncleanStart: () => { uncleanSince = null },
    now: () => Date.now(),
  }

  const engine = new DoctorEngine(ctx, CHECKS, FIXES, emit)
  engine.start()
  return {
    engine,
    busy: () => busyWork(db),
    setAppVersion: (version) => { appVersion = version.slice(0, 32) },
    stop: () => {
      engine.stop()
      loop.disable()
      rmSync(RUNNING_MARKER, { force: true })
    },
  }
}

/** What a restart would cut short: chat replies being written, pipeline runs in progress, videos being made. */
export function busyWork(db: Database.Database): string[] {
  const busy: string[] = []
  const chats = activeRunCount()
  if (chats > 0) busy.push(`${chats} chat repl${chats === 1 ? 'y is' : 'ies are'} being written`)
  const runs = db.prepare(`SELECT COUNT(*) AS n FROM pipeline_runs WHERE status = 'running'`).get() as { n: number }
  if (runs.n > 0) busy.push(`${runs.n} pipeline run${runs.n === 1 ? ' is' : 's are'} in progress`)
  const videos = db.prepare(`SELECT COUNT(*) AS n FROM videos WHERE status IN ('queued', 'running') AND deleted_at IS NULL`).get() as { n: number }
  if (videos.n > 0) busy.push(`${videos.n} video${videos.n === 1 ? ' is' : 's are'} being made`)
  return busy
}
