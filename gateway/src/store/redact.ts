/**
 * store/redact.ts — Redaction filter
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * Every string that will be written to error_log or broadcast to the UI
 * must pass through redact() first. This prevents API keys, tokens,
 * passwords, and out-of-workspace file paths from leaking into logs.
 *
 * Rules are applied in order. Add new patterns here — never bypass this
 * module by writing to error_log directly.
 */

import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Redaction rules
// ---------------------------------------------------------------------------

interface RedactionRule {
  pattern: RegExp
  replacement: string
}

const HOME = os.homedir()

const RULES: RedactionRule[] = [
  // Bearer tokens (Authorization headers)
  {
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: 'Bearer [REDACTED]',
  },

  // API keys — any sk-* format (OpenAI, OpenRouter sk-or-v1-*, Anthropic sk-ant-*)
  {
    pattern: /sk-[A-Za-z0-9][A-Za-z0-9\-_]{10,}/g,
    replacement: '[API_KEY]',
  },

  // Generic hex tokens / secrets (32+ hex chars — catches the gateway token, approval
  // secret, and encryption key, plus JWT/HMAC secrets)
  {
    pattern: /\b[0-9a-f]{32,}\b/gi,
    replacement: '[TOKEN]',
  },

  // Brave Search keys (BSA…) and similar opaque provider tokens not covered above
  {
    pattern: /\bBSA[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[API_KEY]',
  },

  // JWT structure (three base64url segments separated by dots)
  {
    pattern: /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/g,
    replacement: '[JWT]',
  },

  // Anything labelled as a password, secret, or key in key=value style
  {
    pattern: /\b(password|passwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*\S+/gi,
    replacement: '$1=[REDACTED]',
  },

  // Out-of-workspace absolute paths — flag paths outside the user's home dir
  // that appear in error messages (e.g. /etc/passwd, /root/...)
  {
    pattern: /\/(?:etc|root|proc|sys|dev)\/[^\s"']*/g,
    replacement: '[SYSTEM_PATH]',
  },

  // Home directory path — replace with ~ so the username isn't logged
  {
    pattern: new RegExp(escapeRegex(HOME), 'g'),
    replacement: '~',
  },
]

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// redact() — the public API
// ---------------------------------------------------------------------------

/**
 * Scrubs sensitive data from a string before it reaches error_log or the UI.
 * Always call this on user-visible error messages and stack traces.
 */
export function redact(input: string): string {
  let result = input
  for (const rule of RULES) {
    result = result.replace(rule.pattern, rule.replacement)
  }
  return result
}

/**
 * Redacts all string values in an object — useful for redacting an entire
 * error payload before broadcasting as a GatewayEvent.
 */
export function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    out[key] = typeof value === 'string' ? redact(value) : value
  }
  return out
}

/**
 * Redacts a stack trace — applies redact() and also strips internal node
 * module paths that expose the project layout.
 */
export function redactStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined
  return redact(stack).replace(
    /\(\/[^\s)]*node_modules[^\s)]*\)/g,
    '(node_modules)'
  )
}

/**
 * Returns the absolute path of the project workspace root.
 * Used by file tools to verify workspace boundary — kept here so the
 * workspace path is defined in one place.
 */
export function workspacePath(): string {
  return path.join(HOME, 'mission-control')
}
