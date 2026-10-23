// The doctor's shapes (see doctor-build-spec-2026-10-23.md). A check looks at one thing and says how it is; a fix is a
// pre-written change that can put it right. Nothing here runs shell commands.

import type Database from 'better-sqlite3'
import type { SettingsStore } from '../store/settings.js'

export type CheckStatus = 'ok' | 'info' | 'warn' | 'fail'

/** safe: reversible, inside Mission Control. approval: changes a setting, said before it happens. last_resort: resets or deletes. */
export type FixTier = 'safe' | 'approval' | 'last_resort'

export interface CheckResult {
  status: CheckStatus
  /** One plain sentence: how things are now. */
  summary: string
  /** Why it matters, shown under "Learn more". */
  why?: string
  /** What the person can do when the doctor can't fix it. */
  steps?: string[]
  /** A button that opens a page in the app. */
  open?: { label: string; page: string }
  /** The id of a fix that applies to this result. */
  fix?: string
}

export interface Check {
  id: string
  area: 'Gateway' | 'Install' | 'Models' | 'Pipelines' | 'Errors' | 'Security' | 'Storage' | 'Video'
  title: string
  /** Shown on the first failed check instead of after two in a row. */
  immediate?: boolean
  /** Run only every n-th sweep (slow checks). Default 1. */
  everySweeps?: number
  run(ctx: DoctorContext): Promise<CheckResult>
}

export interface Fix {
  id: string
  tier: FixTier
  /** The button text. */
  label: string
  /** Exactly what will change, shown before an approval fix is applied. */
  change: string
  /** Left out of "Fix all safe issues" (a notice the person should read and dismiss themselves). */
  oneByOne?: boolean
  /** Applies the fix and returns a short note of what was done. Throws if it could not. */
  apply(ctx: DoctorContext): Promise<string>
}

/** What checks and fixes may look at. Built once at start (doctor/index.ts); tests pass their own. */
export interface DoctorContext {
  db: Database.Database
  settings: SettingsStore
  dataDir: string
  settingsFile: string
  logFile: string
  gatewayVersion: string
  gatewayPort: number
  gatewayHost: string
  /** The version the app reported on its last status request, or null before the first one. */
  appVersion(): string | null
  /** This computer's own addresses other than loopback. */
  ownAddresses(): string[]
  /** The worst event-loop delay since the last call, in milliseconds. */
  loopDelayMs(): number
  /** When the previous run started, if it ended without a clean shutdown; null otherwise. */
  uncleanSince(): number | null
  acknowledgeUncleanStart(): void
  now(): number
}

export type DoctorEventKind = 'checked' | 'issue' | 'cleared' | 'fixing' | 'fixed' | 'fix_failed' | 'ignored' | 'unignored'

export interface DoctorEvent {
  at: number
  checkId: string
  title: string
  kind: DoctorEventKind
  note: string
}
