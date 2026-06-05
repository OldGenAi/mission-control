import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  PipelineDefinition,
  PipelineRunnerConfig,
  PipelineRunRow,
  PipelineRun,
  StepDefinition,
  StepOutput,
  PipelineStatus,
  OnExceedPolicy,
} from './types.js';
import { issueResumeToken } from './approval.js';
import { evaluateCondition } from './safe-expr.js';
import { runWorker } from '../worker-loop.js';

export function makePipelineRunner(config: PipelineRunnerConfig) {
  const TERMINAL_STATUSES: PipelineStatus[] = ['completed', 'failed', 'aborted'];

  // prepare statements
  const insertStmt = config.db.prepare(
    `INSERT INTO pipeline_runs (id, name, pipeline_id, status, revision, step_id, state_json, approval_id, resume_token, error, budget_tokens_used, budget_cost_usd_used, created_at, updated_at, launching_session_id, launching_agent_id, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const selectStmt = config.db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`);
  const updateStmt = config.db.prepare(
    `UPDATE pipeline_runs
     SET status=?, step_id=?, state_json=?, approval_id=?, resume_token=?, error=?, budget_tokens_used=?, budget_cost_usd_used=?, updated_at=?, revision=?
     WHERE id=? AND revision=?`
  );

  function rowToRun(row: PipelineRunRow): PipelineRun {
    return {
      id: row.id,
      name: row.name,
      pipelineId: row.pipeline_id,
      status: row.status as PipelineStatus,
      revision: row.revision,
      currentStepId: row.step_id,
      context: JSON.parse(row.state_json) as Record<string, unknown>,
      approvalId: row.approval_id,
      resumeToken: row.resume_token,
      error: row.error,
      tokensUsed: row.budget_tokens_used,
      costUsdUsed: row.budget_cost_usd_used,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      pausedMs: 0,
      launchingSessionId: row.launching_session_id,
      launchingAgentId: row.launching_agent_id,
    };
  }

  let terminalFired = false;
  function updateRun(run: PipelineRun): void {
    const result = updateStmt.run(
      run.status,
      run.currentStepId ?? null,
      JSON.stringify(run.context),
      run.approvalId ?? null,
      run.resumeToken ?? null,
      run.error ?? null,
      run.tokensUsed,
      run.costUsdUsed,
      Date.now(),
      run.revision + 1,
      run.id,
      run.revision
    );
    if (result.changes === 0) throw new Error(`optimistic lock conflict on run ${run.id}`);
    run.revision++;
    run.updatedAt = Date.now();
    // Fire the proactive-notify callback once, on the first transition into a terminal status.
    if (!terminalFired && TERMINAL_STATUSES.includes(run.status) && config.onTerminal) {
      terminalFired = true;
      try { config.onTerminal(run); }
      catch (e) { console.error(`[runner] ${run.id} onTerminal callback threw:`, e); }
    }
  }

  type BudgetCheck = { ok: true } | { ok: false; policy: OnExceedPolicy; message: string }

  function checkBudget(run: PipelineRun, definition: PipelineDefinition): BudgetCheck {
    const b = definition.budget;
    if (!b) return { ok: true };
    if (b.maxTokens && run.tokensUsed > b.maxTokens) {
      return { ok: false, policy: b.onExceed, message: `budget exceeded: ${run.tokensUsed.toLocaleString()} tokens used / ${b.maxTokens.toLocaleString()} limit` };
    }
    if (b.maxCostUsd && run.costUsdUsed > b.maxCostUsd) {
      return { ok: false, policy: b.onExceed, message: `budget exceeded: $${run.costUsdUsed.toFixed(4)} used / $${b.maxCostUsd.toFixed(4)} limit` };
    }
    return { ok: true };
  }

  async function executeStep(run: PipelineRun, step: StepDefinition, definition: PipelineDefinition): Promise<StepOutput> {
    switch (step.type) {
      case 'llm': {
        console.log(`[runner] ${run.id} executing llm step ${step.id}`);

        // Interpolate {{context.KEY}} placeholders in userPrompt
        const rawPrompt = step.userPrompt ?? ''
        const userPrompt = rawPrompt.replace(
          /\{\{context\.(\w+)\}\}/g,
          (_: string, key: string) => String(run.context[key] ?? '')
        )

        const callStart = Date.now()
        let inputTokens = 0
        let outputTokens = 0
        let responseText = ''

        const stream = config.provider.complete({
          model:         step.model ?? config.model,
          messages: [
            ...(step.systemPrompt ? [{ role: 'system' as const, content: step.systemPrompt }] : []),
            { role: 'user' as const, content: userPrompt },
          ],
          correlationId: config.correlationId,
        })

        for await (const chunk of stream) {
          if (chunk.type === 'text_delta') responseText += chunk.delta
          if (chunk.type === 'done') {
            inputTokens  = chunk.usage.inputTokens
            outputTokens = chunk.usage.outputTokens
            config.monitorBuffer.enqueue({
              kind:          'model_call',
              correlationId: config.correlationId,
              agentId:       config.agentId,
              sessionId:     config.sessionId,
              provider:      config.provider.name,
              model:         step.model ?? config.model,
              inputTokens,
              outputTokens,
              costUsd:       0,
              durationMs:    Date.now() - callStart,
            })
          }
        }

        const tokensUsed = inputTokens + outputTokens

        if (step.requiresEvidence !== false && !responseText.trim()) {
          run.status = 'failed'
          run.error  = `llm step "${step.id}" returned empty response`
          updateRun(run)
          throw new Error(run.error)
        }

        return {
          stepId:     step.id,
          output:     { text: responseText },
          evidence:   responseText.slice(0, 120),
          tokensUsed,
          costUsd:    0,
        };
      }
      case 'approval_gate': {
        const approvalId = randomUUID();
        run.approvalId = approvalId;
        run.resumeToken = issueResumeToken(run.id, step.id, 'approve', step.expiresInSeconds);
        return { stepId: step.id, output: { approvalId, paused: true }, tokensUsed: 0, costUsd: 0 };
      }
      case 'spawn_agent': {
        const role = step.agentRole
        if (!role) throw new Error(`spawn_agent step "${step.id}" missing agentRole`)

        console.log(`[runner] ${run.id} spawn_agent step ${step.id} role=${role}`)

        // Resolve inputArtifact IDs — values stored in context under prior step outputKeys
        const inputArtifacts: string[] = []
        if (step.inputArtifacts) {
          for (const key of step.inputArtifacts) {
            const val = run.context[key]
            if (typeof val === 'string') inputArtifacts.push(val)
          }
        }

        // Resolve worker task — step.task wins (with {{context.KEY}} interpolation),
        // otherwise fall back to context.task, otherwise a placeholder.
        const taskFromStep = step.task
          ? step.task.replace(
              /\{\{context\.(\w+)\}\}/g,
              (_: string, key: string) => String(run.context[key] ?? ''),
            )
          : null
        const workerTask = taskFromStep
          ?? (typeof run.context['task'] === 'string' ? String(run.context['task']) : null)
          ?? `Execute step ${step.id}`

        // Wall-clock deadline threaded into the worker tier so the orchestrator's
        // spawn loop (and every sub-worker) stops at budget.timeoutSeconds instead
        // of grinding until the 15-min watchdog. Skipped when onExceed is 'warn'.
        const timeoutSeconds = definition.budget?.timeoutSeconds
        const deadline = timeoutSeconds && definition.budget!.onExceed !== 'warn'
          ? run.createdAt + run.pausedMs + timeoutSeconds * 1000
          : undefined

        const workerResult = await runWorker({
          role,
          task:            workerTask,
          allowedTools:    step.tools ?? config.registry.get(role)?.allowedTools.slice() ?? [],
          inputArtifacts:  inputArtifacts.length > 0 ? inputArtifacts : undefined,
          context:         run.context,
          correlationId:   config.correlationId,
          pipelineRunId:   run.id,
          stepId:          step.id,
          db:              config.db,
          registry:        config.registry,
          provider:        config.provider,
          model:           step.model ?? config.model,
          tools:           config.tools,
          monitorBuffer:   config.monitorBuffer,
          broadcast:       config.broadcast,
          ...(deadline ? { deadline } : {}),
        })

        if (workerResult.status === 'error') {
          run.status = 'failed'
          run.error  = `spawn_agent step "${step.id}" worker error: ${workerResult.error ?? 'unknown'}`
          updateRun(run)
          throw new Error(run.error)
        }

        return {
          stepId:     step.id,
          output:     { artifactId: workerResult.artifactId, status: workerResult.status },
          tokensUsed: workerResult.tokensUsed,
          costUsd:    workerResult.costUsd,
        };
      }
      case 'condition': {
        if (!step.condition) throw new Error(`condition step "${step.id}" missing condition expression`)
        const substituted = step.condition.replace(
          /\{\{context\.(\w+)\}\}/g,
          (_: string, key: string) => JSON.stringify(run.context[key] ?? null)
        )
        let result: boolean
        try {
          // Fail-closed evaluator — no eval/new Function, so an interpolated value (even one
          // shaped by an agent) can never reach code execution. Future-proofs the L3 builder.
          result = evaluateCondition(substituted)
        } catch (e) {
          throw new Error(`condition step "${step.id}" evaluation failed: ${e instanceof Error ? e.message : String(e)}`)
        }
        const nextStepId = result ? (step.onTrue ?? null) : (step.onFalse ?? null)
        return { stepId: step.id, output: { result, nextStepId }, tokensUsed: 0, costUsd: 0 }
      }
      case 'parallel': {
        const subSteps = step.steps ?? []
        const outputs = await Promise.all(subSteps.map(sub => executeStep(run, sub, definition)))
        const totalTokens = outputs.reduce((sum, o) => sum + o.tokensUsed, 0)
        const totalCost   = outputs.reduce((sum, o) => sum + o.costUsd, 0)
        return { stepId: step.id, output: { results: outputs.map(o => o.output) }, tokensUsed: totalTokens, costUsd: totalCost }
      }
      default:
        throw new Error(`unknown step type: ${String((step as { type: unknown }).type)}`);
    }
  }

  async function executeSteps(run: PipelineRun, definition: PipelineDefinition): Promise<PipelineRun> {
    const startIdx = definition.steps.findIndex(s => s.id === run.currentStepId);
    let i = startIdx >= 0 ? startIdx : 0;

    while (i < definition.steps.length) {
      // Wall-clock timeout guard — abort before starting another step past the
      // declared budget.timeoutSeconds (unless onExceed is just 'warn'). pausedMs
      // (time spent waiting at an approval gate) is excluded so a slow human
      // approval doesn't count against the run's active-execution budget.
      const tSec = definition.budget?.timeoutSeconds;
      if (tSec && definition.budget!.onExceed !== 'warn' && (Date.now() - run.createdAt - run.pausedMs) > tSec * 1000) {
        run.status = 'aborted';
        run.error  = `pipeline timeout: run exceeded ${tSec}s wall-clock`;
        updateRun(run);
        throw new Error(run.error);
      }
      const step = definition.steps[i];
      const output = await executeStep(run, step, definition);
      if (step.outputKey) {
        (run.context as Record<string, unknown>)[step.outputKey] = output.output;
      }
      run.tokensUsed  += output.tokensUsed;
      run.costUsdUsed += output.costUsd;

      const budget = checkBudget(run, definition);
      if (!budget.ok) {
        if (budget.policy === 'abort' || budget.policy === 'escalate') {
          run.status = 'aborted';
          run.error  = budget.message;
          updateRun(run);
          throw new Error(run.error);
        }
        console.warn(`[runner] budget warning for run ${run.id}: ${budget.message}`);
      }

      run.currentStepId = step.id;
      updateRun(run);

      if (step.type === 'approval_gate') {
        run.status = 'paused';
        updateRun(run);
        break;
      }

      if (step.type === 'condition') {
        const nextStepId = (output.output as Record<string, unknown>)?.['nextStepId']
        if (typeof nextStepId === 'string') {
          const nextIdx = definition.steps.findIndex(s => s.id === nextStepId)
          if (nextIdx === -1) throw new Error(`condition step "${step.id}" targets unknown step "${nextStepId}"`)
          i = nextIdx
          continue
        }
        // null nextStepId means no branch — fall through to next step
      }

      i++;
    }

    if (run.status !== 'paused') {
      run.status = 'completed';
      run.currentStepId = null;
      updateRun(run);
    }
    return run;
  }

  async function run(definition: PipelineDefinition, initialContext: Record<string, unknown>): Promise<PipelineRun> {
    const now = Date.now();
    const id = randomUUID();
    const firstStepId = definition.steps[0]?.id ?? null;
    insertStmt.run(
      id,
      definition.name,
      definition.id,
      'running',
      0,
      firstStepId,
      JSON.stringify(initialContext),
      null,
      null,
      null,
      0,
      0.0,
      now,
      now,
      config.launchingSessionId ?? null,
      config.launchingAgentId ?? null,
      config.correlationId
    );
    const row = selectStmt.get(id) as PipelineRunRow;
    const runObj = rowToRun(row);
    await executeSteps(runObj, definition);
    return runObj;
  }

  async function resume(runId: string, decision: 'approve' | 'reject', resumeToken: string, definition: PipelineDefinition): Promise<PipelineRun> {
    const row = selectStmt.get(runId) as PipelineRunRow | undefined;
    if (!row) throw new Error('run not found');
    const run = rowToRun(row);
    if (run.status !== 'paused') throw new Error('run not paused');
    if (run.resumeToken !== resumeToken) throw new Error('invalid resume token');
    if (decision === 'reject') {
      run.status = 'aborted';
      updateRun(run);
      return run;
    }
    // approve path — advance past the gate before resuming.
    // Discount the wall-clock time this run sat paused at the gate so a slow
    // human approval doesn't burn budget.timeoutSeconds. run.updatedAt is the
    // pause timestamp — nothing writes the row while it's paused (survives a
    // gateway restart). Single-gate pipelines only; a second gate would reset
    // this rather than accumulate, which merely makes the timeout slightly stricter.
    run.pausedMs = Date.now() - run.updatedAt;
    const gateIdx = definition.steps.findIndex(s => s.id === run.currentStepId);
    const nextIdx = gateIdx + 1;
    run.approvalId = null;
    run.resumeToken = null;

    if (nextIdx >= definition.steps.length) {
      run.status = 'completed';
      run.currentStepId = null;
      updateRun(run);
      return run;
    }

    run.currentStepId = definition.steps[nextIdx].id;
    run.status = 'running';
    updateRun(run);
    await executeSteps(run, definition);
    return run;
  }

  return { run, resume } as const;
}
