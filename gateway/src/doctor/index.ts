// Starts the doctor inside the gateway: builds what the checks may look at, then runs the engine on its timer.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type Database from 'better-sqlite3'
import { ownAddresses } from '../cli/network-exposure.js'
import { DATA_DIR, LOG_FILE, SETTINGS_FILE, gatewayPort } from '../paths.js'
import type { SettingsStore } from '../store/settings.js'
import { GATEWAY_VERSION } from '../version.js'
import { CHECKS, FIXES } from './checks.js'
import { DoctorEngine } from './engine.js'
import type { DoctorContext, DoctorEvent } from './types.js'

// Written while the gateway runs and removed on a clean shutdown, so a leftover file means the last run ended badly.
const RUNNING_MARKER = join(DATA_DIR, 'gateway.running')

export interface DoctorHandle {
  engine: DoctorEngine
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
    setAppVersion: (version) => { appVersion = version.slice(0, 32) },
    stop: () => {
      engine.stop()
      loop.disable()
      rmSync(RUNNING_MARKER, { force: true })
    },
  }
}
