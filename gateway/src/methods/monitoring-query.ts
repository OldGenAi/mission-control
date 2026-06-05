import { registerMethod } from '../router.js'
import type Database from 'better-sqlite3'

type QueryType = 'tool_calls' | 'model_calls' | 'errors' | 'pipeline_runs'

const MAX_LIMIT = 500
const DEFAULT_LIMIT = 50

export function registerMonitoringQueryMethod(db: Database.Database): void {
  registerMethod('monitoring.query', async (params, _client) => {
    const type = params['type'] as QueryType | undefined
    if (!type || !['tool_calls', 'model_calls', 'errors', 'pipeline_runs'].includes(type)) {
      throw { code: 'INVALID_PARAMS', message: 'type must be one of: tool_calls, model_calls, errors, pipeline_runs' }
    }

    const agentId       = typeof params['agentId'] === 'string'       ? params['agentId']       : undefined
    const correlationId = typeof params['correlationId'] === 'string' ? params['correlationId'] : undefined
    const from          = typeof params['from'] === 'number'          ? params['from']          : undefined
    const to            = typeof params['to'] === 'number'            ? params['to']            : undefined
    const limit        = Math.min(Number(params['limit'] ?? DEFAULT_LIMIT), MAX_LIMIT)

    const conditions: string[] = []
    const bindings: (string | number)[] = []

    if (agentId) {
      conditions.push('agent_id = ?')
      bindings.push(agentId)
    }
    if (correlationId) {
      conditions.push('correlation_id = ?')
      bindings.push(correlationId)
    }
    if (from !== undefined) {
      conditions.push('created_at >= ?')
      bindings.push(from)
    }
    if (to !== undefined) {
      conditions.push('created_at <= ?')
      bindings.push(to)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    let table: string
    let orderCol: string

    switch (type) {
      case 'tool_calls':
        table = 'tool_call_log'
        orderCol = 'created_at'
        break
      case 'model_calls':
        table = 'model_call_log'
        orderCol = 'created_at'
        break
      case 'errors':
        table = 'error_log'
        orderCol = 'created_at'
        break
      case 'pipeline_runs':
        table = 'pipeline_runs'
        orderCol = 'updated_at'
        break
    }

    // SAFETY: `table` and `orderCol` are switch-selected constants (never user input), and
    // `where` is hardcoded `col = ?` conditions — every user value is bound via `bindings`,
    // never concatenated. Do NOT interpolate any request-derived value into these strings.
    const countRow = db
      .prepare<(string | number)[], { total: number }>(`SELECT COUNT(*) as total FROM ${table} ${where}`)
      .get(...bindings)

    const rows = db
      .prepare<(string | number)[], Record<string, unknown>>(
        `SELECT * FROM ${table} ${where} ORDER BY ${orderCol} DESC LIMIT ?`
      )
      .all(...bindings, limit)

    return { type, rows, total: countRow?.total ?? 0 }
  })
}
