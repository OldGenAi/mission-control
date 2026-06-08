/**
 * methods/pipelines.ts — pipeline gateway handlers
 *
 * Security-sensitive. Do not modify without Claude review.
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { readdirSync } from 'node:fs'
import type Database from 'better-sqlite3'
import type { MethodHandler } from '../types.js'
import { registerMethod } from '../router.js'
import { verifyResumeToken } from '../pipeline/approval.js'
import { makePipelineRunner } from '../pipeline/runner.js'
import { loadPipeline } from '../pipeline/loader.js'
import type { PipelineRunRow, PipelineStatus, PipelineRunnerConfig } from '../pipeline/types.js'
import type { SettingsStore, Instance } from '../store/settings.js'
import type { ProviderRegistry } from '../providers/registry.js'

// ---------------------------------------------------------------------------
// Row shape returned by better-sqlite3
// ---------------------------------------------------------------------------

interface ListRow {
  id: string
  name: string
  status: PipelineStatus
  step_id: string | null
  resume_token: string | null
  budget_tokens_used: number
  budget_cost_usd_used: number
  created_at: number
  updated_at: number
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export type PipelineMethodDeps = Omit<PipelineRunnerConfig, 'db' | 'agentId' | 'sessionId' | 'correlationId'> & {
  settingsStore?:    SettingsStore
  providerRegistry?: ProviderRegistry
}

export function registerPipelineMethods(db: Database.Database, deps: PipelineMethodDeps): void {
  const listStmt = db.prepare<[], ListRow>(
    `SELECT id, name, status, step_id, resume_token, budget_tokens_used, budget_cost_usd_used, created_at, updated_at
     FROM pipeline_runs ORDER BY created_at DESC LIMIT 100`
  )

  const getStmt = db.prepare<[string], PipelineRunRow>(
    `SELECT * FROM pipeline_runs WHERE id = ?`
  )

  const updateAbortStmt = db.prepare(
    `UPDATE pipeline_runs
     SET status='aborted', error=?, updated_at=?, revision=revision+1
     WHERE id=? AND status IN ('pending','running','paused')`
  )

  // Resolve provider + model from the LIVE active instance and build a runner
  // config. Shared by pipelines.run (fresh run) and pipelines.approve (resume)
  // so switching instance in the UI takes effect for both.
  function buildRunnerConfig(correlationId: string): PipelineRunnerConfig {
    let provider = deps.provider
    let model    = deps.model
    if (deps.settingsStore && deps.providerRegistry) {
      const s = deps.settingsStore.get()
      // Pipelines run on the dedicated pipeline-type instance when one exists, so a
      // pipeline can use a different model than the chat. Falls back to the active
      // (chat) instance when none is designated — i.e. unchanged behaviour by default.
      const inst = s.instances.find((i: Instance) => i.type === 'pipeline')
                ?? s.instances.find((i: Instance) => i.id === s.activeInstanceId)
      if (inst) {
        const p = deps.providerRegistry.get(inst.provider)
        if (p) { provider = p; model = inst.model }
      }
    }
    return {
      db,
      monitorBuffer: deps.monitorBuffer,
      agentId:       'orchestrator',
      correlationId,
      provider,
      model,
      tools:         deps.tools,
      registry:      deps.registry,
      broadcast:     deps.broadcast,
    }
  }

  // ---------------------------------------------------------------------------
  // pipelines.list
  // ---------------------------------------------------------------------------

  const listPipelines: MethodHandler = async () => {
    const rows = listStmt.all()
    return {
      pipelines: rows.map(r => ({
        id:               r.id,
        name:             r.name,
        status:           r.status,
        currentStepId:    r.step_id,
        resumeToken:      r.resume_token ?? undefined,
        tokensUsed:       r.budget_tokens_used,
        costUsdUsed:      r.budget_cost_usd_used,
        createdAt:        r.created_at,
        updatedAt:        r.updated_at,
      })),
    }
  }

  // ---------------------------------------------------------------------------
  // pipelines.status
  // ---------------------------------------------------------------------------

  const getPipelineStatus: MethodHandler = async (params) => {
    const id = params['id']
    if (typeof id !== 'string' || !id.trim()) return { error: 'id is required' }

    const row = getStmt.get(id)
    if (!row) return { error: 'not found' }

    return {
      pipeline: {
        id:               row.id,
        name:             row.name,
        status:           row.status,
        currentStepId:    row.step_id,
        context:          JSON.parse(row.state_json) as unknown,
        approvalId:       row.approval_id,
        error:            row.error,
        tokensUsed:       row.budget_tokens_used,
        costUsdUsed:      row.budget_cost_usd_used,
        createdAt:        row.created_at,
        updatedAt:        row.updated_at,
      },
    }
  }

  // ---------------------------------------------------------------------------
  // pipelines.run
  // ---------------------------------------------------------------------------

  const runPipeline: MethodHandler = async (params) => {
    const name    = params['name']
    const context = (params['context'] ?? {}) as Record<string, unknown>

    if (typeof name !== 'string' || !name.trim()) return { error: 'name is required' }
    if (typeof context !== 'object' || context === null || Array.isArray(context)) {
      return { error: 'context must be an object' }
    }

    // Load pipeline definition from YAML file
    const pipelineDir = path.join(__dirname, '..', 'pipelines')
    const filePath    = path.join(pipelineDir, `${name}.yaml`)

    let definition
    try {
      definition = loadPipeline(filePath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: `failed to load pipeline "${name}": ${msg}` }
    }

    const correlationId = randomUUID()
    const runner = makePipelineRunner(buildRunnerConfig(correlationId))

    // Fire-and-forget: the run continues in the background and the caller polls
    // pipelines.status for progress. Attach a catch so a background failure is logged
    // rather than becoming an unhandled rejection.
    const runPromise = runner.run(definition, context)
    runPromise.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[pipelines.run] pipeline "${name}" (${correlationId}) failed: ${msg}`)
    })

    // The runner inserts the run row synchronously when it starts. Yield one tick so that
    // insert lands, then read the row back to hand the run id to the caller.
    await new Promise<void>(resolve => setImmediate(resolve))

    // The runner stamps this run with our correlationId on insert, so we look it up by
    // that id directly — no racy name/time-window matching.
    const row = db.prepare<[string], { id: string }>(
      `SELECT id FROM pipeline_runs WHERE correlation_id = ? LIMIT 1`
    ).get(correlationId)

    return { runId: row?.id ?? 'unknown', status: 'running', correlationId }
  }

  // ---------------------------------------------------------------------------
  // pipelines.approve
  // ---------------------------------------------------------------------------

  const approvePipeline: MethodHandler = async (params) => {
    const runId      = params['runId']
    const token      = params['token']
    const decision   = params['decision']

    if (typeof runId !== 'string' || !runId.trim()) return { error: 'runId is required' }
    if (typeof token !== 'string' || !token.trim()) return { error: 'token is required' }
    if (decision !== 'approve' && decision !== 'reject') return { error: 'decision must be "approve" or "reject"' }

    const row = getStmt.get(runId)
    if (!row) return { error: 'run not found' }
    if (row.status !== 'paused') return { error: `run is not paused (status: ${row.status})` }

    // Verify token
    let payload: ReturnType<typeof verifyResumeToken>
    try {
      payload = verifyResumeToken(token)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { error: `invalid token: ${msg}` }
    }

    if (payload.runId !== runId) return { error: 'token run id mismatch' }

    if (decision === 'reject') {
      updateAbortStmt.run('rejected by approver', Date.now(), runId)
      return { runId, status: 'aborted' }
    }

    // approve — reload the definition and actually resume execution. The runner
    // advances past the gate and runs the remaining steps in the background; the
    // caller polls pipelines.status for progress. (Previously this only flipped
    // the DB status to 'running' with nothing watching, so the run hung.)
    if (!row.pipeline_id) {
      return { error: 'cannot resume: run predates resume support (no pipeline_id)' }
    }
    let definition
    try {
      definition = loadPipeline(path.join(__dirname, '..', 'pipelines', `${row.pipeline_id}.yaml`))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: `failed to reload pipeline "${row.pipeline_id}": ${msg}` }
    }

    const runner = makePipelineRunner(buildRunnerConfig(randomUUID()))
    runner.resume(runId, 'approve', token, definition).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[pipelines.approve] resume of run ${runId} failed: ${msg}`)
    })
    return { runId, status: 'running', message: 'pipeline resumed' }
  }

  // ---------------------------------------------------------------------------
  // pipelines.abort
  // ---------------------------------------------------------------------------

  const abortPipeline: MethodHandler = async (params) => {
    const runId = params['runId']
    if (typeof runId !== 'string' || !runId.trim()) return { error: 'runId is required' }

    const row = getStmt.get(runId)
    if (!row) return { error: 'run not found' }
    if (!['pending', 'running', 'paused'].includes(row.status)) {
      return { error: `run cannot be aborted (status: ${row.status})` }
    }

    updateAbortStmt.run('aborted by user', Date.now(), runId)
    return { runId, status: 'aborted' }
  }

  // pipelines.available — read pipeline YAMLs at call time so adding a file in
  // ~/mission-control/gateway/src/pipelines/ surfaces immediately without a code change.
  const PIPELINE_DIR_BUILTIN = path.join(__dirname, '..', 'pipelines')
  const PIPELINE_DIR_USER    = path.join(process.env['HOME'] ?? '', '.missioncontrol', 'pipelines')

  const availablePipelines: MethodHandler = async () => {
    interface Entry { name: string; source: 'builtin' | 'user'; title?: string; description?: string }
    const seen = new Set<string>()
    const entries: Entry[] = []
    for (const [dir, source] of [[PIPELINE_DIR_BUILTIN, 'builtin'], [PIPELINE_DIR_USER, 'user']] as const) {
      try {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
          const name = file.replace(/\.ya?ml$/, '')
          if (seen.has(name)) continue
          seen.add(name)
          try {
            const def = loadPipeline(path.join(dir, file))
            entries.push({ name, source, title: def.name, description: def.description })
          } catch {
            entries.push({ name, source })  // file present but malformed — still list it
          }
        }
      } catch {
        // PIPELINE_DIR_USER may not exist on first boot — skip silently
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    return { pipelines: entries }
  }

  registerMethod('pipelines.available', availablePipelines)
  registerMethod('pipelines.list',   listPipelines)
  registerMethod('pipelines.status', getPipelineStatus)
  registerMethod('pipelines.run',    runPipeline)
  registerMethod('pipelines.approve', approvePipeline)
  registerMethod('pipelines.abort',   abortPipeline)
}
