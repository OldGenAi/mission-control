/**
 * memory/loader.ts — identity snapshot loaded once at session start
 *
 * Reads SOUL, AGENTS, IDENTITY, and today's daily note from memory_entries.
 * Returns a frozen system prompt string. Changes made during a session are
 * NOT visible until next session — preserves LLM prefix cache stability.
 */

import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'

interface EntryRow {
  content: string
}

const FALLBACK_SOUL = 'You are Dave, a personal AI agent running inside Mission Control.'

/**
 * Load the agent's spec body (markdown with YAML frontmatter stripped). Mirrors
 * worker-loop.ts's loadWorkerSystemPrompt so Dave sees his own spec the same
 * way orchestrator + workers see theirs. Spec filename matches role exactly
 * (e.g. tier1_agent.md, orchestrator.md, worker-researcher.md). Returns null
 * if the spec file is missing — the loader still produces a working prompt
 * from SOUL/AGENTS/IDENTITY without it.
 */
function loadSpecBody(agentId: string): string | null {
  const specPath = path.join(__dirname, '..', 'agents', 'specs', `${agentId}.md`)
  try {
    const raw = fs.readFileSync(specPath, 'utf-8')
    const body = raw.replace(/^---[\s\S]*?---\s*\n/, '').trim()
    return body || null
  } catch {
    return null
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
}

function yesterdayKey(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}

export function loadSystemPrompt(db: Database.Database, agentId: string): string {
  const stmt = db.prepare<[string, string], EntryRow>(
    `SELECT content FROM memory_entries
     WHERE agent_id = ? AND key = ? AND valid_until IS NULL
     LIMIT 1`
  )

  const get = (key: string): string | null =>
    stmt.get(agentId, key)?.content ?? null

  const soul      = get('soul')      ?? FALLBACK_SOUL
  const agents    = get('agents')
  const identity  = get('identity')
  const user      = get('user')
  const today     = get(todayKey())
  const yesterday = get(yesterdayKey())

  const specBody = loadSpecBody(agentId)

  const parts: string[] = [soul]

  if (agents)    parts.push(`## How I Work\n${agents}`)
  if (identity)  parts.push(`## Identity\n${identity}`)
  if (user)      parts.push(`## About Your Human\n${user}`)
  if (specBody)  parts.push(`## Operational Spec\n${specBody}`)
  if (yesterday) parts.push(`## Yesterday (${yesterdayKey()})\n${yesterday}`)
  if (today)     parts.push(`## Today (${todayKey()})\n${today}`)

  // The model has no internal clock. Inject the real current time, rebuilt every
  // turn (this function runs once per turn), so date/time questions are answered
  // from here instead of web_search — search returns stale indexed snippets and
  // gets the current time wrong. Timezone comes from the TZ env var (gateway/.env);
  // formatted via Intl with an explicit timeZone so it works on Alpine (no system
  // tzdata; Node's bundled ICU still resolves named zones). Defaults to UTC.
  const tzName = process.env.TZ || 'UTC'
  const dtFmt: Intl.DateTimeFormatOptions = {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }
  let nowStr: string
  try {
    nowStr = new Date().toLocaleString('en-GB', { ...dtFmt, timeZone: tzName })
  } catch {
    nowStr = new Date().toLocaleString('en-GB', { ...dtFmt, timeZone: 'UTC' })
  }
  parts.push(`## Current date and time\nIt is currently **${nowStr}** (the live clock on the machine you run on). Treat this as the authoritative present moment — use it directly for the date, the time, the day of the week, or how recent something is. Never web_search to find the current date or time; you already have it here.`)

  // Always injected — tells the model to actually call tools instead of guessing
  parts.push(`## Tool Use — Mandatory

You have tools available: web_search, web_fetch, file_read, file_write, file_edit, artifact_write, memory_write, memory_get, memory_search, memory_promote, pipeline_run, pipeline_status, and others.

Rules you must follow without exception:
1. NEVER answer from training data when a tool can get the real answer. Current events, live sports results, news, prices — always call a tool first. The current date and time are already given above (see "## Current date and time") — use those directly; do NOT web_search for the date or time, as search results are stale snapshots and will be wrong.
2. When the user says "search", "look up", "find", "check the web", or any similar phrasing — you MUST call web_search. No exceptions, no pretending. (Exception: if the user explicitly names a pipeline, follow the pipeline rules in the Operational Spec instead.)
3. Do not say "I've scanned" or "I've checked" unless you actually called a tool. If you cannot call a tool, say so plainly.
4. If a tool call fails, report the error. Never fabricate a result.
5. Always prefer a real tool result over a confident-sounding guess.`)

  return parts.join('\n\n')
}
