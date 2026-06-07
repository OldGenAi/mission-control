import type Database from 'better-sqlite3'
import type { MethodHandler } from '../types.js'
import { registerMethod } from '../router.js'

interface ArtifactRow {
  id: string;
  type: string;
  title: string;
  content: string;
  agentId: string | null;
  sessionId: string | null;
  pipelineRunId: string | null;
  stepId: string | null;
  createdAt: number;
}

export function registerArtifactsMethods(db: Database.Database): void {
  const getStmt = db.prepare(`
    SELECT 
      id, type, title, content,
      agent_id AS agentId, 
      session_id AS sessionId,
      pipeline_run_id AS pipelineRunId,
      step_id AS stepId,
      created_at AS createdAt
    FROM artifacts
    WHERE id = ?
  `)

  const listArtifacts: MethodHandler = async (params) => {
    const { agentId, sessionId, type, pipelineRunId, limit: paramLimit } = params
    let query = `SELECT id, type, title, step_id AS stepId, agent_id AS agentId, session_id AS sessionId, created_at AS createdAt FROM artifacts`
    // Exclude soft-deleted artifacts from every listing (active list + run-detail view).
    const whereClauses: string[] = ['deleted_at IS NULL']
    const values: unknown[] = []

    if (agentId) {
      whereClauses.push('agent_id = ?')
      values.push(agentId)
    }
    if (sessionId) {
      whereClauses.push('session_id = ?')
      values.push(sessionId)
    }
    if (type) {
      whereClauses.push('type = ?')
      values.push(type)
    }
    // Filter a single pipeline run's outputs — drives the run-detail view.
    if (pipelineRunId) {
      whereClauses.push('pipeline_run_id = ?')
      values.push(pipelineRunId)
    }

    if (whereClauses.length > 0) {
      query += ' WHERE ' + whereClauses.join(' AND ')
    }

    // Within a run, oldest-first reads as step order; otherwise newest-first.
    query += pipelineRunId ? ' ORDER BY created_at ASC' : ' ORDER BY created_at DESC'

    const limit = Math.min(Math.max(Number(paramLimit) || 50, 1), 100)
    query += ' LIMIT ?'
    values.push(limit)

    const artifacts = db.prepare(query).all(...values) as Array<{
      id: string;
      type: string;
      title: string;
      stepId: string | null;
      agentId: string | null;
      sessionId: string | null;
      createdAt: number;
    }>

    return { artifacts }
  }

  const getArtifact: MethodHandler = async (params) => {
    const { id } = params as { id: string }
    const artifact = getStmt.get(id) as ArtifactRow | undefined

    if (!artifact) {
      return { error: 'not found' }
    }

    return { artifact }
  }

  // Soft-delete: set deleted_at so the artifact drops out of every listing while the
  // row (and its pipeline-run linkage) is preserved and recoverable. Mirrors sessions.
  const stmtSoftDelete = db.prepare<[number, string]>(
    `UPDATE artifacts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`
  )
  const deleteArtifact: MethodHandler = async (params) => {
    const id = params['id']
    if (typeof id !== 'string' || !id.trim()) return { error: 'id is required' }
    stmtSoftDelete.run(Date.now(), id)
    return { ok: true }
  }

  registerMethod('artifacts.list', listArtifacts)
  registerMethod('artifacts.get', getArtifact)
  registerMethod('artifacts.delete', deleteArtifact)
}
