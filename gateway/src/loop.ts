import { randomUUID, createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { loadSystemPrompt } from './memory/loader.js'
import type { ProviderAdapter, Message, StreamChunk, ToolCall, ToolDefinition } from './providers/types.js'
import { computeCost, contextPercent } from './providers/pricing.js'
import { AgentRegistry } from './agents/registry.js'
import type { AgentStatus } from './types.js'
import type { MonitorBuffer } from './store/monitor-buffer.js'
import { redact } from './store/redact.js'
import type { RegisteredTool } from './tools/types.js'
import { toolOverrides } from './store/tool-overrides.js'
import { ConsecutiveFailureTracker } from './failure-tracker.js'

interface MessageStats {
  inputTokens: number
  outputTokens: number
  durationMs: number
}

export interface AgentLoopConfig {
  agentId: string
  provider: ProviderAdapter
  model: string
  registry: AgentRegistry
  db: Database.Database
  monitorBuffer: MonitorBuffer
  tools: Map<string, RegisteredTool>  // available tools for this agent, keyed by name
  execEnabled?: boolean               // whether exec tool is on for this session
  // Callback to push a GatewayEvent to one specific client.
  broadcast: (clientId: string, event: string, payload: Record<string, unknown>) => void
  maxIterations?: number
  /** Per-turn wall-clock budget in seconds; the loop stops a turn that runs past
   *  it, as a backstop behind the iteration cap and the consecutive-failure stop. */
  timeoutSeconds?: number
}

export interface RunParams {
  message: string
  sessionId: string
  clientId: string
  correlationId?: string
  /** Per-request model override — falls back to AgentLoopConfig.model. */
  model?: string
  /** Per-request reasoning hint forwarded to providers that support it. */
  reasoning?: { effort: 'low' | 'medium' | 'high' }
  /**
   * True when the loop was invoked by the proactive pipeline-completion notifier,
   * not by a user chat.send. Surfaces on the chat.final event so the UI marks
   * the message; persisted to messages.auto_notify for historical loads.
   */
  autoNotify?: boolean
  /** User-initiated cancellation. Threaded into provider.complete so an in-flight
   *  model request is cancelled the moment the user hits Stop; the loop then ends
   *  the turn cleanly (keeps partial text, logs no error). */
  abortSignal?: AbortSignal
}

export class AgentLoop {
  constructor(private config: AgentLoopConfig) {}

  async run(params: RunParams): Promise<void> {
    const correlationId = params.correlationId ?? randomUUID()
    const { clientId, sessionId, message } = params
    const activeModel = params.model ?? this.config.model

    try {
      // Step 2 — agent.status: thinking
      this.broadcast(clientId, 'agent.status', {
        agentId: this.config.agentId,
        sessionId,
        status: 'thinking' as AgentStatus,
        correlationId,
      })

      // Step 3 — load session history from SQLite
      const history: Message[] = this.loadHistory(sessionId)

      // Persist the user's message immediately, before any provider call, so a
      // mid-turn failure (e.g. a 429) can't make their message vanish on the next
      // history load. Skipped for autoNotify runs — that "user" message is a
      // server-injected [SYSTEM EVENT], not something the user typed.
      if (!params.autoNotify) {
        this.persistMessages(sessionId, [{ role: 'user', content: message }], [null], false)
      }

      // Step 4 — load frozen identity snapshot for this session
      const systemPrompt = loadSystemPrompt(this.config.db, this.config.agentId)

      const messages: Message[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message },
      ]

      // Step 5 — build tool definitions from the tools map
      // Three filters: exec gate → registry capability → UI override
      const enabledOverride = toolOverrides.get(this.config.agentId)
      const toolDefs: ToolDefinition[] = []
      for (const [name, tool] of this.config.tools) {
        if (tool.requiresExplicitEnable && !this.config.execEnabled) continue
        if (!this.config.registry.hasCapability(this.config.agentId, name)) continue
        if (enabledOverride !== undefined && !enabledOverride.has(name)) continue
        toolDefs.push(tool.schema)
      }
      const tools = toolDefs.length > 0 ? toolDefs : undefined

      let iterations = 0
      const maxIterations = this.config.maxIterations ?? 10
      // Containment guards (chat loop) — bound a runaway regardless of model
      // behaviour: a per-turn wall-clock deadline, a hard stop after N consecutive
      // tool failures (the failing-loop case, e.g. blind file_read guessing), and
      // the iteration cap.
      const timeoutSeconds = this.config.timeoutSeconds ?? 600
      const deadline = Date.now() + timeoutSeconds * 1000
      const failureTracker = new ConsecutiveFailureTracker()
      let stopReason: 'normal' | 'timeout' | 'failures' | 'aborted' = 'normal'
      // Per-assistant-message stats, keyed by index in `messages`. Persisted with the row.
      const assistantStats = new Map<number, MessageStats>()

      while (iterations < maxIterations) {
        // User pressed Stop between iterations — bail before another model round.
        if (params.abortSignal?.aborted) {
          stopReason = 'aborted'
          break
        }
        // Wall-clock deadline guard — stop before starting another model round
        // if the turn has run past its budget.
        if (Date.now() >= deadline) {
          stopReason = 'timeout'
          break
        }
        iterations++

        // Call provider
        const callStartMs = Date.now()
        let inputTokens = 0
        let outputTokens = 0
        let modelDurationMs = 0
        const stream = this.config.provider.complete({
          model: activeModel,
          messages,
          tools,
          correlationId,
          ...(params.reasoning ? { reasoning: params.reasoning } : {}),
          ...(params.abortSignal ? { signal: params.abortSignal } : {}),
        }) as AsyncIterable<StreamChunk>

        let responseText = ''
        let providerError: string | undefined
        const pendingToolCalls: ToolCall[] = []

        // Stream handling
        for await (const chunk of stream) {
          if (chunk.type === 'text_delta') {
            responseText += chunk.delta
            this.broadcast(clientId, 'chat.delta', { delta: chunk.delta, correlationId })
          }
          if (chunk.type === 'tool_call') {
            pendingToolCalls.push(chunk.toolCall)
          }
          if (chunk.type === 'done') {
            inputTokens = chunk.usage.inputTokens
            outputTokens = chunk.usage.outputTokens
            modelDurationMs = Date.now() - callStartMs
            providerError = chunk.error
            this.config.monitorBuffer.enqueue({
              kind: 'model_call',
              correlationId,
              agentId: this.config.agentId,
              sessionId,
              provider: this.config.provider.name,
              model: activeModel,
              inputTokens,
              outputTokens,
              costUsd: computeCost(activeModel, inputTokens, outputTokens),
              durationMs: modelDurationMs,
            })
          }
        }

        // User hit Stop mid-stream — the provider cancelled the in-flight request
        // (request.signal). End the turn cleanly: keep whatever text already
        // streamed, log no error (it's intentional, not a failure).
        if (params.abortSignal?.aborted) {
          if (responseText) {
            messages.push({ role: 'assistant', content: responseText })
            assistantStats.set(messages.length - 1, { inputTokens, outputTokens, durationMs: modelDurationMs })
          }
          stopReason = 'aborted'
          break
        }

        // Provider surfaced an upstream error (e.g. a 429) as a graceful done.
        // Record it in error_log so Monitor stops showing "ERRORS 0" during real
        // failures, tell the user plainly, and stop — don't fall through to the
        // empty "no tool calls, finish" path that would look like a blank reply.
        if (providerError) {
          this.config.monitorBuffer.enqueue({
            kind: 'error',
            correlationId,
            agentId: this.config.agentId,
            sessionId,
            code: 'PROVIDER_ERROR',
            message: redact(providerError),
          })
          this.broadcast(clientId, 'agent.status', {
            agentId: this.config.agentId,
            sessionId,
            status: 'error' as AgentStatus,
            detail: providerError,
            correlationId,
          })
          this.broadcast(clientId, 'chat.final', {
            text: `[The model provider returned an error and the turn was stopped: ${providerError}]`,
            sessionId,
            correlationId,
            error: 'provider_error',
            ...(params.autoNotify ? { autoNotify: true } : {}),
          })
          return
        }

        // No tool calls – finish
        if (pendingToolCalls.length === 0) {
          messages.push({ role: 'assistant', content: responseText })
          assistantStats.set(messages.length - 1, { inputTokens, outputTokens, durationMs: modelDurationMs })
          const tokensPerSecond = modelDurationMs > 0 ? Math.round(outputTokens / (modelDurationMs / 1000)) : 0
          this.broadcast(clientId, 'chat.final', {
            text: responseText,
            sessionId,
            correlationId,
            inputTokens,
            outputTokens,
            tokensPerSecond,
            ...(params.autoNotify ? { autoNotify: true } : {}),
          })
          break
        }

        // Append assistant turn with tool calls
        messages.push({
          role: 'assistant',
          content: responseText,
          tool_calls: pendingToolCalls,
        })
        assistantStats.set(messages.length - 1, { inputTokens, outputTokens, durationMs: modelDurationMs })

        // agent.status: thinking between tool rounds
        this.broadcast(clientId, 'agent.status', {
          agentId: this.config.agentId,
          sessionId,
          status: 'thinking' as AgentStatus,
          contextPct: contextPercent(activeModel, inputTokens),
          correlationId,
        })

        for (const toolCall of pendingToolCalls) {
          const permitted = this.config.registry.hasCapability(this.config.agentId, toolCall.name)

          if (!permitted) {
            console.warn(`[loop] ${correlationId} SECURITY: agent "${this.config.agentId}" attempted unpermitted tool "${toolCall.name}"`)
            this.config.monitorBuffer.enqueue({
              kind: 'error',
              correlationId,
              agentId: this.config.agentId,
              sessionId,
              code: 'TOOL_PERMISSION_DENIED',
              message: redact(`Agent "${this.config.agentId}" attempted unpermitted tool "${toolCall.name}"`),
            })
            messages.push({
              role: 'tool',
              content: JSON.stringify({ error: `Tool "${toolCall.name}" is not permitted for this agent.` }),
              tool_call_id: toolCall.id,
            })
            continue
          }

          this.broadcast(clientId, 'agent.status', {
            agentId: this.config.agentId,
            sessionId,
            status: 'tool_running' as AgentStatus,
            detail: toolCall.name,
            correlationId,
          })

          const executor = this.config.tools.get(toolCall.name)
          const inputHash = createHash('sha256').update(JSON.stringify(toolCall.arguments)).digest('hex')

          let toolOutput: string
          let toolError: string | undefined
          let toolStatus: 'ok' | 'error'
          let durationMs = 0

          if (!executor) {
            toolOutput = JSON.stringify({ error: `No executor found for tool "${toolCall.name}"` })
            toolError = `no executor for "${toolCall.name}"`
            toolStatus = 'error'
          } else {
            const result = await executor.execute(toolCall.arguments, {
              correlationId,
              agentId: this.config.agentId,
              sessionId,
              // Propagate Dave's CURRENT provider+model into ToolContext so that
              // spawn-style tools (pipeline_run, subagent_spawn) inherit Dave's
              // active lineage instead of using a stale boot-time closure.
              provider: this.config.provider,
              model:    activeModel,
            })
            toolOutput = result.output
            toolError = result.error
            toolStatus = result.status
            durationMs = result.durationMs
          }

          const outputHash = createHash('sha256').update(toolOutput).digest('hex')

          this.config.monitorBuffer.enqueue({
            kind: 'tool_call',
            correlationId,
            agentId: this.config.agentId,
            sessionId,
            toolName: toolCall.name,
            inputHash,
            outputHash: toolStatus === 'ok' ? outputHash : undefined,
            status: toolStatus,
            error: toolError ? redact(toolError) : undefined,
            durationMs,
          })

          this.broadcast(clientId, 'session.tool', {
            sessionId,
            toolName: toolCall.name,
            correlationId,
            status: toolStatus,
            durationMs,
          })

          messages.push({
            role: 'tool',
            content: toolStatus === 'ok' ? toolOutput : JSON.stringify({ error: toolError }),
            tool_call_id: toolCall.id,
          })

          failureTracker.record(toolStatus, toolError)
        }

        if (failureTracker.tripped) {
          stopReason = 'failures'
          break
        }

        // Context budget warning
        const estimatedTokens = estimateTokens(messages)
        if (estimatedTokens > 100_000) {
          this.broadcast(clientId, 'agent.status', {
            agentId: this.config.agentId,
            sessionId,
            status: 'context_warning' as AgentStatus,
            estimatedTokens,
            correlationId,
          })
        }
      }

      // Persist the assistant reply + any tool_calls/tool-result rows for this turn.
      // The first "new" message is the user/synthetic prompt and is NOT persisted
      // here: for a normal run it was already saved up-front (vanish-on-error guard
      // above); for an autoNotify run it's the dropped [SYSTEM EVENT]. So we always
      // skip it and persist only what follows. autoNotify rows stay flagged.
      const historyOffset = 1 + history.length  // skip system + prior history
      const allNewMessages = messages.slice(historyOffset)
      const newMessages = allNewMessages.slice(1)
      if (newMessages.length > 0) {
        const newStats = newMessages.map((_, i) => {
          const sourceIdx = historyOffset + i + 1
          return assistantStats.get(sourceIdx) ?? null
        })
        this.persistMessages(sessionId, newMessages, newStats, params.autoNotify === true)
      }

      if (stopReason === 'aborted') {
        // Intentional user stop — clean end, no error_log row. The partial reply
        // (if any) was already appended above and is persisted with the turn.
        this.broadcast(clientId, 'chat.final', {
          text: '[Stopped.]',
          sessionId,
          correlationId,
          error: 'aborted',
        })
      } else if (stopReason === 'timeout') {
        this.config.monitorBuffer.enqueue({
          kind: 'error',
          correlationId,
          agentId: this.config.agentId,
          sessionId,
          code: 'TURN_TIMEOUT',
          message: redact(`chat turn stopped — exceeded ${timeoutSeconds}s wall-clock deadline`),
        })
        this.broadcast(clientId, 'chat.final', {
          text: `[Turn stopped — it ran past the ${timeoutSeconds}s time limit.]`,
          sessionId,
          correlationId,
          error: 'turn_timeout',
        })
      } else if (stopReason === 'failures') {
        this.config.monitorBuffer.enqueue({
          kind: 'error',
          correlationId,
          agentId: this.config.agentId,
          sessionId,
          code: 'CONSECUTIVE_TOOL_FAILURES',
          message: redact(`chat turn stopped — ${failureTracker.limit} consecutive tool failures; last: ${failureTracker.lastError ?? 'unknown'}`),
        })
        this.broadcast(clientId, 'chat.final', {
          text: `[Stopped after ${failureTracker.limit} consecutive tool failures. Last error: ${failureTracker.lastError ?? 'unknown'}. I stopped to avoid looping — tell me how you'd like to proceed.]`,
          sessionId,
          correlationId,
          error: 'consecutive_tool_failures',
        })
      } else if (iterations >= maxIterations) {
        this.broadcast(clientId, 'chat.final', {
          text: '[Loop limit reached — the agent stopped after the maximum number of iterations.]',
          sessionId,
          correlationId,
          error: 'max_iterations_exceeded',
        })
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.config.monitorBuffer.enqueue({
        kind: 'error',
        correlationId,
        agentId: this.config.agentId,
        sessionId: params.sessionId,
        code: 'LOOP_ERROR',
        message: redact(errMsg),
        stack: err instanceof Error && err.stack ? redact(err.stack) : undefined,
      })
      this.broadcast(clientId, 'agent.status', {
        agentId: this.config.agentId,
        sessionId: params.sessionId,
        status: 'error' as AgentStatus,
        detail: errMsg,
        correlationId,
      })
      this.broadcast(clientId, 'chat.final', {
        text: '[An error occurred. See gateway logs.]',
        error: 'internal',
        correlationId,
      })
      console.error(`[loop] ${correlationId} internal error:`, err)
    } finally {
      // Always send idle status
      this.broadcast(clientId, 'agent.status', {
        agentId: this.config.agentId,
        sessionId: params.sessionId,
        status: 'idle' as AgentStatus,
        correlationId,
      })
    }
  }

  private broadcast(clientId: string, event: string, payload: Record<string, unknown>): void {
    this.config.broadcast(clientId, event, payload)
  }

  private loadHistory(sessionId: string): Message[] {
    interface Row {
      role: string
      content: string
      tool_calls: string | null
      tool_call_id: string | null
    }
    const rows = this.config.db
      .prepare<[string], Row>(
        `SELECT role, content, tool_calls, tool_call_id
         FROM messages WHERE session_id = ? ORDER BY created_at ASC`
      )
      .all(sessionId)

    return rows.map((row): Message => ({
      role: row.role as Message['role'],
      content: row.content,
      ...(row.tool_calls ? { tool_calls: JSON.parse(row.tool_calls) as ToolCall[] } : {}),
      ...(row.tool_call_id ? { tool_call_id: row.tool_call_id } : {}),
    }))
  }

  private persistMessages(sessionId: string, messages: Message[], stats: (MessageStats | null)[], autoNotify = false): void {
    const insert = this.config.db.prepare(
      `INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, created_at,
                             input_tokens, output_tokens, duration_ms, auto_notify)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const updateSession = this.config.db.prepare(
      `UPDATE sessions SET updated_at = ? WHERE id = ?`
    )
    const now = Date.now()
    const flag = autoNotify ? 1 : 0

    try {
      this.config.db.transaction(() => {
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i]!
          const st  = stats[i] ?? null
          insert.run(
            randomUUID(),
            sessionId,
            msg.role,
            msg.content,
            msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
            msg.tool_call_id ?? null,
            now,
            st?.inputTokens  ?? null,
            st?.outputTokens ?? null,
            st?.durationMs   ?? null,
            flag,
          )
        }
        updateSession.run(now, sessionId)
      })()
    } catch (err) {
      // The session can be deleted mid-turn (user deletes it to stop Dave). The
      // FK insert then has nowhere to land — that's expected, not a failure.
      // Swallow it quietly instead of surfacing a LOOP_ERROR. (§3.21)
      if (err instanceof Error && /FOREIGN KEY/i.test(err.message)) {
        console.warn(`[loop] persist skipped — session ${sessionId} was deleted mid-turn`)
        return
      }
      throw err
    }
  }
}

// Helper: token estimate
function estimateTokens(messages: Message[]): number {
  const chars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0)
  return Math.ceil(chars / 4)
}
