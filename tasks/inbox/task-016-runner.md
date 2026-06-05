# Task: Pipeline Runner
**ID:** task-016
**Assigned to:** openrouter
**Size:** large
**Working directory:** `/users/jb/mission-control/gateway`

## File to create

`src/pipeline/runner.ts`

## What it does

Executes a PipelineDefinition step by step. Creates and updates a row in `pipeline_runs`. Enforces budget. Tracks tokens and cost. Persists state to SQLite after every step so a crash can be resumed.

## Imports

```typescript
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  PipelineDefinition, PipelineRunnerConfig, PipelineRunRow, PipelineRun,
  StepDefinition, StepOutput, PipelineStatus, OnExceedPolicy
} from './types.js'
```

## Export

```typescript
export function makePipelineRunner(config: PipelineRunnerConfig) {
  return { run, resume }
}
```

`run` and `resume` are defined inside the factory and close over `config`.

---

## run(definition, initialContext)

Signature:
```typescript
async function run(
  definition: PipelineDefinition,
  initialContext: Record<string, unknown>
): Promise<PipelineRun>
```

### Steps

1. **Create DB row** — INSERT INTO pipeline_runs with:
   - id: randomUUID()
   - name: definition.name
   - status: 'running'
   - revision: 0
   - step_id: definition.steps[0]?.id ?? null
   - state_json: JSON.stringify(initialContext)
   - approval_id: null, resume_token: null, error: null
   - budget_tokens_used: 0, budget_cost_usd_used: 0.0
   - created_at / updated_at: Date.now()

2. **Execute steps** — call `executeSteps(run, definition)`

3. **Return** the final in-memory PipelineRun

---

## resume(runId, decision, resumeToken)

Signature:
```typescript
async function resume(
  runId: string,
  decision: 'approve' | 'reject',
  resumeToken: string
): Promise<PipelineRun>
```

1. Load the run row from DB — error if not found or status !== 'paused'
2. Verify the resume token matches the stored resume_token column — if mismatch, throw `Error('invalid resume token')`
3. If decision === 'reject': mark run as 'aborted', return
4. If decision === 'approve': clear approval_id and resume_token, set status back to 'running', increment revision, call `executeSteps(run, definition)` — **you will need to reload the definition from DB name** — for Phase 6 just accept definition as a parameter to resume too:
   ```typescript
   async function resume(runId: string, decision: 'approve' | 'reject', resumeToken: string, definition: PipelineDefinition): Promise<PipelineRun>
   ```

---

## executeSteps(run, definition)

Internal function — not exported.

```typescript
async function executeSteps(run: PipelineRun, definition: PipelineDefinition): Promise<PipelineRun>
```

1. Find the starting step: find the step in definition.steps whose id === run.currentStepId
2. Loop from that step forward through the steps array in order
3. For each step, call `executeStep(run, step, definition)`
4. After each step returns a StepOutput:
   - Update `run.context[step.outputKey]` if outputKey is set
   - Add tokensUsed and costUsd to run.tokensUsed / run.costUsdUsed
   - **Check budget** (see Budget Enforcement below)
   - Persist run to DB (see Persistence below)
   - If step.type === 'approval_gate': update status to 'paused', set run.currentStepId to step.id, persist, BREAK (return early, run is now paused)
5. When all steps complete without pause: set status to 'completed', set currentStepId to null, persist, return

---

## executeStep(run, step, definition)

Internal. Returns `StepOutput`.

### llm step
- Log to console: `[runner] ${run.id} executing llm step ${step.id}`
- Build the userPrompt: replace `{{context.KEY}}` placeholders with values from run.context
- Call `config.monitorBuffer.enqueue({ kind: 'model_call', correlationId: config.correlationId, agentId: config.agentId, sessionId: config.sessionId, provider: step.provider ?? 'local', model: step.model ?? 'unknown', inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 })` — Phase 6 stubs tokens/cost at 0, real provider call is Phase 7
- For Phase 6: return a stub output `{ stepId: step.id, output: { text: '[llm stub — Phase 7 wires real provider]', evidence: 'stub evidence for Phase 6 test' }, evidence: 'stub evidence for Phase 6 test', tokensUsed: 100, costUsd: 0.001 }`
- Evidence check: if `step.requiresEvidence !== false` and output.evidence is missing or empty: return error StepOutput with tokensUsed:0, costUsd:0, evidence:undefined — set run.status='failed', run.error='llm step missing evidence', persist, throw

### approval_gate step
- Generate approvalId = randomUUID()
- Set `run.approvalId = approvalId`
- Set `run.resumeToken` — for Phase 6 use a simple string: `Buffer.from(JSON.stringify({ runId: run.id, stepId: step.id, issuedAt: Date.now() })).toString('base64')`
- Return `{ stepId: step.id, output: { approvalId, paused: true }, tokensUsed: 0, costUsd: 0 }`
- The calling loop detects this and sets status to 'paused'

### spawn_agent step
- Log: `[runner] ${run.id} spawn_agent step ${step.id} — stub (Phase 6.6)`
- Return `{ stepId: step.id, output: { stub: true }, tokensUsed: 0, costUsd: 0 }`

### condition step
- Log: `[runner] ${run.id} condition step ${step.id} — stub`
- Return `{ stepId: step.id, output: { stub: true }, tokensUsed: 0, costUsd: 0 }`

### parallel step
- Log: `[runner] ${run.id} parallel step ${step.id} — running sequentially for Phase 6`
- Execute nested steps sequentially (not actually parallel yet), accumulate outputs
- Return `{ stepId: step.id, output: { results: outputs }, tokensUsed: total, costUsd: total }`

---

## Budget Enforcement

After each step's output is collected:

```typescript
function checkBudget(run: PipelineRun, definition: PipelineDefinition): 'ok' | OnExceedPolicy {
  const b = definition.budget
  if (!b) return 'ok'
  if (b.maxTokens && run.tokensUsed > b.maxTokens) return b.onExceed
  if (b.maxCostUsd && run.costUsdUsed > b.maxCostUsd) return b.onExceed
  return 'ok'
}
```

If checkBudget returns anything other than 'ok':
- `'abort'`: set run.status='aborted', run.error=`budget exceeded`, persist, throw Error('budget exceeded')
- `'warn'`: log warning to console, continue
- `'escalate'`: same as abort for Phase 6 (escalation routing is Phase 7+)

---

## Persistence

All DB writes use optimistic locking via the revision field.

**updateRun(run)**:
```typescript
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
    run.revision + 1,  // next revision
    run.id,
    run.revision       // WHERE revision = current (optimistic lock)
  )
  if (result.changes === 0) throw new Error(`optimistic lock conflict on run ${run.id}`)
  run.revision++
  run.updatedAt = Date.now()
}
```

Prepare `updateStmt` once at the top of `makePipelineRunner`:
```sql
UPDATE pipeline_runs
SET status=?, step_id=?, state_json=?, approval_id=?, resume_token=?,
    error=?, budget_tokens_used=?, budget_cost_usd_used=?, updated_at=?,
    revision=?
WHERE id=? AND revision=?
```

Also prepare `insertStmt` and `selectStmt` once at top of factory.

---

## rowToRun(row) helper

Converts a PipelineRunRow to a PipelineRun:
```typescript
function rowToRun(row: PipelineRunRow): PipelineRun {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
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
  }
}
```

---

## Rules

- No `any` types — use `unknown` with narrowing
- Zero TypeScript errors
- Prepare ALL statements once at the top of `makePipelineRunner` — never inside functions
- `catch (e: unknown)` not `catch (e: any)`
- No comments unless non-obvious
- The file should be self-contained — do not import loader.ts (runner receives the parsed definition, doesn't load YAML itself)
