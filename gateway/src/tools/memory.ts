import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { RegisteredTool, ToolContext, ToolResult } from './types.js'
import { checkCap } from '../memory/store.js'

interface MemoryRow {
  id: string
  key: string
  content: string
  type: string
  valid_from: number
}

export function makeMemoryTools(db: Database.Database): RegisteredTool[] {
  const insertStmt = db.prepare(
    `INSERT INTO memory_entries (id, agent_id, key, content, type, valid_from, valid_until)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`
  )
  const currentEntryStmt = db.prepare<[string, string], MemoryRow>(
    `SELECT id, key, content, type, valid_from FROM memory_entries
     WHERE agent_id = ? AND key = ? AND valid_until IS NULL`
  )
  const searchStmt = db.prepare<[string, string, number], MemoryRow>(
    `SELECT id, key, content, type, valid_from FROM memory_entries
     WHERE agent_id = ? AND valid_until IS NULL AND content LIKE ? LIMIT ?`
  )
  const supersedeStmt = db.prepare(
    `UPDATE memory_entries SET valid_until = ? WHERE id = ?`
  )
  const promoteStmt = db.prepare(
    `UPDATE memory_entries SET type = 'milestone' WHERE id = ?`
  )

  function ok(ctx: ToolContext, toolName: string, data: unknown, start: number): ToolResult {
    return { correlationId: ctx.correlationId, toolName, status: 'ok', output: JSON.stringify(data), durationMs: Date.now() - start }
  }
  function err(ctx: ToolContext, toolName: string, msg: string, start: number): ToolResult {
    return { correlationId: ctx.correlationId, toolName, status: 'error', output: '', error: msg, durationMs: Date.now() - start }
  }

  const memory_write: RegisteredTool = {
    schema: {
      name: 'memory_write',
      description: 'Store a new memory entry. Returns the entry id.',
      parameters: {
        type: 'object',
        required: ['key', 'content'],
        properties: {
          key:     { type: 'string', description: 'Unique key for this memory.' },
          content: { type: 'string', description: 'Content to store.' },
          type:    { type: 'string', description: 'Entry type: "fact" (default) or "milestone". Use "milestone" for significant achievements to display in the Memory tab.' },
        },
      },
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const start = Date.now()
      const key = args['key']
      const content = args['content']
      const entryType = typeof args['type'] === 'string' ? args['type'] : 'fact'
      if (typeof key !== 'string' || !key.trim()) return err(ctx, 'memory_write', 'key must be a non-empty string', start)
      if (typeof content !== 'string') return err(ctx, 'memory_write', 'content must be a string', start)
      const capErr = checkCap(key, content)
      if (capErr) return err(ctx, 'memory_write', capErr, start)
      try {
        const id = randomUUID()
        insertStmt.run(id, ctx.agentId, key, content, entryType, Date.now())
        return ok(ctx, 'memory_write', { id }, start)
      } catch (e) {
        return err(ctx, 'memory_write', e instanceof Error ? e.message : String(e), start)
      }
    },
  }

  const memory_get: RegisteredTool = {
    schema: {
      name: 'memory_get',
      description: 'Get the current memory entry for a key. Returns the entry or null.',
      parameters: {
        type: 'object',
        required: ['key'],
        properties: {
          key: { type: 'string', description: 'Key to look up.' },
        },
      },
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const start = Date.now()
      const key = args['key']
      if (typeof key !== 'string' || !key.trim()) return err(ctx, 'memory_get', 'key must be a non-empty string', start)
      try {
        const row = currentEntryStmt.get(ctx.agentId, key)
        const entry = row ? { id: row.id, key: row.key, content: row.content, validFrom: row.valid_from } : null
        return ok(ctx, 'memory_get', { entry }, start)
      } catch (e) {
        return err(ctx, 'memory_get', e instanceof Error ? e.message : String(e), start)
      }
    },
  }

  const memory_search: RegisteredTool = {
    schema: {
      name: 'memory_search',
      description: 'Search current memory entries by content substring.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Substring to search for in content.' },
          limit: { type: 'number', description: 'Max results, default 10, max 20.' },
        },
      },
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const start = Date.now()
      const query = args['query']
      if (typeof query !== 'string') return err(ctx, 'memory_search', 'query must be a string', start)
      const limit = Math.min(typeof args['limit'] === 'number' ? args['limit'] : 10, 20)
      try {
        const rows = searchStmt.all(ctx.agentId, `%${query}%`, limit)
        const results = rows.map(r => ({ id: r.id, key: r.key, content: r.content, validFrom: r.valid_from }))
        return ok(ctx, 'memory_search', { results }, start)
      } catch (e) {
        return err(ctx, 'memory_search', e instanceof Error ? e.message : String(e), start)
      }
    },
  }

  function replaceImpl(toolName: string): RegisteredTool['execute'] {
    return async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      const start = Date.now()
      const key = args['key']
      const content = args['content']
      if (typeof key !== 'string' || !key.trim()) return err(ctx, toolName, 'key must be a non-empty string', start)
      if (typeof content !== 'string') return err(ctx, toolName, 'content must be a string', start)
      const capErr = checkCap(key, content)
      if (capErr) return err(ctx, toolName, capErr, start)
      try {
        const now = Date.now()
        const existing = currentEntryStmt.get(ctx.agentId, key)
        if (!existing) return err(ctx, toolName, `No current entry for key "${key}"`, start)
        const newId = randomUUID()
        db.transaction(() => {
          supersedeStmt.run(now, existing.id)
          insertStmt.run(newId, ctx.agentId, key, content, existing.type ?? 'fact', now)
        })()
        return ok(ctx, toolName, { id: newId }, start)
      } catch (e) {
        return err(ctx, toolName, e instanceof Error ? e.message : String(e), start)
      }
    }
  }

  const memory_replace: RegisteredTool = {
    schema: {
      name: 'memory_replace',
      description: 'Replace the current memory entry for a key with new content. Errors if no current entry exists.',
      parameters: {
        type: 'object',
        required: ['key', 'content'],
        properties: {
          key: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
    execute: replaceImpl('memory_replace'),
  }

  const memory_remove: RegisteredTool = {
    schema: {
      name: 'memory_remove',
      description: 'Expire (soft-delete) the current memory entry for a key. The row is never deleted.',
      parameters: {
        type: 'object',
        required: ['key'],
        properties: {
          key: { type: 'string' },
        },
      },
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const start = Date.now()
      const key = args['key']
      if (typeof key !== 'string' || !key.trim()) return err(ctx, 'memory_remove', 'key must be a non-empty string', start)
      try {
        const existing = currentEntryStmt.get(ctx.agentId, key)
        if (!existing) return err(ctx, 'memory_remove', `No current entry for key "${key}"`, start)
        supersedeStmt.run(Date.now(), existing.id)
        return ok(ctx, 'memory_remove', { ok: true }, start)
      } catch (e) {
        return err(ctx, 'memory_remove', e instanceof Error ? e.message : String(e), start)
      }
    },
  }

  const memory_supersede: RegisteredTool = {
    schema: {
      name: 'memory_supersede',
      description: 'Supersede the current memory entry for a key (identical to memory_replace, used by pipeline runtime).',
      parameters: {
        type: 'object',
        required: ['key', 'content'],
        properties: {
          key: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
    execute: replaceImpl('memory_supersede'),
  }

  const memory_promote: RegisteredTool = {
    schema: {
      name: 'memory_promote',
      description: 'Promote a memory entry to type "milestone" so it survives the 7-day daily-note sweep and shows on the Memory page. Use for facts that matter beyond today — recurring user preferences, project milestones, identity-shifting realisations.',
      parameters: {
        type: 'object',
        required: ['key'],
        properties: {
          key: { type: 'string', description: 'Key of the current entry to promote.' },
        },
      },
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const start = Date.now()
      const key = args['key']
      if (typeof key !== 'string' || !key.trim()) return err(ctx, 'memory_promote', 'MEMORY_KEY_REQUIRED: key must be a non-empty string', start)
      try {
        const existing = currentEntryStmt.get(ctx.agentId, key)
        if (!existing) return err(ctx, 'memory_promote', `MEMORY_ENTRY_NOT_FOUND: no current entry for key "${key}"`, start)
        if (existing.type === 'milestone') return err(ctx, 'memory_promote', `MEMORY_ALREADY_MILESTONE: entry "${key}" is already a milestone`, start)
        promoteStmt.run(existing.id)
        return ok(ctx, 'memory_promote', { id: existing.id, key, promoted: true }, start)
      } catch (e) {
        return err(ctx, 'memory_promote', e instanceof Error ? e.message : String(e), start)
      }
    },
  }

  return [memory_write, memory_get, memory_search, memory_replace, memory_remove, memory_supersede, memory_promote]
}
