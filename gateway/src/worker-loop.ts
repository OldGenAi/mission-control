/**
 * worker-loop.ts — Headless worker agent execution
 *
 * Runs a Tier 3 specialist worker without a persistent session or connected
 * UI client. All output goes to the artifact store + monitor events.
 * Called by subagent_spawn when a worker is requested.
 *
 * Security-sensitive. Do not modify without Claude review.
 */

import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import { computeCost, contextPercent } from './providers/pricing.js'
import type {
  ProviderAdapter,
  Message,
  ToolCall,
  ToolDefinition,
} from './providers/types.js'
import type { AgentRegistry } from './agents/registry.js'
import type { MonitorBuffer } from './store/monitor-buffer.js'
import type { RegisteredTool } from './tools/types.js'
import { redact } from './store/redact.js'
import { ConsecutiveFailureTracker } from './failure-tracker.js'

// ---------------------------------------------------------------------------
// Config + result types
// ---------------------------------------------------------------------------

export interface WorkerRunConfig {
  role:            string
  task:            string
  allowedTools:    string[]
  inputArtifacts?: string[]
  context?:        Record<string, unknown>
  correlationId:   string
  /** Set by the pipeline runner when the worker is spawned inside a pipeline
   *  step. Flows into ToolContext so artifact_write can auto-stamp linkage. */
  pipelineRunId?: string
  stepId?:        string
  // injected infrastructure
  db:            Database.Database
  registry:      AgentRegistry
  provider:      ProviderAdapter
  model:         string
  tools:         Map<string, RegisteredTool>
  monitorBuffer: MonitorBuffer
  broadcast:     (clientId: string, event: string, payload: Record<string, unknown>) => void
  /** Absolute epoch-ms wall-clock deadline. When reached, the worker stops
   *  starting new model calls / spawns and returns a timeout error. Threaded
   *  from the pipeline runner so a hung run can't burn past budget.timeoutSeconds. */
  deadline?:     number
}

export interface WorkerResult {
  status:      'ok' | 'error' | 'max_iterations'
  artifactId?: string
  output?:     string
  tokensUsed:  number
  costUsd:     number
  error?:      string
}

// ---------------------------------------------------------------------------
// runWorker — main entry point
// ---------------------------------------------------------------------------

export async function runWorker(config: WorkerRunConfig): Promise<WorkerResult> {
  const { role, task, allowedTools, correlationId } = config
  const workerAgentId = `${role}-${randomUUID().slice(0, 8)}`

  let tokensUsed = 0
  let costUsd = 0
  const writtenArtifactIds: string[] = []

  try {
    // Load input artifact contents from the DB
    const artifactBlocks: string[] = []
    if (config.inputArtifacts && config.inputArtifacts.length > 0) {
      const stmt = config.db.prepare<[string], { title: string; content: string }>(
        'SELECT title, content FROM artifacts WHERE id = ?'
      )
      for (const artifactId of config.inputArtifacts) {
        const row = stmt.get(artifactId)
        if (row) artifactBlocks.push(`### ${row.title}\n${row.content}`)
      }
    }

    // Build system prompt from spec file (markdown body, frontmatter stripped)
    const systemPrompt = loadWorkerSystemPrompt(role)

    // Build restricted toolset — only tools in allowedTools that exist in tools map
    const toolDefs: ToolDefinition[] = []
    for (const toolName of allowedTools) {
      const tool = config.tools.get(toolName)
      if (tool) toolDefs.push(tool.schema)
    }

    // Build initial user message — task + any input artifacts
    let userContent = task
    if (artifactBlocks.length > 0) {
      userContent += '\n\n## Input Artifacts\n\n' + artifactBlocks.join('\n\n---\n\n')
    }

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userContent  },
    ]

    const credential = config.registry.get(role)
    const maxIterations = credential?.maxIterations ?? 10

    config.broadcast('', 'agent.status', {
      agentId: workerAgentId, status: 'thinking', model: config.model, correlationId,
    })

    let iterations = 0
    const failureTracker = new ConsecutiveFailureTracker()

    // Cumulative tool-output guard. The loop re-sends the full message history on
    // every model call, so large/repeated tool outputs (many web_fetches, big
    // file_reads) compound into a context + token explosion. Bound the total
    // material a worker ingests — independent of which tool produced it — nudging
    // it to finish at the soft cap and hard-stopping past the hard cap.
    let cumulativeToolOutputChars = 0
    let wrapUpNudged = false
    const TOOL_OUTPUT_SOFT_CAP = 40_000  // ~10k tokens gathered → tell it to synthesise + write
    const TOOL_OUTPUT_HARD_CAP = 80_000  // ~20k tokens → stop, regardless of model behaviour

    while (iterations < maxIterations) {
      // Wall-clock deadline guard — don't start another model call / spawn past
      // the pipeline's timeout. This is what bounds an orchestrator that keeps
      // re-spawning workers after upstream rate-limits.
      if (config.deadline && Date.now() >= config.deadline) {
        const msg = `WORKER_TIMEOUT: worker "${role}" stopped — pipeline wall-clock deadline reached`
        console.warn(`[worker] ${correlationId} ${msg}`)
        config.monitorBuffer.enqueue({
          kind: 'error', correlationId, agentId: workerAgentId,
          code: 'WORKER_TIMEOUT', message: redact(msg),
        })
        config.broadcast('', 'agent.status', {
          agentId: workerAgentId, status: 'error', detail: msg, correlationId,
        })
        return { status: 'error', error: msg, tokensUsed, costUsd }
      }
      iterations++

      const callStart   = Date.now()
      let inputTokens   = 0
      let outputTokens  = 0
      let responseText  = ''
      let providerError: string | undefined
      const pendingToolCalls: ToolCall[] = []

      const stream = config.provider.complete({
        model:         config.model,
        messages,
        tools:         toolDefs.length > 0 ? toolDefs : undefined,
        correlationId,
      })

      for await (const chunk of stream) {
        if (chunk.type === 'text_delta') responseText += chunk.delta
        if (chunk.type === 'tool_call')  pendingToolCalls.push(chunk.toolCall)
        if (chunk.type === 'done') {
          inputTokens  = chunk.usage.inputTokens
          outputTokens = chunk.usage.outputTokens
          tokensUsed  += inputTokens + outputTokens
          const callCost = computeCost(config.model, inputTokens, outputTokens)
          costUsd += callCost
          providerError = chunk.error
          config.monitorBuffer.enqueue({
            kind:          'model_call',
            correlationId,
            agentId:       workerAgentId,
            provider:      config.provider.name,
            model:         config.model,
            inputTokens,
            outputTokens,
            costUsd:       callCost,
            durationMs:    Date.now() - callStart,
          })
        }
      }

      // Provider surfaced an upstream error (e.g. a 429) as a graceful done.
      // Record it in error_log and fail the worker cleanly so the orchestrator
      // gets a real error instead of an empty, artifact-less "success".
      if (providerError) {
        config.monitorBuffer.enqueue({
          kind: 'error',
          correlationId,
          agentId: workerAgentId,
          code: 'PROVIDER_ERROR',
          message: redact(providerError),
        })
        config.broadcast('', 'agent.status', {
          agentId: workerAgentId, status: 'error', detail: providerError, correlationId,
        })
        return { status: 'error', error: providerError, tokensUsed, costUsd }
      }

      // No tool calls — worker finished
      if (pendingToolCalls.length === 0) {
        config.broadcast('', 'agent.status', {
          agentId: workerAgentId, status: 'idle', correlationId,
        })
        // Integrity check: every Tier 3 worker spec mandates a final artifact_write.
        // If the worker stopped without producing one, the pipeline must be marked
        // failed — not silently "completed" with no deliverable. This catches the
        // common Gemma failure mode of skipping/mistyping artifact_write at the end.
        if (writtenArtifactIds.length === 0) {
          const msg = `WORKER_NO_ARTIFACT: worker "${role}" finished without calling artifact_write — the pipeline has no deliverable`
          console.warn(`[worker] ${correlationId} ${msg}`)
          config.monitorBuffer.enqueue({
            kind: 'error', correlationId, agentId: workerAgentId,
            code: 'WORKER_NO_ARTIFACT', message: redact(msg),
          })
          return { status: 'error', error: msg, tokensUsed, costUsd }
        }
        return {
          status:     'ok',
          artifactId: writtenArtifactIds[writtenArtifactIds.length - 1],
          output:     responseText,
          tokensUsed,
          costUsd,
        }
      }

      // Append assistant turn with tool calls
      messages.push({ role: 'assistant', content: responseText, tool_calls: pendingToolCalls })

      // Execute each tool call
      for (const toolCall of pendingToolCalls) {

        // Security: only tools in the allowed set
        if (!allowedTools.includes(toolCall.name)) {
          const msg = `Worker "${role}" attempted unpermitted tool "${toolCall.name}"`
          console.warn(`[worker] ${correlationId} SECURITY: ${msg}`)
          config.monitorBuffer.enqueue({
            kind: 'error', correlationId, agentId: workerAgentId,
            code: 'WORKER_TOOL_DENIED', message: redact(msg),
          })
          messages.push({
            role:         'tool',
            content:      JSON.stringify({ error: `Tool "${toolCall.name}" is not permitted for this worker.` }),
            tool_call_id: toolCall.id,
          })
          continue
        }

        config.broadcast('', 'agent.status', {
          agentId: workerAgentId, status: 'tool_running', detail: toolCall.name, correlationId,
        })

        const executor  = config.tools.get(toolCall.name)
        const inputHash = createHash('sha256')
          .update(JSON.stringify(toolCall.arguments))
          .digest('hex')

        let toolOutput: string
        let toolStatus: 'ok' | 'error'
        let toolError:  string | undefined
        let durationMs  = 0

        if (!executor) {
          toolOutput = JSON.stringify({ error: `No executor for tool "${toolCall.name}"` })
          toolStatus = 'error'
          toolError  = `no executor for "${toolCall.name}"`
        } else {
          const result = await executor.execute(toolCall.arguments, {
            correlationId,
            agentId:   workerAgentId,
            sessionId: '',
            // Propagate the worker's CURRENT provider+model into ToolContext so that
            // any spawn-style tool inherits this agent's lineage. This is what makes
            // a UI model swap reach orchestrator + workers, not just Dave.
            provider:  config.provider,
            model:     config.model,
            ...(config.pipelineRunId ? { pipelineRunId: config.pipelineRunId } : {}),
            ...(config.stepId        ? { stepId:        config.stepId        } : {}),
            ...(config.deadline      ? { deadline:      config.deadline      } : {}),
          })
          toolOutput = result.output
          toolStatus = result.status
          toolError  = result.error
          durationMs = result.durationMs
        }

        config.monitorBuffer.enqueue({
          kind:          'tool_call',
          correlationId,
          agentId:       workerAgentId,
          toolName:      toolCall.name,
          inputHash,
          outputHash:    toolStatus === 'ok'
            ? createHash('sha256').update(toolOutput).digest('hex')
            : undefined,
          status:        toolStatus,
          error:         toolError ? redact(toolError) : undefined,
          durationMs,
        })

        // Track artifact IDs so we can return the last one written
        if (toolCall.name === 'artifact_write' && toolStatus === 'ok') {
          try {
            const parsed = JSON.parse(toolOutput) as { id?: string }
            if (parsed.id) writtenArtifactIds.push(parsed.id)
          } catch { /* non-JSON — ignore */ }
        }

        // Propagate sub-worker tokens up so the pipeline runner sees the FULL
        // cost of a spawn_agent step (orchestrator + every worker it spawned),
        // not just the orchestrator's own LLM calls. Without this, pipeline
        // budgets (maxTokens / maxCostUsd) under-count by 5-10× and can't
        // enforce limits when workers are doing the heavy lifting.
        if (toolCall.name === 'subagent_spawn' && toolStatus === 'ok') {
          try {
            const parsed = JSON.parse(toolOutput) as { tokensUsed?: number; costUsd?: number }
            if (typeof parsed.tokensUsed === 'number' && parsed.tokensUsed > 0) {
              tokensUsed += parsed.tokensUsed
            }
            if (typeof parsed.costUsd === 'number' && parsed.costUsd > 0) {
              costUsd += parsed.costUsd
            }
          } catch { /* non-JSON — ignore */ }
        }

        messages.push({
          role:         'tool',
          content:      toolStatus === 'ok'
            ? toolOutput
            : JSON.stringify({ error: toolError ?? 'tool error' }),
          tool_call_id: toolCall.id,
        })

        failureTracker.record(toolStatus, toolError)
        if (toolStatus === 'ok') cumulativeToolOutputChars += toolOutput.length
      }

      // Consecutive-failure stop — bounds a worker (or an orchestrator
      // re-spawning a failing worker) that keeps calling tools that error,
      // well before max-iterations or the wall-clock deadline.
      if (failureTracker.tripped) {
        const msg = `worker "${role}" stopped — ${failureTracker.limit} consecutive tool failures; last: ${failureTracker.lastError ?? 'unknown'}`
        console.warn(`[worker] ${correlationId} ${msg}`)
        config.monitorBuffer.enqueue({
          kind: 'error', correlationId, agentId: workerAgentId,
          code: 'CONSECUTIVE_TOOL_FAILURES', message: redact(msg),
        })
        config.broadcast('', 'agent.status', {
          agentId: workerAgentId, status: 'error', detail: msg, correlationId,
        })
        return { status: 'error', error: msg, tokensUsed, costUsd }
      }

      // Cumulative tool-output guard (see declaration above). Hard cap stops a
      // worker that keeps ingesting without converging; if it already produced a
      // deliverable we accept it, otherwise it's a no-artifact failure.
      if (cumulativeToolOutputChars >= TOOL_OUTPUT_HARD_CAP) {
        if (writtenArtifactIds.length > 0) {
          config.broadcast('', 'agent.status', { agentId: workerAgentId, status: 'idle', correlationId })
          return {
            status: 'ok',
            artifactId: writtenArtifactIds[writtenArtifactIds.length - 1],
            output: responseText,
            tokensUsed,
            costUsd,
          }
        }
        const msg = `CONTEXT_BUDGET: worker "${role}" stopped — gathered ~${Math.round(cumulativeToolOutputChars / 1000)}k chars of tool output without producing an artifact`
        console.warn(`[worker] ${correlationId} ${msg}`)
        config.monitorBuffer.enqueue({
          kind: 'error', correlationId, agentId: workerAgentId,
          code: 'CONTEXT_BUDGET', message: redact(msg),
        })
        config.broadcast('', 'agent.status', {
          agentId: workerAgentId, status: 'error', detail: msg, correlationId,
        })
        return { status: 'error', error: msg, tokensUsed, costUsd }
      }

      // Soft cap — one-time nudge to synthesise and finish before the hard stop.
      if (cumulativeToolOutputChars >= TOOL_OUTPUT_SOFT_CAP && !wrapUpNudged) {
        wrapUpNudged = true
        messages.push({
          role: 'user',
          content:
            `[system] You have gathered enough material (~${Math.round(cumulativeToolOutputChars / 1000)}k characters). ` +
            `Stop gathering now and call artifact_write with what you have — do not fetch or read anything further.`,
        })
      }

      config.broadcast('', 'agent.status', {
        agentId: workerAgentId, status: 'thinking', contextPct: contextPercent(config.model, inputTokens), correlationId,
      })
    }

    // Max iterations reached
    config.broadcast('', 'agent.status', {
      agentId: workerAgentId, status: 'idle', correlationId,
    })
    return {
      status:     'max_iterations',
      artifactId: writtenArtifactIds[writtenArtifactIds.length - 1],
      tokensUsed,
      costUsd,
    }

  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    config.monitorBuffer.enqueue({
      kind: 'error',
      correlationId,
      agentId: workerAgentId,
      code: 'WORKER_ERROR',
      message: redact(errMsg),
      stack: err instanceof Error && err.stack ? redact(err.stack) : undefined,
    })
    config.broadcast('', 'agent.status', {
      agentId: workerAgentId, status: 'error', detail: errMsg, correlationId,
    })
    return { status: 'error', error: errMsg, tokensUsed, costUsd }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadWorkerSystemPrompt(role: string): string {
  const specPath = path.join(__dirname, 'agents', 'specs', `${role}.md`)
  try {
    const raw  = fs.readFileSync(specPath, 'utf-8')
    const body = raw.replace(/^---[\s\S]*?---\s*\n/, '').trim()
    if (body) return body
  } catch {
    console.warn(`[worker] spec not found for role "${role}" at ${specPath} — using fallback`)
  }
  return (
    `You are a specialist worker agent with role: ${role}. ` +
    `Complete your assigned task and write your output using artifact_write.`
  )
}
