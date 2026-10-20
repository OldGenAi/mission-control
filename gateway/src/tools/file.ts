/**
 * tools/file.ts — file_read, file_write, file_edit
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * Workspace boundary: all paths are resolved to absolute and checked against
 * the workspace root before any operation. Any path that escapes the workspace
 * (via ../ traversal, symlinks, or absolute paths outside the root) is
 * rejected with an error — the filesystem is never touched.
 *
 * Protected paths: inside the workspace, credential files (.env, keys, databases) and
 * .git / .ssh style folders are refused as well. See PROTECTED_* below.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workspacePath } from '../store/redact.js'
import type { RegisteredTool, ToolContext, ToolResult } from './types.js'

// ---------------------------------------------------------------------------
// Workspace boundary enforcement
// ---------------------------------------------------------------------------

// Files and folders the file tools never touch, even inside the workspace. They hold credentials
// (gateway/.env with provider keys, SSH and cloud keys, databases) or can run code when something
// else opens them (.git hooks). Without this, an agent steered by a poisoned web page could read
// gateway/.env and send the keys out through web_fetch.
const PROTECTED_DIRS = new Set(['.git', '.ssh', '.gnupg', '.aws', '.missioncontrol'])
const PROTECTED_FILE = /^(\.env(\..+)?|\.npmrc|\.netrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.+\.(pem|key|p12|pfx|sqlite|sqlite-shm|sqlite-wal|db))$/i
const PROTECTED_ALLOW = new Set(['.env.example', '.env.sample', '.env.template'])

function protectedReason(realWorkspace: string, target: string): string | null {
  const parts = path.relative(realWorkspace, target).split(path.sep).filter(Boolean)
  for (const part of parts) {
    if (PROTECTED_DIRS.has(part.toLowerCase())) {
      return `access to "${part}" is blocked: it can hold credentials or run code`
    }
  }
  const name = parts[parts.length - 1]?.toLowerCase()
  if (name && !PROTECTED_ALLOW.has(name) && PROTECTED_FILE.test(name)) {
    return `access to "${name}" is blocked: it can hold credentials`
  }
  return null
}

function resolveAndCheck(filePath: string): { safe: true; absolute: string } | { safe: false; reason: string } {
  if (!filePath || typeof filePath !== 'string') {
    return { safe: false, reason: 'path must be a non-empty string' }
  }

  const expanded = filePath.startsWith('~/')
    ? path.join(os.homedir(), filePath.slice(2))
    : filePath === '~' ? os.homedir() : filePath

  const workspace = workspacePath()
  // Resolve symlinks in the workspace root itself
  const realWorkspace = (() => { try { return fs.realpathSync(workspace) } catch { return workspace } })()
  const workspaceNorm = realWorkspace.endsWith(path.sep) ? realWorkspace : realWorkspace + path.sep

  const absolute = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workspace, expanded)

  // First pass — fast boundary check before any filesystem access. A path built from the
  // workspace as configured may reach it through a symlink (on macOS /var is a link to
  // /private/var, so a workspace under the temp folder differs from its real path), so accept
  // either spelling here. The second pass below is the real check: it resolves symlinks and
  // compares against the real workspace only.
  const givenNorm = path.resolve(workspace) + path.sep
  const normalised = absolute.endsWith(path.sep) ? absolute : absolute + path.sep
  const underGiven = normalised.startsWith(givenNorm)
  if (!underGiven && !normalised.startsWith(workspaceNorm)) {
    return {
      safe: false,
      reason: `workspace boundary violation: path resolves outside ${realWorkspace}`,
    }
  }

  // Resolve symlinks — prevents boundary bypass via symlinks inside the workspace
  let resolved: string
  try {
    resolved = fs.realpathSync(absolute)
  } catch {
    // Path doesn't exist yet (write op) — resolve the parent and reconstruct
    try {
      resolved = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute))
    } catch {
      resolved = absolute
    }
  }

  // Second pass — re-check boundary after symlink resolution
  const resolvedNorm = resolved.endsWith(path.sep) ? resolved : resolved + path.sep
  if (!resolvedNorm.startsWith(workspaceNorm)) {
    return {
      safe: false,
      reason: `workspace boundary violation: path resolves outside ${realWorkspace}`,
    }
  }

  // Protected files — checked on both the path as given and the symlink-resolved path, so a
  // harmless-looking link to .env is refused too.
  const blocked = protectedReason(underGiven ? path.resolve(workspace) : realWorkspace, absolute)
    ?? protectedReason(realWorkspace, resolved)
  if (blocked) return { safe: false, reason: blocked }

  return { safe: true, absolute: resolved }
}

function makeResult(
  correlationId: string,
  toolName: string,
  start: number,
  output: string,
  error?: string
): ToolResult {
  return {
    correlationId,
    toolName,
    status: error ? 'error' : 'ok',
    output,
    error,
    durationMs: Date.now() - start,
  }
}

// ---------------------------------------------------------------------------
// file_read
// ---------------------------------------------------------------------------

export const fileRead: RegisteredTool = {
  schema: {
    name: 'file_read',
    description: 'Read the contents of a file inside the Mission Control workspace.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file, relative to the workspace root or absolute.',
        },
      },
    },
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const start = Date.now()
    const check = resolveAndCheck(args['path'] as string)

    if (!check.safe) {
      return makeResult(context.correlationId, 'file_read', start, '', check.reason)
    }

    try {
      const content = fs.readFileSync(check.absolute, 'utf-8')
      // Cap what reaches the model — same reason as web_fetch: the agent loop
      // re-sends history every call, so a large (or repeated) read compounds into
      // a context blow-up. Truncate and tell the agent to read a section instead.
      const MODEL_MAX_CHARS = 24_000   // ~6k tokens
      const body = content.length > MODEL_MAX_CHARS
        ? content.slice(0, MODEL_MAX_CHARS) + `\n\n[truncated — file is ${content.length} chars; read a specific section if you need more]`
        : content
      return makeResult(context.correlationId, 'file_read', start, body)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // A missing path should point the agent at discovery, not invite another
      // blind guess — this is half of what caused the file_read runaway.
      const hint = msg.includes('ENOENT')
        ? `${msg} — use file_list to see what files exist instead of guessing paths`
        : msg
      return makeResult(context.correlationId, 'file_read', start, '', hint)
    }
  },
}

// ---------------------------------------------------------------------------
// file_write
// ---------------------------------------------------------------------------

export const fileWrite: RegisteredTool = {
  schema: {
    name: 'file_write',
    description: 'Write content to a file inside the Mission Control workspace. Creates the file and any missing parent directories.',
    parameters: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file, relative to the workspace root or absolute.',
        },
        content: {
          type: 'string',
          description: 'Full content to write to the file.',
        },
      },
    },
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const start = Date.now()
    const check = resolveAndCheck(args['path'] as string)

    if (!check.safe) {
      return makeResult(context.correlationId, 'file_write', start, '', check.reason)
    }

    const content = args['content']
    if (typeof content !== 'string') {
      return makeResult(context.correlationId, 'file_write', start, '', 'content must be a string')
    }

    try {
      fs.mkdirSync(path.dirname(check.absolute), { recursive: true })
      fs.writeFileSync(check.absolute, content, 'utf-8')
      return makeResult(
        context.correlationId,
        'file_write',
        start,
        JSON.stringify({ written: true, path: check.absolute, bytes: Buffer.byteLength(content) })
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return makeResult(context.correlationId, 'file_write', start, '', msg)
    }
  },
}

// ---------------------------------------------------------------------------
// file_edit — replace an exact string with a new string
// ---------------------------------------------------------------------------

export const fileEdit: RegisteredTool = {
  schema: {
    name: 'file_edit',
    description: 'Replace an exact occurrence of old_string with new_string in a file inside the workspace. The old_string must match exactly — including whitespace and indentation.',
    parameters: {
      type: 'object',
      required: ['path', 'old_string', 'new_string'],
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file, relative to the workspace root or absolute.',
        },
        old_string: {
          type: 'string',
          description: 'Exact string to find and replace.',
        },
        new_string: {
          type: 'string',
          description: 'Replacement string.',
        },
      },
    },
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const start = Date.now()
    const check = resolveAndCheck(args['path'] as string)

    if (!check.safe) {
      return makeResult(context.correlationId, 'file_edit', start, '', check.reason)
    }

    const oldString = args['old_string']
    const newString = args['new_string']

    if (typeof oldString !== 'string' || typeof newString !== 'string') {
      return makeResult(context.correlationId, 'file_edit', start, '', 'old_string and new_string must be strings')
    }

    try {
      const original = fs.readFileSync(check.absolute, 'utf-8')

      const occurrences = original.split(oldString).length - 1
      if (occurrences === 0) {
        return makeResult(context.correlationId, 'file_edit', start, '', `old_string not found in file — no changes made`)
      }
      if (occurrences > 1) {
        return makeResult(
          context.correlationId,
          'file_edit',
          start,
          '',
          `old_string matches ${occurrences} times — must be unique. Provide more surrounding context to make it unambiguous.`
        )
      }

      const updated = original.replace(oldString, newString)
      fs.writeFileSync(check.absolute, updated, 'utf-8')
      return makeResult(
        context.correlationId,
        'file_edit',
        start,
        JSON.stringify({ edited: true, path: check.absolute })
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return makeResult(context.correlationId, 'file_edit', start, '', msg)
    }
  },
}

// ---------------------------------------------------------------------------
// file_list — discover what exists (so the agent doesn't blind-guess paths)
// ---------------------------------------------------------------------------

export const fileList: RegisteredTool = {
  schema: {
    name: 'file_list',
    description: 'List the files and directories inside the Mission Control workspace. Use this to discover what exists before reading or editing a file — do not guess paths.',
    parameters: {
      type: 'object',
      required: [],
      properties: {
        path: {
          type: 'string',
          description: 'Directory to list, relative to the workspace root or absolute. Defaults to the workspace root.',
        },
        recursive: {
          type: 'boolean',
          description: 'If true, walk subdirectories (skips node_modules/.git/dist/build/etc, capped at 500 entries). Defaults to false — one level only.',
        },
      },
    },
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const start = Date.now()
    const rawPath = typeof args['path'] === 'string' && (args['path'] as string).trim()
      ? (args['path'] as string)
      : '.'
    const recursive = args['recursive'] === true

    const check = resolveAndCheck(rawPath)
    if (!check.safe) {
      return makeResult(context.correlationId, 'file_list', start, '', check.reason)
    }

    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache'])
    const MAX_ENTRIES = 500
    const workspace = workspacePath()
    const rel = (abs: string) => path.relative(workspace, abs) || '.'

    try {
      if (!fs.statSync(check.absolute).isDirectory()) {
        return makeResult(context.correlationId, 'file_list', start, '', `not a directory: "${rawPath}" — use file_read to read a file`)
      }

      const entries: Array<{ path: string; type: 'file' | 'dir'; size?: number }> = []
      let truncated = false

      const walk = (dir: string): void => {
        if (truncated) return
        let dirents: fs.Dirent[]
        try {
          dirents = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return  // unreadable directory — skip
        }
        dirents.sort((a, b) => a.name.localeCompare(b.name))
        for (const d of dirents) {
          if (entries.length >= MAX_ENTRIES) { truncated = true; return }
          const abs = path.join(dir, d.name)
          if (d.isDirectory()) {
            entries.push({ path: rel(abs), type: 'dir' })
            if (recursive && !IGNORE.has(d.name)) walk(abs)
          } else if (d.isFile()) {
            let size: number | undefined
            try { size = fs.statSync(abs).size } catch { /* ignore */ }
            entries.push({ path: rel(abs), type: 'file', ...(size !== undefined ? { size } : {}) })
          }
        }
      }

      walk(check.absolute)

      return makeResult(
        context.correlationId,
        'file_list',
        start,
        JSON.stringify({ path: rel(check.absolute), recursive, count: entries.length, truncated, entries })
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return makeResult(context.correlationId, 'file_list', start, '', msg)
    }
  },
}
