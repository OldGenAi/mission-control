/**
 * tools/spawn.ts — subagent_spawn tool
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * Restricted to Orchestrator (Tier 2) agents only. The registry enforces
 * this via the orchestrator spec's allowedTools list — spawn is not in any
 * Tier 1 or Tier 3 spec.
 *
 * Before the worker receives its toolset, every requested tool is checked
 * against the target role's capability list. Any tool not in that list is
 * stripped and a security warning is written to error_log.
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { AgentRegistry } from '../agents/registry.js'
import type { MonitorBuffer } from '../store/monitor-buffer.js'
import type { ProviderAdapter } from '../providers/types.js'
import { redact } from '../store/redact.js'
import type { RegisteredTool, ToolContext, ToolResult } from './types.js'
import { runWorker } from '../worker-loop.js'

export interface SpawnToolConfig {
  registry:      AgentRegistry
  monitorBuffer: MonitorBuffer
  db:            Database.Database
  provider:      ProviderAdapter
  model:         string
  tools:         Map<string, RegisteredTool>
  broadcast:     (clientId: string, event: string, payload: Record<string, unknown>) => void
}

export function makeSpawnTool(config: SpawnToolConfig): RegisteredTool {
  const { registry, monitorBuffer, db, provider, model, tools, broadcast } = config

  return {
    schema: {
      name: 'subagent_spawn',
      description:
        'Spawn one or more specialist sub-agents. Single mode: pass role/task/tools. ' +
        'Fan-out mode: pass `batch` (an array of {role, task, tools}) to run several ' +
        'workers in parallel — use this when the task splits into independent units. ' +
        'Each sub-agent receives only the tools its role is credentialed for; any tool ' +
        'outside that list is silently stripped.',
      parameters: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            description: 'Single mode: target agent role (must match a spec in agents/specs/).',
          },
          task: {
            type: 'string',
            description: 'Single mode: full task description passed to the sub-agent as its first message.',
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Single mode: tool names the sub-agent should have access to.',
          },
          batch: {
            type: 'array',
            description:
              'Fan-out mode: run multiple workers in parallel. Each entry is an independent ' +
              'worker with its own {role, task, tools}. Mutually exclusive with role/task/tools.',
            items: {
              type: 'object',
              required: ['role', 'task', 'tools'],
              properties: {
                role:           { type: 'string' },
                task:           { type: 'string' },
                tools:          { type: 'array', items: { type: 'string' } },
                inputArtifacts: { type: 'array', items: { type: 'string' } },
                context:        { type: 'object' },
                model:          { type: 'string', description: 'Optional per-worker model override.' },
              },
            },
          },
          inputArtifacts: {
            type: 'array',
            items: { type: 'string' },
            description: 'Single mode: artifact IDs to provide as context.',
          },
          model: {
            type: 'string',
            description: 'Single mode: optional model override for this worker.',
          },
          await: {
            type: 'boolean',
            description: 'If true (default), wait for the sub-agent(s) to finish before returning.',
          },
          context: {
            type: 'object',
            description: 'Single mode: arbitrary key-value context to pass to the sub-agent.',
          },
        },
      },
    },

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const start = Date.now()

      // Validate one worker spec and build its run config. Returns the prepared
      // config (+ spawnId and any stripped tools) or a human-readable error.
      // Shared by single and batch (fan-out) modes so they can't diverge.
      const prepareWorker = (spec: Record<string, unknown>): PreparedWorker | { error: string } => {
        const role     = spec['role']
        const task     = spec['task']
        const reqTools = spec['tools']

        if (typeof role !== 'string' || !role.trim()) return { error: 'role must be a non-empty string' }
        if (typeof task !== 'string' || !task.trim()) return { error: 'task must be a non-empty string' }
        if (!Array.isArray(reqTools) || !reqTools.every(t => typeof t === 'string')) {
          return { error: 'tools must be an array of strings' }
        }
        if (!registry.get(role)) return { error: `unknown agent role "${role}" — not in registry` }

        // Filter requested tools against the target role's capability list.
        const { allowed, stripped } = registry.filterTools(role, reqTools as string[])
        if (stripped.length > 0) {
          const msg = `subagent_spawn: role "${role}" was denied tools [${stripped.join(', ')}] — not in credential list`
          console.warn(`[spawn] ${ctx.correlationId} SECURITY: ${msg}`)
          monitorBuffer.enqueue({
            kind:          'error',
            correlationId: ctx.correlationId,
            agentId:       ctx.agentId,
            sessionId:     ctx.sessionId,
            code:          'SPAWN_TOOL_STRIPPED',
            message:       redact(msg),
          })
        }

        const spawnId = randomUUID()
        console.log(
          `[spawn] ${ctx.correlationId} spawning role="${role}" spawnId=${spawnId} allowedTools=[${allowed.join(', ')}]`
        )

        // Sub-agent inherits the CALLER's provider+model from ToolContext (what
        // lets a UI model swap reach every tier, not just Dave); a per-spec
        // `model` overrides it. Closure provider/model are boot-time fallbacks.
        const inheritedProvider = ctx.provider ?? provider
        const inheritedModel    = typeof spec['model'] === 'string' ? (spec['model'] as string) : (ctx.model ?? model)

        const workerConfig = {
          role,
          task:            task as string,
          allowedTools:    allowed,
          inputArtifacts:  Array.isArray(spec['inputArtifacts']) ? (spec['inputArtifacts'] as string[]) : undefined,
          context:         spec['context'] as Record<string, unknown> | undefined,
          correlationId:   ctx.correlationId,
          db,
          registry,
          provider:        inheritedProvider,
          model:           inheritedModel,
          tools,
          monitorBuffer,
          broadcast,
          // Propagate pipeline linkage so the sub-worker's artifact_write calls
          // are auto-stamped with the same pipeline_run_id / step_id.
          ...(ctx.pipelineRunId ? { pipelineRunId: ctx.pipelineRunId } : {}),
          ...(ctx.stepId        ? { stepId:        ctx.stepId        } : {}),
          // Inherit the run's wall-clock deadline so a spawned worker can't run past it.
          ...(ctx.deadline      ? { deadline:      ctx.deadline      } : {}),
        }

        return { workerConfig, spawnId, role, stripped }
      }

      const shouldAwait = args['await'] !== false  // default true
      const batchArg = args['batch']

      // ----- Fan-out mode: multiple workers in parallel -----
      if (batchArg !== undefined) {
        if (args['role'] !== undefined || args['task'] !== undefined || args['tools'] !== undefined) {
          return result(ctx, 'error', '', 'provide either `batch` or role/task/tools, not both', start)
        }
        if (!Array.isArray(batchArg) || batchArg.length === 0) {
          return result(ctx, 'error', '', 'batch must be a non-empty array of worker specs', start)
        }

        // Validate every entry up front — a malformed batch is a caller error,
        // surfaced loudly rather than partially run.
        const prepared: PreparedWorker[] = []
        for (let i = 0; i < batchArg.length; i++) {
          const p = prepareWorker(batchArg[i] as Record<string, unknown>)
          if ('error' in p) return result(ctx, 'error', '', `batch entry ${i}: ${p.error}`, start)
          prepared.push(p)
        }

        if (!shouldAwait) {
          for (const p of prepared) {
            runWorker(p.workerConfig).catch((err: unknown) => {
              console.error(`[spawn] ${ctx.correlationId} background batch worker error: ${err instanceof Error ? err.message : String(err)}`)
            })
          }
          return result(ctx, 'ok', JSON.stringify({
            results: prepared.map(p => ({ spawnId: p.spawnId, role: p.role, status: 'running' })),
          }), undefined, start)
        }

        const results = await Promise.all(prepared.map(async (p) => {
          const wr = await runWorker(p.workerConfig)
          return {
            spawnId:       p.spawnId,
            role:          p.role,
            status:        wr.status,
            artifactId:    wr.artifactId,
            tokensUsed:    wr.tokensUsed,
            costUsd:       wr.costUsd,
            strippedTools: p.stripped,
            ...(wr.status === 'error' ? { error: wr.error ?? 'worker failed' } : {}),
          }
        }))

        const tokensUsed = results.reduce((sum, r) => sum + (r.tokensUsed ?? 0), 0)
        const costUsd    = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
        // A batch that produced zero usable artifacts is a failed spawn — return
        // 'error' so it counts toward the orchestrator's consecutive-failure stop.
        // Any success → 'ok', and the orchestrator summarises the survivors.
        const allFailed = results.every(r => r.status === 'error')
        return result(
          ctx,
          allFailed ? 'error' : 'ok',
          JSON.stringify({ results, tokensUsed, costUsd }),
          allFailed ? 'all batch workers failed' : undefined,
          start,
        )
      }

      // ----- Single mode -----
      const prep = prepareWorker(args)
      if ('error' in prep) return result(ctx, 'error', '', prep.error, start)

      if (!shouldAwait) {
        runWorker(prep.workerConfig).catch((err: unknown) => {
          console.error(`[spawn] ${ctx.correlationId} background worker error: ${err instanceof Error ? err.message : String(err)}`)
        })
        return result(ctx, 'ok', JSON.stringify({ spawnId: prep.spawnId, role: prep.role, status: 'running' }), undefined, start)
      }

      const workerResult = await runWorker(prep.workerConfig)
      if (workerResult.status === 'error') {
        return result(ctx, 'error', '', workerResult.error ?? 'worker failed', start)
      }
      return result(ctx, 'ok', JSON.stringify({
        spawnId:       prep.spawnId,
        role:          prep.role,
        status:        workerResult.status,
        artifactId:    workerResult.artifactId,
        tokensUsed:    workerResult.tokensUsed,
        costUsd:       workerResult.costUsd,
        strippedTools: prep.stripped,
      }), undefined, start)
    },
  }
}

interface PreparedWorker {
  workerConfig: Parameters<typeof runWorker>[0]
  spawnId:      string
  role:         string
  stripped:     string[]
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function result(
  ctx: ToolContext,
  status: 'ok' | 'error',
  output: string,
  error: string | undefined,
  start: number
): ToolResult {
  return {
    correlationId: ctx.correlationId,
    toolName: 'subagent_spawn',
    status,
    output,
    error,
    durationMs: Date.now() - start,
  }
}
