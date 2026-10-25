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
// The folder Mission Control runs from: a source checkout, or the unpacked release. This file is gateway/{src,dist}/store/.
const INSTALL_ROOT = path.resolve(__dirname, '..', '..', '..')

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
 *
 * The file tools may write anywhere inside the workspace, so it must never overlap Mission Control's own install folder:
 * the README's quick start clones the code to ~/mission-control, the default workspace, and a steered model could then
 * write a pipeline into gateway/src/pipelines and run it, or change gateway code that runs on the next restart. When the
 * default would overlap, ~/mission-control-workspace is used instead.
 *
 * MC_WORKSPACE moves it. Like MC_ALLOW_UNSANDBOXED_SHELL it is read from the gateway's environment only, never from
 * settings the page or an agent can change. A value that is relative, the home folder or above it, inside ~/.missioncontrol,
 * or overlapping the install folder is refused and the default used instead.
 */
export function workspacePath(env: NodeJS.ProcessEnv = process.env, installRoot: string = INSTALL_ROOT): string {
  const overlapsInstall = (dir: string) => isInside(dir, installRoot) || isInside(installRoot, dir)
  const standard = path.join(HOME, 'mission-control')
  const fallback = overlapsInstall(standard) ? path.join(HOME, 'mission-control-workspace') : standard
  const wanted = env['MC_WORKSPACE']
  if (!wanted || !path.isAbsolute(wanted)) return fallback
  const resolved = path.resolve(wanted)
  const coversHome = isInside(HOME, resolved)
  const insideData = isInside(resolved, path.join(HOME, '.missioncontrol'))
  return coversHome || insideData || overlapsInstall(resolved) ? fallback : resolved
}

/** True when `child` is `parent` or inside it. */
function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
}
