/**
 * tools/types.ts — Tool system types
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * Every tool executor implements ToolExecutor. The correlationId field on
 * ToolResult is mandatory — it flows from the loop into tool_call_log so
 * every tool invocation is traceable back to the originating request.
 */

import type { ProviderAdapter } from '../providers/types.js'

// ---------------------------------------------------------------------------
// Tool definition (sent to the model so it knows what tools exist)
// ---------------------------------------------------------------------------

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema object
}

// ---------------------------------------------------------------------------
// Tool result (returned to the loop after execution)
// ---------------------------------------------------------------------------

export type ToolStatus = 'ok' | 'error'

export interface ToolResult {
  correlationId: string  // must match the correlationId from the originating loop turn
  toolName: string
  status: ToolStatus
  output: string         // JSON-serialisable string — sent back to the model as the tool result
  error?: string         // present when status is 'error' — already redacted before logging
  durationMs: number
}

// ---------------------------------------------------------------------------
// Tool executor — the interface every tool file exports
// ---------------------------------------------------------------------------

export interface ToolContext {
  correlationId: string
  agentId: string
  sessionId?: string
  /**
   * Set by the pipeline runner / worker-loop when a tool is invoked inside a
   * pipeline step. Used by `artifact_write` to auto-stamp the pipeline_run_id /
   * step_id on artifacts so the audit trail back to the originating run is
   * preserved without workers having to pass these explicitly.
   */
  pipelineRunId?: string
  stepId?: string
  /**
   * The provider + model the *calling agent* is currently running on. Populated
   * by Dave's loop and the worker-loop so that tools which spawn further agents
   * (subagent_spawn, pipeline_run) inherit the caller's lineage instead of using
   * a stale boot-time closure. Without this, switching model in the UI only
   * changes Dave — orchestrator + workers stay frozen on whatever was active at
   * gateway start.
   */
  provider?: ProviderAdapter
  model?: string
  /**
   * Absolute epoch-ms wall-clock deadline for the pipeline run this tool is
   * executing under, if any. Spawn-style tools (subagent_spawn) propagate it to
   * sub-workers so the whole run honours the pipeline's budget.timeoutSeconds.
   * Undefined for non-pipeline (e.g. Dave chat) tool calls.
   */
  deadline?: number
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  context: ToolContext
) => Promise<ToolResult>

// ---------------------------------------------------------------------------
// Tool registry entry — maps a tool name to its schema + executor
// ---------------------------------------------------------------------------

export interface RegisteredTool {
  schema: ToolSchema
  execute: ToolExecutor
  requiresExplicitEnable?: boolean // true for exec — off by default
}
