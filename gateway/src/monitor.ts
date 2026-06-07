import { setInterval, clearInterval } from 'node:timers'
import type Database from 'better-sqlite3'
import { getClient, sendEvent } from './broadcast.js'
import type { WatchdogStats } from './pipeline/watchdog.js'

export interface AgentState {
  agentId: string
  sessionId?: string
  status: string      // 'idle' | 'thinking' | 'tool_running' | 'error' | 'context_warning'
  detail?: string
  correlationId?: string
  contextPct?: number // 0–100, model context fill at the last call
  lastUpdated: number // Date.now()
}

export interface PipelineRow {
  id: string
  name: string
  status: string
  currentStep?: string
  resumeToken?: string
  tokensUsed: number
  costUsdUsed: number
  createdAt: number
  updatedAt: number
}

export interface MemoryStats {
  currentEntries: number      // valid_until IS NULL
  supersededEntries: number   // valid_until IS NOT NULL
  totalBytes: number          // sum(length(content)) of current entries
  lastWriteAt: number | null  // max(valid_from) across all entries
  agentsWithMemory: number    // distinct agent_id with at least one current entry
}

export interface MonitorTick {
  agents: AgentState[]
  pipelines: PipelineRow[]
  timestamp: number
  totalTokens: number
  totalCostUsd: number
  totalToolCalls: number
  totalSessions: number
  activePipelineTokens: number   // live tokens since the active run started (0 when idle)
  activePipelineCostUsd: number  // live cost since the active run started (0 when idle)
  activePipelineToolCalls: number // live tool calls since the active run started (0 when idle)
  activePipelineErrors: number    // live tool errors since the active run started (0 when idle)
  memory: MemoryStats
  watchdog: WatchdogStats | null // live watchdog heartbeat (null until wired)
}

const AGENT_TTL_MS = 5 * 60 * 1000    // backstop: evict any agent not updated for 5 minutes
const SPAWNED_IDLE_TTL_MS = 15 * 1000 // spawned agents (orchestrator-*, worker-*) clear ~15s after they go idle
const PIPELINE_TICK_LIMIT = 20        // most recent pipeline runs per tick
const TICK_INTERVAL_MS = 2000

export class MonitorTracker {
  private agents = new Map<string, AgentState>()
  private subscribers = new Set<string>()  // clientIds
  private timer: NodeJS.Timeout | null = null
  private watchdogStats: (() => WatchdogStats) | null = null
  readonly startedAt: number = Date.now()  // gateway process start — used as session boundary

  constructor(private db: Database.Database) {}

  // Wired in index.ts once the watchdog is started, so each tick carries its heartbeat.
  setWatchdogSource(fn: () => WatchdogStats): void {
    this.watchdogStats = fn
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS)
    // unref so the timer doesn't prevent process exit
    if (this.timer.unref) this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  subscribe(clientId: string): void {
    this.subscribers.add(clientId)
  }

  unsubscribe(clientId: string): void {
    this.subscribers.delete(clientId)
  }

  // Called by the broadcast wrapper in index.ts when agent.status events fire
  updateAgentState(payload: Record<string, unknown>): void {
    const agentId = payload['agentId'] as string | undefined
    if (!agentId) return
    // Only model-call statuses carry contextPct; preserve the last known value
    // on other status updates so the ring holds steady between events.
    const ctx = typeof payload['contextPct'] === 'number'
      ? payload['contextPct'] as number
      : this.agents.get(agentId)?.contextPct
    this.agents.set(agentId, {
      agentId,
      sessionId: payload['sessionId'] as string | undefined,
      status: (payload['status'] as string | undefined) ?? 'idle',
      detail: payload['detail'] as string | undefined,
      correlationId: payload['correlationId'] as string | undefined,
      contextPct: ctx,
      lastUpdated: Date.now(),
    })
  }

  currentTick(): MonitorTick {
    this.evictStaleAgents()
    const pipelines = this.queryPipelines()
    const ss = this.querySessionStats()
    const ts = this.queryToolStats()
    const ms = this.queryMemoryStats()
    // Live usage scoped to the active run, so the Monitor's TOKENS/COST gauges climb
    // during a pipeline and reset between runs (the totals above are since-boot).
    const active = pipelines.find(p => p.status === 'running' || p.status === 'paused')
    const activeStats = active
      ? this.querySessionStats(active.createdAt)
      : { totalTokens: 0, totalCostUsd: 0 }
    // Tool calls + errors scoped to the active run, so the Monitor's counters
    // climb during a pipeline and reset to 0 between runs — same treatment as
    // TOKENS/COST above. The since-boot totals stay available via queryToolStats().
    const activeTools = active ? this.queryToolStats(active.createdAt) : null
    return {
      agents: Array.from(this.agents.values()),
      pipelines,
      timestamp: Date.now(),
      totalTokens: ss.totalTokens,
      totalCostUsd: ss.totalCostUsd,
      totalToolCalls: ts.totalCalls,
      totalSessions: ss.totalSessions,
      activePipelineTokens: activeStats.totalTokens,
      activePipelineCostUsd: activeStats.totalCostUsd,
      activePipelineToolCalls: activeTools?.totalCalls ?? 0,
      activePipelineErrors: activeTools?.errorCount ?? 0,
      memory: ms,
      watchdog: this.watchdogStats ? this.watchdogStats() : null,
    }
  }

  queryMemoryStats(): MemoryStats {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN valid_until IS NULL THEN 1 ELSE 0 END)                    AS current_entries,
        SUM(CASE WHEN valid_until IS NOT NULL THEN 1 ELSE 0 END)                AS superseded_entries,
        COALESCE(SUM(CASE WHEN valid_until IS NULL THEN length(content) END),0) AS total_bytes,
        MAX(valid_from)                                                         AS last_write_at,
        COUNT(DISTINCT CASE WHEN valid_until IS NULL THEN agent_id END)         AS agents_with_memory
      FROM memory_entries
    `).get() as {
      current_entries: number | null
      superseded_entries: number | null
      total_bytes: number | null
      last_write_at: number | null
      agents_with_memory: number | null
    }
    return {
      currentEntries:    row.current_entries ?? 0,
      supersededEntries: row.superseded_entries ?? 0,
      totalBytes:        row.total_bytes ?? 0,
      lastWriteAt:       row.last_write_at,
      agentsWithMemory:  row.agents_with_memory ?? 0,
    }
  }

  private tick(): void {
    if (this.subscribers.size === 0) return
    const payload = this.currentTick() as unknown as Record<string, unknown>
    for (const clientId of this.subscribers) {
      const client = getClient(clientId)
      if (client) {
        sendEvent(client, 'monitor.tick', payload)
      } else {
        // client disconnected — clean up
        this.subscribers.delete(clientId)
      }
    }
  }

  private evictStaleAgents(): void {
    const now = Date.now()
    for (const [agentId, state] of this.agents) {
      // Spawned agents (orchestrator-<id>, worker-<id>) are ephemeral: once they
      // report idle they're finished, so clear them shortly after rather than
      // letting every run's agents pile up for the full backstop window. Dave
      // (tier1_agent) is persistent and keeps the long TTL. Active agents keep
      // updating, so the backstop only reaps ones that died without going idle.
      const spawned = agentId.startsWith('orchestrator') || agentId.startsWith('worker')
      const ttl = spawned && state.status === 'idle' ? SPAWNED_IDLE_TTL_MS : AGENT_TTL_MS
      if (now - state.lastUpdated > ttl) this.agents.delete(agentId)
    }
  }

  queryToolStats(since: number = this.startedAt): { totalCalls: number; lastToolName: string; lastDurationMs: number; errorCount: number; startedAt: number } {
    interface TotalRow { n: number }
    interface LastRow { tool_name: string; duration_ms: number }
    const total = this.db.prepare<[number], TotalRow>(
      'SELECT COUNT(*) as n FROM tool_call_log WHERE created_at >= ?'
    ).get(since) ?? { n: 0 }
    const last = this.db.prepare<[number], LastRow>(
      'SELECT tool_name, duration_ms FROM tool_call_log WHERE created_at >= ? ORDER BY created_at DESC LIMIT 1'
    ).get(since)
    const errors = this.db.prepare<[number], TotalRow>(
      "SELECT COUNT(*) as n FROM tool_call_log WHERE status = 'error' AND created_at >= ?"
    ).get(since) ?? { n: 0 }
    return {
      totalCalls: total.n,
      lastToolName: last?.tool_name ?? '',
      lastDurationMs: last?.duration_ms ?? 0,
      errorCount: errors.n,
      startedAt: this.startedAt,
    }
  }

  querySessionStats(since: number = this.startedAt): { totalTokens: number; totalCostUsd: number; activeSessions: number; totalSessions: number } {
    interface TokRow { tokens: number; cost: number }
    interface CountRow { n: number }
    const tok = this.db.prepare<[number], TokRow>(
      'SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as tokens, COALESCE(SUM(cost_usd), 0.0) as cost FROM model_call_log WHERE created_at >= ?'
    ).get(since) ?? { tokens: 0, cost: 0 }
    const active = this.db.prepare<[number], CountRow>(
      'SELECT COUNT(DISTINCT session_id) as n FROM messages WHERE created_at >= ?'
    ).get(since) ?? { n: 0 }
    const total = this.db.prepare<[number], CountRow>(
      'SELECT COUNT(*) as n FROM sessions WHERE created_at >= ?'
    ).get(since) ?? { n: 0 }
    return {
      totalTokens: tok.tokens,
      totalCostUsd: tok.cost,
      activeSessions: active.n,
      totalSessions: total.n,
    }
  }

  private queryPipelines(): PipelineRow[] {
    interface Row {
      id: string
      name: string
      status: string
      step_id: string | null
      state_json: string | null
      resume_token: string | null
      budget_tokens_used: number
      budget_cost_usd_used: number
      created_at: number
      updated_at: number
    }
    const rows = this.db
      .prepare<[], Row>(
        `SELECT id, name, status, step_id, state_json, resume_token, budget_tokens_used, budget_cost_usd_used, created_at, updated_at
         FROM pipeline_runs
         ORDER BY updated_at DESC
         LIMIT ${PIPELINE_TICK_LIMIT}`
      )
      .all()

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      currentStep: row.step_id ?? undefined,
      resumeToken: row.resume_token ?? undefined,
      tokensUsed: row.budget_tokens_used ?? 0,
      costUsdUsed: row.budget_cost_usd_used ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }
}
