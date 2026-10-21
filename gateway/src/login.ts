/**
 * login.ts — one-time launch codes and browser sessions
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * Opens the UI already signed in without the gateway token ever reaching the browser:
 *   1. The launcher asks POST /auth/challenge for a nonce, then proves it holds the
 *      gateway token with an HMAC over that nonce (launch-proof.ts) at POST /auth/launch,
 *      and receives a one-time code. The token itself never goes over the wire.
 *   2. It opens http://127.0.0.1:4747/#login=<code>. A URL fragment is never sent to the
 *      server, never logged and never put in a Referer header.
 *   3. The page swaps the code at POST /auth/redeem for a signed session and keeps it in
 *      localStorage. localStorage is scoped to scheme+host+port; a cookie is not (cookies
 *      ignore the port), so any other local web server would receive a session cookie.
 *   4. The WebSocket `connect` sends the session instead of the token.
 *
 * Sessions are stateless: v1.<expiresAtSec>.<random>.<hmac>, signed with the
 * sessionSecret in config.json. Rotating that secret signs every browser out.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { getConfig } from './auth.js'
import { launchProof } from './launch-proof.js'

const ONE_TIME_TTL_MS = 60_000
const MAX_OPEN        = 16
const SESSION_TTL_SEC = 30 * 24 * 60 * 60

/** Random single-use values that expire after a minute; only the newest 16 stay open. */
class OneTimeValues {
  // value -> expiry (ms). Insertion order is age order, so the oldest comes first.
  private open = new Map<string, number>()

  issue(now: number): string {
    for (const [value, expires] of this.open) {
      if (expires <= now) this.open.delete(value)
    }
    for (const oldest of this.open.keys()) {
      if (this.open.size < MAX_OPEN) break
      this.open.delete(oldest)
    }
    const value = randomBytes(32).toString('hex')
    this.open.set(value, now + ONE_TIME_TTL_MS)
    return value
  }

  /** True once per issued value, and only before it expires. */
  consume(value: unknown, now: number): boolean {
    if (typeof value !== 'string') return false
    const expires = this.open.get(value)
    if (expires === undefined) return false
    this.open.delete(value)
    return expires > now
  }
}

const challenges  = new OneTimeValues()
const launchCodes = new OneTimeValues()

function hexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

export function issueLaunchChallenge(now = Date.now()): string {
  return challenges.issue(now)
}

/** A one-time code for a launcher that answered a fresh challenge; null otherwise. */
export function issueLaunchCode(nonce: unknown, proof: unknown, now = Date.now()): string | null {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return null
  // Consume first: a wrong proof still burns the nonce, so each one allows one guess.
  if (!challenges.consume(nonce, now)) return null
  if (!hexEqual(proof, launchProof(getConfig().token, nonce as string))) return null
  return launchCodes.issue(now)
}

export function redeemLaunchCode(code: unknown, now = Date.now()): boolean {
  return launchCodes.consume(code, now)
}

function signSessionBody(body: string): string {
  return createHmac('sha256', Buffer.from(getConfig().sessionSecret, 'hex')).update(body).digest('hex')
}

/** A signed browser session that expires in 30 days. */
export function issueSession(now = Date.now()): { session: string; expiresAt: number } {
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SEC
  const body = `v1.${expiresAt}.${randomBytes(16).toString('hex')}`
  return { session: `${body}.${signSessionBody(body)}`, expiresAt }
}

/** True if the session was signed by this gateway and has not expired. */
export function validateSession(session: unknown, now = Date.now()): boolean {
  if (typeof session !== 'string') return false
  const match = /^v1\.(\d{1,12})\.([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(session)
  if (!match) return false
  const [, expires, id, mac] = match
  if (!hexEqual(mac, signSessionBody(`v1.${expires}.${id}`))) return false
  return Number(expires) * 1000 > now
}
