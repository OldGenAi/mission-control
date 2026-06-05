/**
 * notify/pipeline-notify.ts — proactive pipeline-completion notifier.
 *
 * When a pipeline launched via the `pipeline_run` tool reaches a terminal
 * status, this notifier wakes Dave's launching session with a synthetic
 * turn so he can report back to the user without being prompted.
 *
 * Architecture:
 *  - Runner calls onTerminal(run) on the FIRST transition into completed/
 *    failed/aborted.
 *  - PipelineNotifier.enqueue(run) buffers per-session with a 30s debounce
 *    so a burst of completions yields ONE proactive message, not five.
 *  - On flush: verify session still exists (skip + log if not), acquire the
 *    session lock (wait if user is mid-turn), then run Dave's loop with a
 *    synthetic system-flagged message.
 *  - Resulting chat messages are tagged auto_notify=1 so the UI can mark
 *    them visually.
 */

import type Database from 'better-sqlite3'
import { AgentLoop } from '../loop.js'
import { acquireSessionLock } from '../session-lock.js'
import { broadcastEvent } from '../broadcast.js'
import type { PipelineRun } from '../pipeline/types.js'
import type { SettingsStore } from '../store/settings.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { AgentRegistry } from '../agents/registry.js'
import type { MonitorBuffer } from '../store/monitor-buffer.js'
import type { RegisteredTool } from '../tools/types.js'

interface PendingEntry {
  runs:    PipelineRun[]
  timer:   NodeJS.Timeout
  agentId: string
}

export interface NotifierConfig {
  db:               Database.Database
  settingsStore:    SettingsStore
  providerRegistry: ProviderRegistry
  registry:         AgentRegistry
  monitorBuffer:    MonitorBuffer
  tools:            Map<string, RegisteredTool>
  debounceMs?:      number   // default 30_000
}

export class PipelineNotifier {
  private pending = new Map<string, PendingEntry>()  // key: sessionId
  private readonly debounceMs: number

  constructor(private readonly cfg: NotifierConfig) {
    this.debounceMs = cfg.debounceMs ?? 30_000
  }

  /** Called by the runner when a pipeline reaches terminal status. */
  enqueue(run: PipelineRun): void {
    const sessionId = run.launchingSessionId
    const agentId   = run.launchingAgentId
    if (!sessionId || !agentId) return   // pipeline wasn't launched from a chat — nothing to notify

    const existing = this.pending.get(sessionId)
    if (existing) {
      clearTimeout(existing.timer)
      existing.runs.push(run)
      existing.timer = setTimeout(() => this.flush(sessionId), this.debounceMs)
    } else {
      const entry: PendingEntry = {
        runs:    [run],
        agentId,
        timer:   setTimeout(() => this.flush(sessionId), this.debounceMs),
      }
      this.pending.set(sessionId, entry)
    }
  }

  private async flush(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (!entry) return
    this.pending.delete(sessionId)

    // Choice B: silently drop if session was deleted, but log to error_log for audit.
    const sessionRow = this.cfg.db.prepare<[string], { id: string }>(
      `SELECT id FROM sessions WHERE id = ?`,
    ).get(sessionId)
    if (!sessionRow) {
      const names = entry.runs.map(r => r.name).join(', ')
      this.cfg.monitorBuffer.enqueue({
        kind: 'error',
        correlationId: entry.runs[0]?.id ?? 'unknown',
        agentId: 'pipeline-notifier',
        sessionId: undefined,
        code: 'NOTIFY_SESSION_DELETED',
        message: `pipeline(s) [${names}] finished but launching session ${sessionId} no longer exists — notification dropped`,
      })
      return
    }

    // Resolve current Dave provider+model from active instance.
    const settings = this.cfg.settingsStore.get()
    const activeInstance = settings.instances.find(i => i.id === settings.activeInstanceId) ?? settings.instances[0]
    const provider = activeInstance ? this.cfg.providerRegistry.get(activeInstance.provider) : null
    if (!provider || !activeInstance) {
      console.warn(`[notifier] no usable provider — skipping notify for session ${sessionId}`)
      return
    }

    // Build the synthetic system-flagged message.
    const synthetic = this.composeMessage(entry.runs)

    // Acquire session lock — wait for any in-flight user turn to finish first.
    const release = await acquireSessionLock(sessionId)
    try {
      const loop = new AgentLoop({
        agentId: entry.agentId,
        provider,
        model: activeInstance.model,
        registry: this.cfg.registry,
        db: this.cfg.db,
        monitorBuffer: this.cfg.monitorBuffer,
        tools: this.cfg.tools,
        execEnabled: settings.execEnabled,
        // For proactive notifications, broadcast to all connected clients (any tab
        // viewing this session sees the new message).
        broadcast: (_clientId, event, payload) => {
          broadcastEvent(event as Parameters<typeof broadcastEvent>[0], payload)
        },
      })

      // autoNotify=true flag flows through loop.run → persistMessages so the
      // assistant + tool rows are flagged auto_notify=1 at insert time; the
      // synthetic [SYSTEM EVENT] user message is skipped from persistence.
      await loop.run({
        message:  synthetic,
        sessionId,
        clientId: '',
        autoNotify: true,
      })
    } catch (e) {
      console.error(`[notifier] proactive turn failed for session ${sessionId}:`, e)
    } finally {
      release()
    }
  }

  /**
   * Build the synthetic turn Dave wakes on. Everything pipeline_status would
   * return (status, tokens, duration, artifact list) is embedded directly so
   * Dave has no reason to call pipeline_status. This is deliberate: the prior
   * version told him to poll, that poll got persisted without the [SYSTEM EVENT]
   * that justified it, and Dave then imitated the orphaned poll on later turns.
   */
  private composeMessage(runs: PipelineRun[]): string {
    const artifactsStmt = this.cfg.db.prepare<[string], { id: string; type: string; title: string }>(
      `SELECT id, type, title FROM artifacts WHERE pipeline_run_id = ? ORDER BY created_at ASC`,
    )

    const describe = (r: PipelineRun): string => {
      const arts = artifactsStmt.all(r.id)
      const durationSeconds = Math.max(0, Math.round((r.updatedAt - r.createdAt) / 1000))
      const lines: string[] = [
        `name:     ${r.name}`,
        `runId:    ${r.id}`,
        `status:   ${r.status}`,
      ]
      if (r.error) lines.push(`error:    ${r.error}`)
      lines.push(`tokens:   ${r.tokensUsed}`)
      lines.push(`duration: ${durationSeconds}s`)
      if (arts.length > 0) {
        lines.push(`artifacts:`)
        for (const a of arts) lines.push(`  - [${a.type}] ${a.title} (id ${a.id})`)
      } else {
        lines.push(`artifacts: none`)
      }
      return lines.join('\n')
    }

    if (runs.length === 1) {
      return [
        `[SYSTEM EVENT] A pipeline you launched has just reached a terminal state. Everything pipeline_status would return is included below — do NOT call pipeline_status or any other tool; just report to the user.`,
        ``,
        describe(runs[0]),
        ``,
        `Tell the user what happened in 2-3 short sentences, using only the facts above. Do not invent details or artifact contents you were not given.`,
      ].join('\n')
    }
    return [
      `[SYSTEM EVENT] ${runs.length} pipelines you launched have just finished. Everything pipeline_status would return is included below — do NOT call pipeline_status or any other tool; just report to the user.`,
      ``,
      runs.map(describe).join('\n\n'),
      ``,
      `Summarise briefly for the user — one or two short lines per pipeline, using only the facts above. Do not invent details.`,
    ].join('\n')
  }
}
