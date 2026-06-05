/**
 * store/monitor-buffer.ts — Async monitoring write buffer
 *
 * All tool_call_log, model_call_log, and error_log writes go through here.
 * Events are queued in memory and flushed to SQLite in a batch every second
 * on a background timer. The caller never waits for the write — the agent
 * loop is never blocked by observability overhead. On shutdown, stop() flushes
 * whatever is still queued.
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface ToolCallEvent {
  kind: 'tool_call'
  correlationId: string
  agentId: string
  sessionId?: string
  toolName: string
  inputHash: string    // SHA-256 of input — computed by caller before enqueue
  outputHash?: string  // SHA-256 of output; absent on error
  status: 'ok' | 'error'
  error?: string       // already redacted by caller
  durationMs: number
}

export interface ModelCallEvent {
  kind: 'model_call'
  correlationId: string
  agentId: string
  sessionId?: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  durationMs: number
}

export interface ErrorEvent {
  kind: 'error'
  correlationId?: string
  agentId?: string
  sessionId?: string
  code: string
  message: string  // already redacted by caller
  stack?: string   // already redacted by caller
}

export type MonitorEvent = ToolCallEvent | ModelCallEvent | ErrorEvent

// ---------------------------------------------------------------------------
// MonitorBuffer
// ---------------------------------------------------------------------------

export class MonitorBuffer {
  private queue: MonitorEvent[] = []
  private timer: NodeJS.Timeout | null = null
  private readonly db: Database.Database
  private readonly flushIntervalMs: number

  private readonly insertToolCall: Database.Statement
  private readonly insertModelCall: Database.Statement
  private readonly insertError: Database.Statement

  constructor(db: Database.Database, flushIntervalMs = 1000) {
    this.db = db
    this.flushIntervalMs = flushIntervalMs

    this.insertToolCall = db.prepare(`
      INSERT INTO tool_call_log
        (id, correlation_id, agent_id, session_id, tool_name,
         input_hash, output_hash, status, error, duration_ms, created_at)
      VALUES
        (@id, @correlationId, @agentId, @sessionId, @toolName,
         @inputHash, @outputHash, @status, @error, @durationMs, @createdAt)
    `)

    this.insertModelCall = db.prepare(`
      INSERT INTO model_call_log
        (id, correlation_id, agent_id, session_id, provider, model,
         input_tokens, output_tokens, cost_usd, duration_ms, created_at)
      VALUES
        (@id, @correlationId, @agentId, @sessionId, @provider, @model,
         @inputTokens, @outputTokens, @costUsd, @durationMs, @createdAt)
    `)

    this.insertError = db.prepare(`
      INSERT INTO error_log
        (id, correlation_id, agent_id, session_id, code, message, stack, created_at)
      VALUES
        (@id, @correlationId, @agentId, @sessionId, @code, @message, @stack, @createdAt)
    `)
  }

  // ---------------------------------------------------------------------------
  // Enqueue — non-blocking, always returns immediately
  // ---------------------------------------------------------------------------

  enqueue(event: MonitorEvent): void {
    this.queue.push(event)
    this.ensureTimerRunning()
  }

  // ---------------------------------------------------------------------------
  // Stop — clear the timer and flush whatever's still queued
  // ---------------------------------------------------------------------------

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // Flush anything remaining before shutdown
    this.flush()
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private ensureTimerRunning(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs)
    // Don't keep the process alive just for the buffer
    this.timer.unref()
  }

  private flush(): void {
    if (this.queue.length === 0) return

    const batch = this.queue.splice(0, this.queue.length)
    const now = Date.now()

    try {
      this.db.transaction(() => {
        for (const event of batch) {
          if (event.kind === 'tool_call') this.writeToolCall(event, now)
          else if (event.kind === 'model_call') this.writeModelCall(event, now)
          else if (event.kind === 'error') this.writeError(event, now)
        }
      })()
    } catch (err) {
      // Put events back so they can be retried next flush
      this.queue.unshift(...batch)
      console.error('[monitor-buffer] flush failed — events requeued:', err)
    }
  }

  private writeToolCall(e: ToolCallEvent, createdAt: number): void {
    this.insertToolCall.run({
      id: randomUUID(),
      correlationId: e.correlationId,
      agentId: e.agentId,
      sessionId: e.sessionId ?? null,
      toolName: e.toolName,
      inputHash: e.inputHash,
      outputHash: e.outputHash ?? null,
      status: e.status,
      error: e.error ?? null,
      durationMs: e.durationMs,
      createdAt,
    })
  }

  private writeModelCall(e: ModelCallEvent, createdAt: number): void {
    this.insertModelCall.run({
      id: randomUUID(),
      correlationId: e.correlationId,
      agentId: e.agentId,
      sessionId: e.sessionId ?? null,
      provider: e.provider,
      model: e.model,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      costUsd: e.costUsd,
      durationMs: e.durationMs,
      createdAt,
    })
  }

  private writeError(e: ErrorEvent, createdAt: number): void {
    this.insertError.run({
      id: randomUUID(),
      correlationId: e.correlationId ?? null,
      agentId: e.agentId ?? null,
      sessionId: e.sessionId ?? null,
      code: e.code,
      message: e.message,
      stack: e.stack ?? null,
      createdAt,
    })
  }
}
