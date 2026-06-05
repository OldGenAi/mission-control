import { randomUUID } from 'node:crypto'
import type { MethodHandler } from '../types.js'
import type Database from 'better-sqlite3'
import { registerMethod } from '../router.js'
import { abortRunsForSession, getRunBySession } from '../active-runs.js'

// ---------------------------------------------------------------------------
// Row shapes returned by better-sqlite3
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string
  agentId: string
  title: string
  createdAt: number
  updatedAt: number
  deletedAt?: number | null
}

interface MessageRow {
  id: string
  sessionId: string
  role: string
  content: string
  toolCalls: string | null
  toolCallId: string | null
  createdAt: number
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number | null
  autoNotify: number   // 0/1 — set when the message was written by the proactive notifier
}

// ---------------------------------------------------------------------------
// Setup — prepares all statements once, registers handlers with router
// ---------------------------------------------------------------------------

export function registerSessionMethods(db: Database.Database): void {
  // Prepare once — reused on every request
  // Active sessions only — soft-deleted rows (deleted_at set) live in Trash.
  const stmtList = db.prepare<[], SessionRow>(`
    SELECT id, agent_id AS agentId, title, created_at AS createdAt, updated_at AS updatedAt
    FROM sessions
    WHERE deleted_at IS NULL
    ORDER BY updated_at DESC
  `)

  // Trash — soft-deleted sessions, most recently deleted first.
  const stmtListDeleted = db.prepare<[], SessionRow>(`
    SELECT id, agent_id AS agentId, title, created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt
    FROM sessions
    WHERE deleted_at IS NOT NULL
    ORDER BY deleted_at DESC
  `)

  const stmtInsert = db.prepare<[string, string, string, number, number]>(`
    INSERT INTO sessions (id, agent_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `)

  const stmtGetById = db.prepare<[string], SessionRow>(`
    SELECT id, agent_id AS agentId, title, created_at AS createdAt, updated_at AS updatedAt
    FROM sessions WHERE id = ?
  `)

  const stmtMessages = db.prepare<[string], MessageRow>(`
    SELECT id, session_id AS sessionId, role, content,
           tool_calls AS toolCalls, tool_call_id AS toolCallId, created_at AS createdAt,
           input_tokens AS inputTokens, output_tokens AS outputTokens, duration_ms AS durationMs,
           auto_notify AS autoNotify
    FROM messages
    WHERE session_id = ?
    ORDER BY created_at ASC
  `)

  const stmtLastModelCall = db.prepare<[string], { input_tokens: number; output_tokens: number; duration_ms: number }>(`
    SELECT input_tokens, output_tokens, duration_ms
    FROM model_call_log
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `)

  const stmtSoftDelete = db.prepare<[number, string]>(`UPDATE sessions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
  const stmtRestore    = db.prepare<[string]>(`UPDATE sessions SET deleted_at = NULL WHERE id = ?`)
  const stmtRename     = db.prepare<[string, string]>(`UPDATE sessions SET title = ? WHERE id = ?`)

  const stmtDeleteMessages = db.prepare<[string]>(`DELETE FROM messages WHERE session_id = ?`)
  const stmtDeleteSession  = db.prepare<[string]>(`DELETE FROM sessions WHERE id = ?`)

  // Permanent purge — messages first, then session. Used by "Delete forever" from Trash.
  const txPurge = db.transaction((sessionId: string) => {
    stmtDeleteMessages.run(sessionId)
    stmtDeleteSession.run(sessionId)
  })

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const listSessions: MethodHandler = async () => {
    return { sessions: stmtList.all() }
  }

  const listDeletedSessions: MethodHandler = async () => {
    return { sessions: stmtListDeleted.all() }
  }

  const renameSession: MethodHandler = async (params) => {
    const sessionId = params['sessionId']
    const title     = params['title']
    if (typeof sessionId !== 'string' || !sessionId.trim()) return { error: 'sessionId is required' }
    if (typeof title !== 'string') return { error: 'title is required' }
    const clean = title.trim().slice(0, 200)   // keep titles sane; empty is allowed (renders "Untitled")
    stmtRename.run(clean, sessionId)
    const session = stmtGetById.get(sessionId)
    return { ok: true, session }
  }

  const createSession: MethodHandler = async (params) => {
    const agentId = params['agentId']
    const title   = params['title']
    if (typeof agentId !== 'string' || !agentId.trim()) return { error: 'agentId is required' }
    const id = randomUUID()
    const now = Date.now()
    stmtInsert.run(id, agentId, typeof title === 'string' ? title : '', now, now)
    const session = stmtGetById.get(id)
    return { session }
  }

  const getSessionHistory: MethodHandler = async (params) => {
    const sessionId = params['sessionId']
    if (typeof sessionId !== 'string' || !sessionId.trim()) return { error: 'sessionId is required' }
    const rows = stmtMessages.all(sessionId)
    const messages = rows.map((row) => ({
      ...row,
      toolCalls: row.toolCalls ? (JSON.parse(row.toolCalls) as unknown) : null,
    }))
    // Include last model call stats so the frontend can show accurate context usage
    // without relying on ephemeral React state or localStorage
    const lastCall = stmtLastModelCall.get(sessionId)
    // Surface whether Dave is currently running for this session so the UI can
    // restore the "working" bubble + Stop button after a tab switch. (§3.24)
    const run = getRunBySession(sessionId)
    return {
      messages,
      lastModelCall: lastCall
        ? { inputTokens: lastCall.input_tokens, outputTokens: lastCall.output_tokens, durationMs: lastCall.duration_ms }
        : null,
      activeRun: run ? { correlationId: run.correlationId } : null,
    }
  }

  const deleteSession: MethodHandler = async (params) => {
    const sessionId = params['sessionId']
    if (typeof sessionId !== 'string' || !sessionId.trim()) return { error: 'sessionId is required' }
    // Stop Dave first — an in-flight loop for this session is a detached async task;
    // deleting only the DB rows would orphan it (it keeps running, then FK-fails on
    // persist). Aborting makes "delete" an actual stop. (§3.25)
    const aborted = abortRunsForSession(sessionId)
    // Soft-delete: move to Trash (recoverable). Messages are kept intact. (§3.22)
    stmtSoftDelete.run(Date.now(), sessionId)
    return { ok: true, abortedRuns: aborted }
  }

  const restoreSession: MethodHandler = async (params) => {
    const sessionId = params['sessionId']
    if (typeof sessionId !== 'string' || !sessionId.trim()) return { error: 'sessionId is required' }
    stmtRestore.run(sessionId)
    const session = stmtGetById.get(sessionId)
    return { ok: true, session }
  }

  const purgeSession: MethodHandler = async (params) => {
    const sessionId = params['sessionId']
    if (typeof sessionId !== 'string' || !sessionId.trim()) return { error: 'sessionId is required' }
    // Irreversible. Abort any stray run defensively, then hard-delete messages + session.
    const aborted = abortRunsForSession(sessionId)
    txPurge(sessionId)
    return { ok: true, abortedRuns: aborted }
  }

  registerMethod('sessions.list', listSessions)
  registerMethod('sessions.listDeleted', listDeletedSessions)
  registerMethod('sessions.create', createSession)
  registerMethod('sessions.history', getSessionHistory)
  registerMethod('sessions.rename', renameSession)
  registerMethod('sessions.delete', deleteSession)
  registerMethod('sessions.restore', restoreSession)
  registerMethod('sessions.purge', purgeSession)
}
