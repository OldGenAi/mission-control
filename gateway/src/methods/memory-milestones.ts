import { registerMethod } from '../router.js'
import type Database from 'better-sqlite3'

interface MilestoneRow {
  id: string
  agent_id: string
  type: string
  key: string
  content: string
  valid_from: number
}

export function registerMemoryMilestonesMethod(db: Database.Database): void {
  const stmt = db.prepare<[], MilestoneRow>(
    `SELECT id, agent_id, type, key, content, valid_from
     FROM memory_entries
     WHERE type = 'milestone' AND valid_until IS NULL
     ORDER BY valid_from DESC
     LIMIT 200`
  )

  registerMethod('memory.milestones', async (_params, _client) => {
    const rows = stmt.all()
    return {
      milestones: rows.map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        key: r.key,
        content: r.content,
        valid_from: r.valid_from,
      })),
    }
  })
}
