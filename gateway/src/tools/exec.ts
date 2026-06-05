/**
 * tools/exec.ts — exec tool (shell command execution)
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * OFF BY DEFAULT. requiresExplicitEnable = true means this tool is never
 * added to the model's toolset unless the session config explicitly enables
 * it. The loop checks this flag before including any tool.
 *
 * When enabled, commands run inside the workspace directory with a hard
 * timeout. stdin is closed. Output is capped at 64 KB.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { workspacePath } from '../store/redact.js'
import type { RegisteredTool, ToolContext, ToolResult } from './types.js'

const execFileAsync = promisify(execFile)

const MAX_OUTPUT_BYTES = 64 * 1024   // 64 KB
const TIMEOUT_MS       = 30_000      // 30 seconds hard limit

function makeResult(
  correlationId: string,
  start: number,
  output: string,
  error?: string
): ToolResult {
  return {
    correlationId,
    toolName: 'exec',
    status: error ? 'error' : 'ok',
    output,
    error,
    durationMs: Date.now() - start,
  }
}

export const execTool: RegisteredTool = {
  requiresExplicitEnable: true,

  schema: {
    name: 'exec',
    description: 'Run a shell command inside the workspace directory. This tool must be explicitly enabled per session. Commands have a 30-second timeout. Do not use for long-running processes.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to run. Runs via /bin/sh -c inside the workspace directory.',
        },
      },
    },
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const start = Date.now()
    const command = args['command']

    if (typeof command !== 'string' || !command.trim()) {
      return makeResult(context.correlationId, start, '', 'command must be a non-empty string')
    }

    const workspace = workspacePath()

    try {
      const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
        cwd: workspace,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        // No env passthrough of sensitive vars
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: process.env['HOME'] ?? '',
          TERM: 'dumb',
        },
      })

      const combined = [stdout, stderr].filter(Boolean).join('\n').slice(0, MAX_OUTPUT_BYTES)
      return makeResult(
        context.correlationId,
        start,
        JSON.stringify({ output: combined, truncated: combined.length >= MAX_OUTPUT_BYTES })
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Don't log the full command — it may contain sensitive values
      return makeResult(context.correlationId, start, '', `exec failed: ${msg}`)
    }
  },
}
