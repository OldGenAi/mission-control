import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { AgentRegistry } from '../agents/registry.js'
import type { MonitorBuffer } from '../store/monitor-buffer.js'
import type { ProviderAdapter } from '../providers/types.js'
import { loadPipeline } from '../pipeline/loader.js'
import { makePipelineRunner } from '../pipeline/runner.js'
import type { PipelineRunnerConfig } from '../pipeline/types.js'
import type { RegisteredTool, ToolContext, ToolResult } from './types.js'

export interface PipelineRunToolConfig {
  db:            Database.Database
  registry:      AgentRegistry
  monitorBuffer: MonitorBuffer
  /**
   * Resolves the ACTIVE provider+model at the moment Dave calls pipeline_run.
   * This snapshot then flows through the entire pipeline run (orchestrator +
   * workers all inherit it via ToolContext), so a single pipeline never spans
   * two model lineages. Switching instance in the UI takes effect on the NEXT
   * pipeline_run, mirroring how chat.send already behaves.
   *
   * Falls back to ctx.provider/ctx.model if not provided (the caller's lineage
   * from ToolContext — e.g. when Dave directly calls pipeline_run mid-turn).
   */
  resolveActive?: () => { provider: ProviderAdapter; model: string }
  /** Boot-time defaults — used only if resolveActive isn't wired AND ToolContext lacks them. */
  provider:      ProviderAdapter
  model:         string
  tools:         Map<string, RegisteredTool>
  broadcast:     (clientId: string, event: string, payload: Record<string, unknown>) => void
  // Wired in by index.ts so the runner can call back into the notifier on terminal status.
  onTerminal?: (run: import('../pipeline/types.js').PipelineRun) => void
}

const PIPELINE_DIRS = (homeDir: string): string[] => [
  path.join(__dirname, '..', 'pipelines'),
  path.join(homeDir, '.missioncontrol', 'pipelines'),
]

interface RunStatusRow {
  id: string
  name: string
  status: string
  step_id: string | null
  error: string | null
  budget_tokens_used: number
  budget_cost_usd_used: number
  created_at: number
  updated_at: number
}

export function makePipelineStatusTool(config: { db: Database.Database }): RegisteredTool {
  const query = config.db.prepare<[string], RunStatusRow>(
    `SELECT id, name, status, step_id, error, budget_tokens_used, budget_cost_usd_used, created_at, updated_at
     FROM pipeline_runs WHERE id = ?`,
  )
  const artifacts = config.db.prepare<[string], { id: string; type: string; title: string }>(
    `SELECT id, type, title FROM artifacts WHERE pipeline_run_id = ? ORDER BY created_at ASC`,
  )

  return {
    schema: {
      name: 'pipeline_status',
      description:
        'Check the current status of a previously launched pipeline run. Use this when the user asks whether a pipeline you started has finished, succeeded, or failed. Returns status, step, tokens used, and any artifacts produced. Do NOT call repeatedly to poll — only when the user asks.',
      parameters: {
        type: 'object',
        required: ['runId'],
        properties: {
          runId: { type: 'string', description: 'The runId returned by pipeline_run.' },
        },
      },
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const start = Date.now()
      const runId = args['runId']
      if (typeof runId !== 'string' || !runId.trim()) {
        return { correlationId: ctx.correlationId, toolName: 'pipeline_status', status: 'error', output: '', error: 'PIPELINE_RUN_ID_REQUIRED: runId must be a non-empty string', durationMs: Date.now() - start }
      }
      const row = query.get(runId)
      if (!row) {
        return { correlationId: ctx.correlationId, toolName: 'pipeline_status', status: 'error', output: '', error: `PIPELINE_RUN_NOT_FOUND: no pipeline run with id "${runId}"`, durationMs: Date.now() - start }
      }
      const arts = artifacts.all(runId)
      const payload = {
        runId: row.id,
        name: row.name,
        status: row.status,
        currentStep: row.step_id,
        error: row.error,
        tokensUsed: row.budget_tokens_used,
        costUsd: row.budget_cost_usd_used,
        durationSeconds: Math.round((row.updated_at - row.created_at) / 1000),
        artifacts: arts,
      }
      return { correlationId: ctx.correlationId, toolName: 'pipeline_status', status: 'ok', output: JSON.stringify(payload), durationMs: Date.now() - start }
    },
  }
}

export function makePipelineRunTool(config: PipelineRunToolConfig): RegisteredTool {
  return {
    schema: {
      name: 'pipeline_run',
      description:
        'Launch a deterministic pipeline by name. Returns the runId so the user can track progress on the Pipelines page. Use when a task needs multi-step orchestration, research with sources, or specialist worker handoff. List with the Pipelines tab to discover available pipelines.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name:    { type: 'string', description: 'Pipeline filename without extension, e.g. "research_task".' },
          context: { type: 'object', description: 'Optional context passed into the pipeline (e.g. { task: "..." }).' },
        },
      },
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const start = Date.now()
      const name  = args['name']
      const passedContext = (args['context'] ?? {}) as unknown
      if (typeof name !== 'string' || !name.trim()) {
        return { correlationId: ctx.correlationId, toolName: 'pipeline_run', status: 'error', output: '', error: 'PIPELINE_NAME_REQUIRED: name must be a non-empty string', durationMs: Date.now() - start }
      }
      if (typeof passedContext !== 'object' || passedContext === null || Array.isArray(passedContext)) {
        return { correlationId: ctx.correlationId, toolName: 'pipeline_run', status: 'error', output: '', error: 'PIPELINE_CONTEXT_INVALID: context must be a plain object', durationMs: Date.now() - start }
      }

      // Try builtin then user pipelines dir — first hit wins.
      let definition
      for (const dir of PIPELINE_DIRS(process.env['HOME'] ?? '')) {
        const filePath = path.join(dir, `${name}.yaml`)
        try {
          definition = loadPipeline(filePath)
          break
        } catch {
          continue
        }
      }
      if (!definition) {
        return { correlationId: ctx.correlationId, toolName: 'pipeline_run', status: 'error', output: '', error: `PIPELINE_NOT_FOUND: no pipeline named "${name}" in builtin or user pipelines directory`, durationMs: Date.now() - start }
      }

      const correlationId = randomUUID()

      // Resolve the LIVE active provider+model for this pipeline run.
      // Priority: explicit resolver (live settings lookup) → ToolContext caller's
      // lineage (Dave's resolved values) → boot-time fallback. The resolved
      // snapshot flows through runnerConfig → spawn_agent step → runWorker →
      // worker-loop, and via ToolContext to any nested subagent_spawn. One
      // model lineage per pipeline, picked fresh at launch time.
      let activeProvider = config.provider
      let activeModel    = config.model
      if (config.resolveActive) {
        try {
          const r = config.resolveActive()
          activeProvider = r.provider
          activeModel    = r.model
        } catch (e) {
          console.warn(`[pipeline_run] resolveActive failed, using fallback:`, e instanceof Error ? e.message : e)
        }
      } else if (ctx.provider && ctx.model) {
        activeProvider = ctx.provider
        activeModel    = ctx.model
      }

      const runnerConfig: PipelineRunnerConfig = {
        db:            config.db,
        monitorBuffer: config.monitorBuffer,
        agentId:       'orchestrator',
        correlationId,
        provider:      activeProvider,
        model:         activeModel,
        tools:         config.tools,
        registry:      config.registry,
        broadcast:     config.broadcast,
        // Track who launched this run so the proactive notifier can wake Dave when it finishes.
        ...(ctx.sessionId ? { launchingSessionId: ctx.sessionId } : {}),
        ...(ctx.agentId   ? { launchingAgentId:   ctx.agentId   } : {}),
        ...(config.onTerminal ? { onTerminal: config.onTerminal } : {}),
      }

      const runner = makePipelineRunner(runnerConfig)
      // Fire-and-forget — Dave gets the runId immediately, the runner finishes in background.
      runner.run(definition, passedContext as Record<string, unknown>).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[pipeline_run] cid=${correlationId} pipeline "${name}" failed: ${msg}`)
      })

      // Poll for the inserted pipeline_runs row — the runner inserts it early in run(),
      // typically within a few ms. Cap at ~200ms so a wedged runner doesn't hang the tool.
      // The runner stamps the row with our correlationId, so we look it up by that —
      // unambiguous, no racy name/time-window match.
      const query = config.db.prepare<[string], { id: string }>(
        `SELECT id FROM pipeline_runs WHERE correlation_id = ? LIMIT 1`,
      )
      let runId: string | null = null
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise<void>(r => setTimeout(r, 10))
        const row = query.get(correlationId)
        if (row?.id) { runId = row.id; break }
      }
      if (!runId) console.warn(`[pipeline_run] cid=${correlationId} runner did not insert row within 200ms`)

      return {
        correlationId: ctx.correlationId,
        toolName: 'pipeline_run',
        status: 'ok',
        output: JSON.stringify({ runId, name, correlationId, status: 'running' }),
        durationMs: Date.now() - start,
      }
    },
  }
}
