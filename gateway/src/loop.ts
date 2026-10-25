import { randomUUID, createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { loadSystemPrompt, currentDateTimeNote } from './memory/loader.js'
import type { ProviderAdapter, Message, StreamChunk, ToolCall, ToolDefinition } from './providers/types.js'
import { withoutUnopenedThinking } from './providers/think-tags.js'
import { computeCost, contextPercent, knownContextWindow } from './providers/pricing.js'
import { AgentRegistry } from './agents/registry.js'
import type { AgentStatus } from './types.js'
import type { MonitorBuffer } from './store/monitor-buffer.js'
import { redact } from './store/redact.js'
import type { RegisteredTool } from './tools/types.js'
import { toolOverrides } from './store/tool-overrides.js'
import { ConsecutiveFailureTracker } from './failure-tracker.js'

const THINKING_UNFINISHED_REPLY = '[The model ran out of room while thinking and wrote no answer. Try again, or give it a larger context length.]'

// A turn the loop has to cut short (step limit, failing tools, context nearly full) ends with one more model call that is
// offered no tools, so the person gets an answer built from what was found instead of a bare stop notice.
type WrapUp = { reason: 'steps' } | { reason: 'failures' } | { reason: 'context'; usage: string }

// Share of the model's context window a turn may fill before it is wrapped up. Tool results are what grow a turn, and the
// next model call would otherwise fail outright once the window is full.
const CONTEXT_WRAP_UP_SHARE = 0.75
// With no known window (unlisted model, local server not reporting), the old fixed warning level applies and nothing is cut short.
const FALLBACK_CONTEXT_WARNING_TOKENS = 100_000

const REPEATED_CALL_ERROR = 'This call returned exactly the same result as an identical earlier call this turn; that result is above. Use it, try something different, or answer.'

// With no tools offered, a local model that still wants one writes the call out as text; it is not an answer.
const TOOL_CALL_MARKUP = /<tool_call>[\s\S]*?(<\/tool_call>|$)/g

/** The wrap-up note rides on the last message when that is the person's, so roles still alternate (some local chat
 *  templates refuse two user messages in a row). */
function withWrapUpNote(messages: Message[], note: string): Message[] {
  const last = messages[messages.length - 1]
  return last?.role === 'user'
    ? [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${note}` }]
    : [...messages, { role: 'user', content: note }]
}

// The note goes out with the person's role, so it only ever carries the loop's own words and numbers. Error text can come from
// a web page or a file, and stays in the tool results where the model already treats it as data.
function wrapUpNote(wrapUp: WrapUp): string {
  const answer = 'Tools are off now. Answer the person using only what you have already found: say what you found, what you could not finish, and what you would do next.'
  if (wrapUp.reason === 'steps') return `[You have used all your tool steps for this turn. ${answer}]`
  if (wrapUp.reason === 'failures') return `[Your last tool calls kept failing (the errors are in the results above). ${answer}]`
  return `[This conversation is nearly out of room (${wrapUp.usage}). ${answer} Suggest a new chat if there is more to do.]`
}

function wrapUpFallback(wrapUp: WrapUp): string {
  if (wrapUp.reason === 'steps') return '[Loop limit reached: the agent stopped after the maximum number of steps.]'
  if (wrapUp.reason === 'failures') return '[Stopped after repeated tool failures, to avoid looping. The errors are in the tool results. Tell me how you\'d like to proceed.]'
  return `[Stopped: the conversation is nearly out of room (${wrapUp.usage}). Start a new chat to carry on.]`
}

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
        model: activeModel,
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

      // Step 4 — build tool definitions from the tools map
      // Three filters: exec gate → registry capability → UI override
      const enabledOverride = toolOverrides.get(this.config.agentId)
      const toolDefs: ToolDefinition[] = []
      for (const [name, tool] of this.config.tools) {
        // A proactive pipeline notice only reports what the pipeline wrote. Its message carries report text from the web and from worker
        // agents (untrusted), so that turn is offered no tools: nothing written in a report can make Dave act.
        if (params.autoNotify) break
        if (tool.requiresExplicitEnable && !this.config.execEnabled) continue
        if (!this.config.registry.hasCapability(this.config.agentId, name)) continue
        if (enabledOverride !== undefined && !enabledOverride.has(name)) continue
        toolDefs.push(tool.schema)
      }
      const tools = toolDefs.length > 0 ? toolDefs : undefined
      // Dispatch only ever runs a tool that was offered this turn. A model can name a tool it
      // was never given (exec is a common guess), and the registry alone would let it through.
      const offeredTools = new Set(toolDefs.map((t) => t.name))

      // Step 5 — load frozen identity snapshot for this session, plus what is on right now
      const systemPrompt = loadSystemPrompt(this.config.db, this.config.agentId, {
        offeredTools: [...offeredTools],
        execEnabled: this.config.execEnabled ?? false,
      })

      // The live clock rides on the latest USER turn (which is always reprocessed anyway),
      // NOT the system prompt — keeping the cached system+tools prefix byte-stable so SWA
      // models (e.g. Gemma-4) reuse it instead of re-processing the whole prompt every turn.
      // The clean `message` is what's persisted (above); this note is outgoing-only, so it
      // never enters stored history. See loader.ts currentDateTimeNote / 2026-06-10 fix.
      const messages: Message[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: `${currentDateTimeNote()}\n\n${message}` },
      ]

      let iterations = 0
      const maxIterations = Math.max(1, this.config.maxIterations ?? 10)
      // Containment guards (chat loop) — bound a runaway regardless of model
      // behaviour: a per-turn wall-clock deadline, a hard stop after N consecutive
      // tool failures (the failing-loop case, e.g. blind file_read guessing), and
      // the iteration cap.
      const timeoutSeconds = this.config.timeoutSeconds ?? 600
      const deadline = Date.now() + timeoutSeconds * 1000
      const failureTracker = new ConsecutiveFailureTracker()
      let stopReason: 'normal' | 'timeout' | 'aborted' = 'normal'
      let wrapUp: WrapUp | null = null
      // Tool name + argument hash of each call this turn -> hash of what the model was sent back, to spot a model repeating itself.
      const earlierCalls = new Map<string, string>()
      // Per-assistant-message stats, keyed by index in `messages`. Persisted with the row.
      const assistantStats = new Map<number, MessageStats>()
      let thoughtInTurn = false

      // Persist the assistant reply + any tool_calls/tool-result rows for this turn.
      // The first "new" message is the user/synthetic prompt and is NOT persisted
      // here: for a normal run it was already saved up-front (vanish-on-error guard
      // above); for an autoNotify run it's the dropped [SYSTEM EVENT]. So we always
      // skip it and persist only what follows. autoNotify rows stay flagged.
      // Also called before a provider-error return, so the tool work done so far is kept.
      const persistTurn = (): void => {
        const historyOffset = 1 + history.length  // skip system + prior history
        const newMessages = messages.slice(historyOffset).slice(1)
        if (newMessages.length === 0) return
        const newStats = newMessages.map((_, i) => assistantStats.get(historyOffset + i + 1) ?? null)
        this.persistMessages(sessionId, newMessages, newStats, params.autoNotify === true)
      }

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
        if (!wrapUp && iterations === maxIterations) wrapUp = { reason: 'steps' }

        // Call provider. The wrap-up note is outgoing only, like the clock note, so it never enters stored history.
        const callStartMs = Date.now()
        let inputTokens = 0
        let outputTokens = 0
        let modelDurationMs = 0
        const stream = this.config.provider.complete({
          model: activeModel,
          messages: wrapUp ? withWrapUpNote(messages, wrapUpNote(wrapUp)) : messages,
          tools: wrapUp ? undefined : tools,
          correlationId,
          ...(params.reasoning ? { reasoning: params.reasoning } : {}),
          ...(params.abortSignal ? { signal: params.abortSignal } : {}),
        }) as AsyncIterable<StreamChunk>

        let responseText = ''
        let thoughtThisRound = false
        let providerError: string | undefined
        const pendingToolCalls: ToolCall[] = []

        // Stream handling
        for await (const chunk of stream) {
          if (chunk.type === 'text_delta') {
            responseText += chunk.delta
            this.broadcast(clientId, 'chat.delta', { delta: chunk.delta, correlationId, sessionId })
          }
          // Thinking is shown live only. Kept out of responseText so it is never saved as the reply or sent back to the model.
          if (chunk.type === 'thinking_delta') {
            // The page shows one box per turn, so an earlier tool round's thinking is already in it: start a new paragraph.
            const delta = thoughtInTurn && !thoughtThisRound ? `\n\n${chunk.delta}` : chunk.delta
            thoughtInTurn = thoughtThisRound = true
            this.broadcast(clientId, 'chat.thinking', { delta, correlationId, sessionId })
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
        responseText = withoutUnopenedThinking(responseText)

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
          persistTurn()
          return
        }

        // No tool calls – finish. A wrap-up round always finishes: any tool call a model makes there anyway is dropped.
        if (pendingToolCalls.length === 0 || wrapUp) {
          // Thinking is never saved, so a model that used up its room mid-thought would otherwise leave a blank reply.
          if (wrapUp) responseText = responseText.replace(TOOL_CALL_MARKUP, '').trim()
          if (thoughtThisRound && !responseText.trim()) responseText = THINKING_UNFINISHED_REPLY
          else if (wrapUp && !responseText) {
            responseText = wrapUpFallback(wrapUp)
            // Sent as a delta too: the voice bridge speaks what streams, and a final with no error and nothing streamed is silent.
            this.broadcast(clientId, 'chat.delta', { delta: responseText, correlationId, sessionId })
          }
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
          const permitted = offeredTools.has(toolCall.name)
            && this.config.registry.hasCapability(this.config.agentId, toolCall.name)

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

          // A repeat that changed nothing is sent back as a short error instead of the same result again: it costs no context,
          // and the failure count stops a model that keeps doing it.
          const reply = toolStatus === 'ok' ? toolOutput : JSON.stringify({ error: toolError })
          const callKey = `${toolCall.name}:${inputHash}`
          const replyHash = createHash('sha256').update(reply).digest('hex')
          const repeated = earlierCalls.get(callKey) === replyHash
          earlierCalls.set(callKey, replyHash)

          messages.push({
            role: 'tool',
            content: repeated ? JSON.stringify({ error: REPEATED_CALL_ERROR }) : reply,
            tool_call_id: toolCall.id,
          })

          if (repeated) failureTracker.record('error', `repeated ${toolCall.name} with the same arguments`)
          else failureTracker.record(toolStatus, toolError)
        }

        if (failureTracker.tripped && !wrapUp) {
          this.config.monitorBuffer.enqueue({
            kind: 'error',
            correlationId,
            agentId: this.config.agentId,
            sessionId,
            code: 'CONSECUTIVE_TOOL_FAILURES',
            message: redact(`chat turn wrapped up after ${failureTracker.limit} consecutive tool failures; last: ${failureTracker.lastError ?? 'unknown'}`),
          })
          wrapUp = { reason: 'failures' }
        }

        // Context budget: warn, and wrap the turn up before the next model call would overflow the window.
        const estimatedTokens = estimateTokens(messages)
        const contextLimit = knownContextWindow(this.config.provider.name === 'local' ? 'local' : 'cloud', activeModel)
        if (estimatedTokens > (contextLimit ? contextLimit * CONTEXT_WRAP_UP_SHARE : FALLBACK_CONTEXT_WARNING_TOKENS)) {
          this.broadcast(clientId, 'agent.status', {
            agentId: this.config.agentId,
            sessionId,
            status: 'context_warning' as AgentStatus,
            estimatedTokens,
            correlationId,
          })
          if (contextLimit && !wrapUp) {
            wrapUp = { reason: 'context', usage: `about ${Math.round(estimatedTokens / 1000)}k of ${Math.round(contextLimit / 1000)}k tokens used` }
          }
        }
      }

      persistTurn()

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
          text: `[Turn stopped: it ran past the ${timeoutSeconds}s time limit.]`,
          sessionId,
          correlationId,
          error: 'turn_timeout',
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
         FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`
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
