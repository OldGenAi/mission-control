/**
 * pipeline/types.ts — Pipeline Runtime type definitions
 *
 * All types here must stay aligned with the pipeline_runs schema in db.ts.
 * DB column names use snake_case. In-memory types use camelCase.
 */

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type PipelineStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted'
export type StepType       = 'llm' | 'spawn_agent' | 'approval_gate' | 'condition' | 'parallel'
export type OnExceedPolicy = 'abort' | 'warn' | 'escalate'

// ---------------------------------------------------------------------------
// Pipeline definition (loaded from YAML — never stored directly)
// ---------------------------------------------------------------------------

export interface BudgetConfig {
  maxTokens?:      number           // total input+output tokens across all steps
  maxCostUsd?:     number           // total cost ceiling
  // wall-clock timeout. Enforced by the runner: a pre-step guard plus a deadline
  // threaded into the worker tier so the orchestrator's spawn loop and every
  // sub-worker stop at the limit. The watchdog's idle check is only a backstop.
  // Ignored when onExceed is 'warn'.
  timeoutSeconds?: number
  onExceed:        OnExceedPolicy
}

export interface StepDefinition {
  id:   string
  type: StepType
  name?: string

  // llm step
  provider?:        string
  model?:           string
  systemPrompt?:    string
  userPrompt?:      string        // may use {{context.key}} placeholders
  outputKey?:       string        // store result under this key in run context
  inputArtifacts?:  string[]      // context keys to include as input
  requiresEvidence?: boolean      // default true for llm steps

  // spawn_agent step
  agentRole?: string
  tools?:     string[]
  task?:      string        // worker task description; supports {{context.key}} placeholders. Overrides context.task.

  // condition step
  condition?: string   // evaluated against context — onTrue/onFalse are step ids
  onTrue?:    string
  onFalse?:   string

  // parallel step
  steps?: StepDefinition[]        // run concurrently, await all

  // approval_gate step
  expiresInSeconds?: number       // default 86400 (24 h)
}

export interface PipelineDefinition {
  id:          string
  name:        string
  description?: string
  version:     string
  budget?:     BudgetConfig
  steps:       StepDefinition[]
}

// ---------------------------------------------------------------------------
// DB row — matches pipeline_runs schema in db.ts exactly
// ---------------------------------------------------------------------------

export interface PipelineRunRow {
  id:                   string
  name:                 string            // display name ("Health Check")
  pipeline_id:          string | null     // YAML file id ("health_check") — null on pre-v5 rows
  status:               PipelineStatus
  revision:             number
  step_id:              string | null   // current step id
  state_json:           string          // JSON-serialised context Record<string,unknown>
  approval_id:          string | null
  resume_token:         string | null
  error:                string | null
  budget_tokens_used:   number
  budget_cost_usd_used: number
  created_at:           number
  updated_at:           number
  launching_session_id: string | null   // chat session that launched this run (for proactive notify)
  launching_agent_id:   string | null   // agent that called pipeline_run
}

// ---------------------------------------------------------------------------
// In-memory run — parsed from PipelineRunRow for use in runner logic
// ---------------------------------------------------------------------------

export interface PipelineRun {
  id:                  string
  name:                string
  pipelineId:          string | null    // YAML file id — needed to reload the definition on resume
  status:              PipelineStatus
  revision:            number
  currentStepId:       string | null
  context:             Record<string, unknown>
  approvalId:          string | null
  resumeToken:         string | null
  error:               string | null
  tokensUsed:          number
  costUsdUsed:         number
  createdAt:           number
  updatedAt:           number
  // Wall-clock ms the run spent paused at approval gates. Subtracted from the
  // timeout budget so a slow human approval doesn't abort the run on resume.
  // In-memory only (recomputed from updated_at at resume); not a DB column.
  pausedMs:            number
  launchingSessionId?: string | null
  launchingAgentId?:   string | null
}

// ---------------------------------------------------------------------------
// Step output envelope — llm steps must include evidence
// ---------------------------------------------------------------------------

export interface StepOutput {
  stepId:     string
  output:     unknown
  evidence?:  string    // mandatory on llm steps — missing = step rejected
  tokensUsed: number
  costUsd:    number
}

// ---------------------------------------------------------------------------
// Resume token payload — HMAC-signed, issued at approval_gate pause
// ---------------------------------------------------------------------------

export interface ResumeTokenPayload {
  runId:     string
  stepId:    string
  decision:  'approve' | 'reject'
  issuedAt:  number
  expiresAt: number
}

// ---------------------------------------------------------------------------
// Runner config — passed to makePipelineRunner
// ---------------------------------------------------------------------------

export interface PipelineRunnerConfig {
  db:            import('better-sqlite3').Database
  monitorBuffer: import('../store/monitor-buffer.js').MonitorBuffer
  agentId:       string
  sessionId?:    string
  correlationId: string
  // Execution dependencies — required for llm + spawn_agent steps
  provider:      import('../providers/types.js').ProviderAdapter
  model:         string
  tools:         Map<string, import('../tools/types.js').RegisteredTool>
  registry:      import('../agents/registry.js').AgentRegistry
  broadcast:     (clientId: string, event: string, payload: Record<string, unknown>) => void
  // Set by `pipeline_run` tool so the runner can persist + fire proactive notify on terminal.
  launchingSessionId?: string
  launchingAgentId?:   string
  // Called once when the run reaches a terminal state (completed/failed/aborted).
  // The notifier wires this to inject a synthetic Dave turn into the launching session.
  onTerminal?: (run: PipelineRun) => void
}
