import { randomUUID } from 'node:crypto'
import { registerMethod } from '../router.js'
import type Database from 'better-sqlite3'

interface EntryRow {
  id: string
  content: string
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

export function registerMemoryIdentityMethods(db: Database.Database): void {
  const getStmt = db.prepare<[string, string], EntryRow>(
    `SELECT id, content FROM memory_entries
     WHERE agent_id = ? AND key = ? AND valid_until IS NULL
     LIMIT 1`
  )

  const insertStmt = db.prepare(
    `INSERT INTO memory_entries (id, agent_id, key, content, type, valid_from, valid_until)
     VALUES (?, ?, ?, ?, 'fact', ?, NULL)`
  )

  const supersedeStmt = db.prepare(
    `UPDATE memory_entries SET valid_until = ? WHERE id = ?`
  )

  // memory.identity — read soul, agents, identity, daily note for an agent
  registerMethod('memory.identity', async (params) => {
    const agentId = (params as { agentId?: string }).agentId ?? 'tier1_agent'
    const today = todayKey()
    const get = (key: string): string => getStmt.get(agentId, key)?.content ?? ''
    return {
      soul:      get('soul'),
      agents:    get('agents'),
      identity:  get('identity'),
      user:      get('user'),
      dailyNote: get(today),
      dailyKey:  today,
    }
  })

  // memory.identity.set — upsert a single identity key (creates new or supersedes existing).
  // UI/method-only: agents call the memory_* TOOLS (which enforce per-key caps), never this
  // method, so this trusted user-driven edit is deliberately uncapped. Capping what the user
  // may set for Dave's soul/identity would be wrong, not safer.
  registerMethod('memory.identity.set', async (params) => {
    const { agentId = 'tier1_agent', key, content } = params as {
      agentId?: string
      key: string
      content: string
    }
    if (!key || typeof content !== 'string') throw new Error('key and content are required')

    const now = Date.now()
    const existing = getStmt.get(agentId, key)
    if (existing) {
      db.transaction(() => {
        supersedeStmt.run(now, existing.id)
        insertStmt.run(randomUUID(), agentId, key, content, now)
      })()
    } else {
      insertStmt.run(randomUUID(), agentId, key, content, now)
    }
    return { ok: true }
  })
}
