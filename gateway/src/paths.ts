// Where Mission Control keeps things. Side-effect free, so the mc command can use it
// without loading config or opening the database.

import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

export const DATA_DIR = join(homedir(), '.missioncontrol')
export const CONFIG_FILE = join(DATA_DIR, 'config.json')
export const SETTINGS_FILE = join(DATA_DIR, 'settings.json')
export const PID_FILE = join(DATA_DIR, 'gateway.pid')
export const LOG_FILE = join(DATA_DIR, 'logs', 'gateway.log')

export function gatewayPort(): number {
  return Number(process.env['GATEWAY_PORT'] ?? 4747)
}

/** app/dist next to the gateway, or MC_UI_DIR. Null when no build exists (dev uses Vite). */
export function resolveUiDir(): string | null {
  const dir = process.env['MC_UI_DIR'] ?? resolve(__dirname, '..', '..', 'app', 'dist')
  return existsSync(join(dir, 'index.html')) ? dir : null
}
