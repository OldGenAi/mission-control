/**
 * pipeline/approval.ts — approval_gate resume tokens
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * Resume tokens are HMAC-SHA256 signed so a forged or tampered token is
 * rejected before any state change. Tokens carry an expiry — expired tokens
 * are rejected even if the signature is valid.
 *
 * The signing key is derived from APPROVAL_SECRET env var. If the env var
 * is absent the gateway refuses to start (enforced at module load time).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ResumeTokenPayload } from './types.js'
import { getConfig } from '../auth.js'

// ---------------------------------------------------------------------------
// Key — fail fast at startup if secret is missing
// ---------------------------------------------------------------------------

// Prefer an explicit env secret (backward-compat); otherwise use the auto-generated,
// persisted secret from config.json so a fresh install needs no manual APPROVAL_SECRET.
const secret = process.env['APPROVAL_SECRET'] ?? getConfig().approvalSecret
if (!secret || secret.length < 32) {
  throw new Error(
    '[approval] No valid approval secret available (need ≥ 32 chars). ' +
    'Set APPROVAL_SECRET, or ensure ~/.missioncontrol/config.json is writable so one can be generated.'
  )
}

const DEFAULT_EXPIRY_SECONDS = 86_400  // 24 h

// ---------------------------------------------------------------------------
// Token issue
// ---------------------------------------------------------------------------

export function issueResumeToken(
  runId: string,
  stepId: string,
  decision: 'approve' | 'reject',
  expiresInSeconds = DEFAULT_EXPIRY_SECONDS
): string {
  const now = Date.now()
  const payload: ResumeTokenPayload = {
    runId,
    stepId,
    decision,
    issuedAt:  now,
    expiresAt: now + expiresInSeconds * 1000,
  }
  const data = JSON.stringify(payload)
  const sig  = sign(data)
  return Buffer.from(`${data}.${sig}`).toString('base64url')
}

// ---------------------------------------------------------------------------
// Token verify
// ---------------------------------------------------------------------------

export function verifyResumeToken(token: string): ResumeTokenPayload {
  let raw: string
  try {
    raw = Buffer.from(token, 'base64url').toString('utf-8')
  } catch {
    throw new Error('resume token: invalid base64url encoding')
  }

  const lastDot = raw.lastIndexOf('.')
  if (lastDot === -1) throw new Error('resume token: malformed — missing signature')

  const data = raw.slice(0, lastDot)
  const sig  = raw.slice(lastDot + 1)

  // Timing-safe signature comparison
  const expected = sign(data)
  const sigBuf  = Buffer.from(sig,      'utf-8')
  const expBuf  = Buffer.from(expected, 'utf-8')

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('resume token: invalid signature')
  }

  let payload: ResumeTokenPayload
  try {
    payload = JSON.parse(data) as ResumeTokenPayload
  } catch {
    throw new Error('resume token: payload is not valid JSON')
  }

  if (Date.now() > payload.expiresAt) {
    throw new Error(`resume token: expired at ${new Date(payload.expiresAt).toISOString()}`)
  }

  return payload
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function sign(data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex')
}
