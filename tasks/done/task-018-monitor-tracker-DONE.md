# Task: MonitorTracker class
**ID:** task-018
**Assigned to:** gemma
**Size:** medium
**Depends on:** nothing — new standalone file

## What to build

Create `gateway/src/monitor.ts` — the MonitorTracker class that aggregates live agent and pipeline state and broadcasts `monitor.tick` every 2 seconds to all subscribed clients.

## File to create

`gateway/src/monitor.ts`

## Spec

### Imports you will need

```typescript
import { setInterval, clearInterval } from 'node:timers'
import type Database from 'better-sqlite3'
import { getClient, sendEvent } from './broadcast.js'
```

### Types

```typescript
export interface AgentState {
  agentId: string
  sessionId?: string
  status: string      // 'idle' | 'thinking' | 'tool_running' | 'error' | 'context_warning'
  detail?: string
  correlationId?: string
  lastUpdated: number // Date.now()
}

export interface PipelineRow {
  id: string
  name: string
  status: string
  currentStep?: string
  tokensUsed: number
  costUsdUsed: number
  createdAt: number
  updatedAt: number
}

export interface MonitorTick {
  agents: AgentState[]
  pipelines: PipelineRow[]
  timestamp: number
}
```

### MonitorTracker class

```typescript
const AGENT_TTL_MS = 5 * 60 * 1000   // evict agents not updated for 5 minutes
const PIPELINE_TICK_LIMIT = 20        // most recent pipeline runs per tick
const TICK_INTERVAL_MS = 2000

export class MonitorTracker {
  private agents = new Map<string, AgentState>()
  private subscribers = new Set<string>()  // clientIds
  private timer: NodeJS.Timeout | null = null

  constructor(private db: Database.Database) {}

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
    this.agents.set(agentId, {
      agentId,
      sessionId: payload['sessionId'] as string | undefined,
      status: (payload['status'] as string | undefined) ?? 'idle',
      detail: payload['detail'] as string | undefined,
      correlationId: payload['correlationId'] as string | undefined,
      lastUpdated: Date.now(),
    })
  }

  currentTick(): MonitorTick {
    this.evictStaleAgents()
    return {
      agents: Array.from(this.agents.values()),
      pipelines: this.queryPipelines(),
      timestamp: Date.now(),
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
    const cutoff = Date.now() - AGENT_TTL_MS
    for (const [agentId, state] of this.agents) {
      if (state.lastUpdated < cutoff) this.agents.delete(agentId)
    }
  }

  private queryPipelines(): PipelineRow[] {
    interface Row {
      id: string
      status: string
      step_id: string | null
      state_json: string | null
      tokens_used: number
      cost_usd_used: number
      created_at: number
      updated_at: number
    }
    const rows = this.db
      .prepare<[], Row>(
        `SELECT id, status, step_id, state_json, tokens_used, cost_usd_used, created_at, updated_at
         FROM pipeline_runs
         ORDER BY updated_at DESC
         LIMIT ${PIPELINE_TICK_LIMIT}`
      )
      .all()

    return rows.map((row) => {
      // Try to extract pipeline name from state_json
      let name = row.id
      try {
        if (row.state_json) {
          const state = JSON.parse(row.state_json) as Record<string, unknown>
          if (typeof state['name'] === 'string') name = state['name']
        }
      } catch { /* ignore */ }

      return {
        id: row.id,
        name,
        status: row.status,
        currentStep: row.step_id ?? undefined,
        tokensUsed: row.tokens_used ?? 0,
        costUsdUsed: row.cost_usd_used ?? 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    })
  }
}
```

## Acceptance criteria

- [ ] File compiles without TypeScript errors
- [ ] `MonitorTracker` class exported
- [ ] `AgentState`, `PipelineRow`, `MonitorTick` types exported
- [ ] `start()` sets up the 2s interval and calls `.unref()` on the timer
- [ ] `stop()` clears the interval
- [ ] `subscribe(clientId)` / `unsubscribe(clientId)` add/remove from subscribers Set
- [ ] `updateAgentState(payload)` updates the agents Map
- [ ] `currentTick()` evicts stale agents, queries pipeline_runs, returns MonitorTick
- [ ] `tick()` skips broadcast if no subscribers, cleans up disconnected clients

## Do not

- Do not import from loop.ts or any method handlers
- Do not modify any existing files — this is a new file only
- Do not add a default export — named export only
- Do not add any other files or folders
- The file goes in `gateway/src/monitor.ts` — NOT inside any subfolder
