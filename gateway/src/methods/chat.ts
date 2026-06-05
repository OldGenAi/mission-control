/**
 * methods/chat.ts — chat.send + chat.abort handlers
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * chat.send fires the AgentLoop for a session and returns immediately.
 * The loop streams chat.delta / chat.final / agent.status events to the client.
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { MethodHandler } from '../types.js'
import { registerMethod } from '../router.js'
import { AgentLoop } from '../loop.js'
import type { AgentRegistry } from '../agents/registry.js'
import type { MonitorBuffer } from '../store/monitor-buffer.js'
import type { ProviderAdapter } from '../providers/types.js'
import type { RegisteredTool } from '../tools/types.js'
import type { SettingsStore } from '../store/settings.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { acquireSessionLock } from '../session-lock.js'
import { registerRun, unregisterRun, getRun } from '../active-runs.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ChatMethodsConfig {
  db:            Database.Database
  monitorBuffer: MonitorBuffer
  registry:      AgentRegistry
  tools:         Map<string, RegisteredTool>
  provider:      ProviderAdapter   // fallback adapter used only if instance lookup fails
  model:         string            // fallback model used only if instance lookup fails
  defaultAgentId?: string
  settingsStore:    SettingsStore
  providerRegistry: ProviderRegistry
  broadcast: (clientId: string, event: string, payload: Record<string, unknown>) => void
}

// In-flight turns are tracked in the shared registry (active-runs.ts) so they can
// be aborted by sessionId (session delete) and surfaced to the UI — not just by
// correlationId from here.

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

type ReasoningEffort = 'low' | 'medium' | 'high'

function asEffort(v: unknown): ReasoningEffort | undefined {
  return v === 'low' || v === 'medium' || v === 'high' ? v : undefined
}

export function registerChatMethods(config: ChatMethodsConfig): void {
  const { db, monitorBuffer, registry, tools, provider, model, settingsStore, providerRegistry } = config
  const defaultAgentId = config.defaultAgentId ?? 'agent-dave'

  // Ensure session exists, create if needed
  const getSession = db.prepare<[string], { id: string; title: string }>(
    `SELECT id, title FROM sessions WHERE id = ? LIMIT 1`
  )
  const createSession = db.prepare(
    `INSERT INTO sessions (id, agent_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  // Backfill generic titles ("New chat", empty) with the first user message.
  const updateSessionTitle = db.prepare(
    `UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`
  )

  // ---------------------------------------------------------------------------
  // chat.send
  // ---------------------------------------------------------------------------

  const chatSend: MethodHandler = async (params, client) => {
    const sessionId = params['sessionId']
    const message   = params['message']
    const agentId   = typeof params['agentId'] === 'string' ? params['agentId'] : defaultAgentId

    if (typeof sessionId !== 'string' || !sessionId.trim()) return { error: 'sessionId is required' }
    if (typeof message   !== 'string' || !message.trim())   return { error: 'message is required' }

    // Resolve instance → provider + model. Per-message overrides win, then active instance, then constructor defaults.
    const currentSettings = settingsStore.get()
    const requestedInstanceId = typeof params['instanceId'] === 'string' ? params['instanceId'] : null
    const instance = (requestedInstanceId
      ? currentSettings.instances.find(i => i.id === requestedInstanceId)
      : null)
      ?? currentSettings.instances.find(i => i.id === currentSettings.activeInstanceId)
      ?? currentSettings.instances[0]
    const instanceProvider = instance ? providerRegistry.get(instance.provider) : null
    const activeProvider   = instanceProvider ?? provider
    const requestedModel   = typeof params['model'] === 'string' && params['model'].trim() ? params['model'] : null
    const activeModel      = requestedModel ?? instance?.model ?? currentSettings.defaultModel ?? model
    const thinkingOn       = typeof params['thinking'] === 'boolean' ? params['thinking'] : currentSettings.thinkingDefault
    const effortOverride   = asEffort(params['effort'])
    const reasoning        = thinkingOn ? { effort: effortOverride ?? currentSettings.reasoningEffort } : undefined

    // Create session row if it doesn't exist; otherwise backfill a generic title.
    // Title format: "<instanceName> · MM/DD HH:MM" — never uses raw message text
    // (a "no" reply or off-topic first message would otherwise become the session name).
    const existing = getSession.get(sessionId)
    const now = Date.now()
    const d = new Date(now)
    const pad = (n: number) => String(n).padStart(2, '0')
    const autoTitle = `${instance?.name ?? 'Dave'} · ${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    let setTitle: string | null = null
    if (!existing) {
      createSession.run(sessionId, agentId, autoTitle, now, now)
      setTitle = autoTitle
    } else if (!existing.title || existing.title === 'New chat' || existing.title === 'Untitled') {
      updateSessionTitle.run(autoTitle, now, sessionId)
      setTitle = autoTitle
    }

    const correlationId = randomUUID()
    const abortController = new AbortController()
    registerRun(correlationId, sessionId, abortController)

    // Pull Dave's per-agent limits from the credential registry so the loop's
    // iteration cap + per-turn deadline come from tier1_agent.md (max-iterations /
    // timeout-seconds), not a hardcoded fallback. §3.19 wiring fix — these were
    // declared in the spec but never reached the runtime before.
    const daveCredential = registry.get(agentId)

    const loop = new AgentLoop({
      agentId,
      provider: activeProvider,
      model: activeModel,
      registry,
      db,
      monitorBuffer,
      tools,
      execEnabled: currentSettings.execEnabled,
      broadcast: config.broadcast,
      maxIterations: daveCredential?.maxIterations,
      timeoutSeconds: daveCredential?.timeoutSeconds,
    })

    // Fire and forget — loop streams events to the client.
    // Wrapped in a session lock so a pipeline-completion notifier can't run Dave's
    // loop on the same session while a user-initiated turn is in flight.
    void (async () => {
      const release = await acquireSessionLock(sessionId)
      try {
        await loop.run({ message, sessionId, clientId: client.id, correlationId, model: activeModel, ...(reasoning ? { reasoning } : {}), abortSignal: abortController.signal })
      } catch (err) {
        console.error(`[chat] correlationId=${correlationId} unhandled loop error:`, err)
      } finally {
        unregisterRun(correlationId)
        release()
      }
    })()

    return { ok: true, sessionId, correlationId, model: activeModel, instanceId: instance?.id ?? null, provider: activeProvider.name, ...(setTitle ? { sessionTitle: setTitle } : {}) }
  }

  // ---------------------------------------------------------------------------
  // chat.abort
  // ---------------------------------------------------------------------------

  const chatAbort: MethodHandler = async (params) => {
    const correlationId = params['correlationId']
    if (typeof correlationId !== 'string') return { error: 'correlationId is required' }

    const run = getRun(correlationId)
    if (!run) return { error: 'no active run found for that correlationId' }

    run.controller.abort()   // cancels the in-flight model request mid-stream
    unregisterRun(correlationId)
    return { ok: true, aborted: correlationId }
  }

  registerMethod('chat.send',  chatSend)
  registerMethod('chat.abort', chatAbort)
}
