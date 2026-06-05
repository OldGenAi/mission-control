/**
 * auth.ts — Token validation and Origin checking
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * Two responsibilities:
 *   1. validateToken  — checks a bearer token against the stored gateway token
 *   2. validateOrigin — ensures WebSocket upgrade requests come from loopback only
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs'
import { randomBytes, timingSafeEqual } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'

// ---------------------------------------------------------------------------
// Config path
// ---------------------------------------------------------------------------

const CONFIG_DIR  = join(homedir(), '.missioncontrol')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

interface GatewayConfig {
  token: string
  approvalSecret: string
  encryptionKey: string   // 32 bytes (hex) — AES-256-GCM key for at-rest encryption of provider keys
  [key: string]: unknown
}

// Best-effort tighten of file/dir perms. The token + approval secret must never be
// world-readable; a local process reading them bypasses the WebSocket token wall.
// A non-POSIX filesystem may not support chmod — that's acceptable, hence the catch.
function tightenPerms(target: string, mode: number): void {
  try { chmodSync(target, mode) } catch { /* perms not enforceable on this filesystem */ }
}

function loadConfig(): GatewayConfig {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  }
  // Re-tighten on every boot (idempotent) so an install created by an older version —
  // or loosened by the user — is corrected, not just freshly-created ones.
  tightenPerms(CONFIG_DIR, 0o700)

  if (!existsSync(CONFIG_FILE)) {
    // First start — generate a token + approval secret and write them. Auto-generating
    // the approval secret means a fresh install needs no manual APPROVAL_SECRET in .env.
    const config: GatewayConfig = {
      token:          randomBytes(32).toString('hex'),
      approvalSecret: randomBytes(32).toString('hex'),
      encryptionKey:  randomBytes(32).toString('hex'),
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
    console.log('[auth] Generated new gateway token + secrets. Stored at:', CONFIG_FILE)
    return config
  }

  try {
    tightenPerms(CONFIG_FILE, 0o600)   // correct loose perms on a pre-existing token file
    const raw = readFileSync(CONFIG_FILE, 'utf-8')
    const config = JSON.parse(raw) as GatewayConfig

    if (!config.token || typeof config.token !== 'string' || config.token.length < 32) {
      throw new Error('Token missing or too short in config.json')
    }

    // Backfill secrets added after this config was first created (older installs).
    let backfilled = false
    if (!config.approvalSecret || typeof config.approvalSecret !== 'string' || config.approvalSecret.length < 32) {
      config.approvalSecret = randomBytes(32).toString('hex'); backfilled = true
    }
    if (!config.encryptionKey || typeof config.encryptionKey !== 'string' || config.encryptionKey.length < 64) {
      config.encryptionKey = randomBytes(32).toString('hex'); backfilled = true
    }
    if (backfilled) {
      writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
      console.log('[auth] Backfilled missing secret(s) in config.json.')
    }

    return config
  } catch (err) {
    console.error('[auth] Failed to load config.json:', err)
    process.exit(1)
  }
}

// Load once at module initialisation — gateway refuses to start without a valid token
const config = loadConfig()

// ---------------------------------------------------------------------------
// validateToken
// ---------------------------------------------------------------------------

/**
 * Returns true if the provided token matches the stored gateway token.
 * Uses crypto.timingSafeEqual to prevent timing attacks.
 */
export function validateToken(token: unknown): boolean {
  if (typeof token !== 'string') return false
  const a = Buffer.from(token)
  const b = Buffer.from(config.token)
  // timingSafeEqual requires equal-length buffers; length check is unavoidable
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// validateOrigin
// ---------------------------------------------------------------------------

/**
 * Returns true only if the Origin header indicates a loopback source.
 *
 * Permitted Origins:
 *   - undefined / null (no Origin header — CLI tools, curl)
 *   - http://localhost or http://localhost:<port>
 *   - http://127.0.0.1 or http://127.0.0.1:<port>
 *   - http://[::1] or http://[::1]:<port>
 *
 * Everything else is rejected.
 * This prevents cross-site WebSocket hijacking (ClawBleed-class attacks).
 */
export function validateOrigin(origin: string | undefined): boolean {
  // No Origin header — non-browser client (curl, Node.js scripts) — allow
  if (origin === undefined || origin === null || origin === '') return true

  try {
    const url = new URL(origin)
    const hostname = url.hostname

    const isLoopback =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1'

    const isHttp = url.protocol === 'http:'

    return isLoopback && isHttp
  } catch {
    // Invalid URL — reject
    return false
  }
}

// ---------------------------------------------------------------------------
// getConfig (for other modules that need config values)
// ---------------------------------------------------------------------------

export function getConfig(): Readonly<GatewayConfig> {
  return config
}
