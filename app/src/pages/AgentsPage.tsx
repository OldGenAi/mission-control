import React, { useEffect, useState } from 'react'
import { gateway } from '../lib/gateway-client'
import type { GatewayEvent } from '../lib/gateway-client'
import { useSettings } from '../lib/settings'

interface AgentInfo {
  role: string
  tier: number
  allowedTools: string[]
  maxIterations: number
  maxCostUsd: number
  timeoutSeconds: number
}

interface ToolInfo {
  name: string
  description: string
  requiresExplicitEnable?: boolean
}

type AgentStatus = 'idle' | 'thinking' | 'tool_running' | 'error' | 'context_warning'

interface AgentStatusPayload {
  agentId: string
  sessionId?: string
  status: AgentStatus
  detail?: string
  correlationId?: string
  estimatedTokens?: number
}

const STATIC_ROLES: AgentInfo[] = [
  { role: 'tier1_agent', tier: 1, allowedTools: [], maxIterations: 20, maxCostUsd: 1, timeoutSeconds: 120 },
  { role: 'Orchestrator', tier: 2, allowedTools: [], maxIterations: 20, maxCostUsd: 5, timeoutSeconds: 600 },
  { role: 'Worker', tier: 3, allowedTools: [], maxIterations: 10, maxCostUsd: 1, timeoutSeconds: 120 },
]

// Human-readable display names — role id → label shown in the UI
const DISPLAY_NAMES: Record<string, string> = {
  tier1_agent:  'Dave',
  orchestrator: 'Orchestrator',
}

const C = {
  panel:      'rgba(6,10,16,0.88)',
  border:     'rgba(255,255,255,0.07)',
  cyan:       '#00C8FF',
  cyanBorder: 'rgba(0,200,255,0.28)',
  cyanBg:     'rgba(0,200,255,0.08)',
  muted:      '#4B5563',
  amber:      '#F59E0B',
  red:        '#EF4444',
}

const TIER_LABELS: Record<number, string> = { 1: 'Personal', 2: 'Orchestrator', 3: 'Specialist' }
const TIER_COLORS: Record<number, string> = { 1: '#00C8FF', 2: '#7B61FF', 3: '#6B7280' }

const TierBadge: React.FC<{ tier: number }> = ({ tier }) => (
  <span style={{
    fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
    color: TIER_COLORS[tier] ?? '#6b7280', fontWeight: 600,
  }}>
    {TIER_LABELS[tier] ?? `Tier ${tier}`}
  </span>
)

const StatusDot: React.FC<{ status: AgentStatus }> = ({ status }) => {
  const styles: Record<AgentStatus, React.CSSProperties> = {
    idle:            { background: '#4B5563' },
    thinking:        { background: C.cyan,  boxShadow: `0 0 6px ${C.cyan}` },
    tool_running:    { background: C.cyan,  boxShadow: `0 0 6px ${C.cyan}` },
    error:           { background: C.red,   boxShadow: `0 0 6px ${C.red}` },
    context_warning: { background: C.amber, boxShadow: `0 0 6px ${C.amber}` },
  }
  const animate = status === 'thinking' || status === 'tool_running' || status === 'context_warning'
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${animate ? 'animate-pulse' : ''}`}
      style={styles[status]}
    />
  )
}

export const AgentsPage: React.FC = () => {
  const [agents, setAgents] = useState<AgentInfo[]>(STATIC_ROLES)
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [selected, setSelected] = useState<string>('tier1_agent')
  const [statusMap, setStatusMap] = useState<Record<string, AgentStatusPayload>>({})
  const [toolToggles, setToolToggles] = useState<Record<string, boolean>>({})
  const [toolSaved, setToolSaved] = useState(false)
  const [activeTab, setActiveTab] = useState<string>('Overview')
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [fileContents, setFileContents] = useState<Record<string, string>>({})
  const [fileSaving, setFileSaving] = useState<Record<string, boolean>>({})
  const [dailyKey, setDailyKey] = useState<string>('')
  // Global shell-access switch (the real gate, with confirmation, lives in Settings).
  // The per-agent tool list below can only *restrict* — it can never enable exec on its own.
  const { settings } = useSettings()
  const execGloballyOn = settings?.execEnabled ?? false

  useEffect(() => {
    gateway.request('agents.list', {}).then((res) => {
      const dynamic = ((res as { agents?: AgentInfo[] })?.agents ?? [])
      const merged = [...STATIC_ROLES]
      const hasRealWorkers = dynamic.some((a) => a.tier === 3)
      for (const a of dynamic) {
        const idx = merged.findIndex((m) => m.role.toLowerCase() === a.role.toLowerCase())
        if (idx === -1) {
          // New role from registry — add it, but skip generic Worker placeholder if real workers exist
          if (a.role.toLowerCase() !== 'worker') merged.push(a)
        } else {
          merged[idx] = { ...merged[idx], ...a }
        }
      }
      // Remove generic Worker placeholder if real worker specs were loaded
      const final = hasRealWorkers ? merged.filter((m) => m.role !== 'Worker') : merged
      setAgents(final)
    }).catch(() => {})

    gateway.request('tools.list', {}).then((res) => {
      setTools(((res as { tools?: ToolInfo[] })?.tools ?? []))
    }).catch(() => {})

    const unsub = gateway.onEvent((event: GatewayEvent) => {
      if (event.event === 'agent.status' && event.payload) {
        const p = event.payload as unknown as AgentStatusPayload
        if (p.agentId) setStatusMap((prev) => ({ ...prev, [p.agentId]: p }))
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    if (tools.length === 0) return
    const saved = localStorage.getItem(`mc-tools-${selected}`)
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Record<string, boolean>
        const merged: Record<string, boolean> = {}
        for (const t of tools) merged[t.name] = parsed[t.name] ?? true
        // Stale all-false config (from old code) — discard it and use defaults
        const hasAnyEnabled = Object.values(merged).some(Boolean)
        if (!hasAnyEnabled) {
          localStorage.removeItem(`mc-tools-${selected}`)
        } else {
          setToolToggles(merged)
          const enabledTools = Object.entries(merged).filter(([, v]) => v).map(([k]) => k)
          gateway.request('agent.tools.set', { agentId: selected, enabledTools }).catch(() => {})
          return
        }
      } catch { /* fall through to defaults */ }
    }
    // No saved config — default all tools ON, gateway uses its own default (all credentialed)
    const initial: Record<string, boolean> = {}
    for (const t of tools) initial[t.name] = true
    setToolToggles(initial)
  }, [tools, selected])

  useEffect(() => {
    if (activeTab !== 'Files') return
    gateway.request('memory.identity', { agentId: 'tier1_agent' }).then((res) => {
      const r = res as { soul: string; agents: string; identity: string; user: string; dailyNote: string; dailyKey: string }
      setFileContents({ SOUL: r.soul, AGENTS: r.agents, IDENTITY: r.identity, USER: r.user, 'DAILY NOTE': r.dailyNote })
      setDailyKey(r.dailyKey)
    }).catch(() => {})
  }, [activeTab])

  const selectedAgent = agents.find((a) => a.role === selected) ?? STATIC_ROLES[0]
  const agentStatus = statusMap[selected] ?? { status: 'idle' as AgentStatus }

  const saveToolConfig = (toggles: Record<string, boolean>) => {
    const enabledTools = Object.entries(toggles).filter(([, v]) => v).map(([k]) => k)
    gateway.request('agent.tools.set', { agentId: selected, enabledTools }).catch(() => {})
    localStorage.setItem(`mc-tools-${selected}`, JSON.stringify(toggles))
    setToolSaved(true)
    setTimeout(() => setToolSaved(false), 1500)
  }

  const applyPreset = (preset: 'Minimal' | 'Research' | 'Build' | 'Full') => {
    const minimal = ['file_read', 'memory_get', 'memory_search']
    const research = [...minimal, 'web_fetch', 'web_search']
    const build = [...research, 'file_write', 'file_edit', 'artifact_write']
    const full = tools.map((t) => t.name)
    const allowed = { Minimal: minimal, Research: research, Build: build, Full: full }[preset]
    const newToggles: Record<string, boolean> = {}
    for (const t of tools) newToggles[t.name] = allowed.includes(t.name)
    setToolToggles(newToggles)
    setActiveTab('Tools')
  }

  // ── Roster ────────────────────────────────────────────────────────────────

  const renderRoster = () => (
    <div className="w-60 shrink-0 p-4 space-y-1.5" style={{ borderRight: `1px solid ${C.border}` }}>
      {agents.map((a) => {
        const st = statusMap[a.role]?.status ?? 'idle'
        const active = st === 'thinking' || st === 'tool_running'
        const isSel = selected === a.role
        return (
          <div
            key={a.role}
            onClick={() => setSelected(a.role)}
            className="p-3 rounded-lg cursor-pointer transition-all"
            style={{
              background: isSel ? C.cyanBg : 'transparent',
              border: `1px solid ${isSel ? C.cyanBorder : 'transparent'}`,
            }}
            onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = 'rgba(255,255,255,0.03)' }}
            onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = 'transparent' }}
          >
            <div className="flex items-center gap-2 mb-0.5">
              <StatusDot status={st} />
              <span className="font-medium text-sm text-white">{DISPLAY_NAMES[a.role] ?? a.role}</span>
              <TierBadge tier={a.tier} />
            </div>
            {statusMap[a.role]?.detail && (
              <p className="text-xs truncate mt-0.5" style={{ color: C.muted }}>{statusMap[a.role]!.detail}</p>
            )}
            {active && (
              <div className="mt-2 h-0.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                <div className="h-0.5 rounded-full animate-pulse w-1/2" style={{ background: C.cyan }} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )

  // ── Tab bar ───────────────────────────────────────────────────────────────

  const TABS = ['Overview', 'Files', 'Tools', 'Skills', 'Plugins', 'Channels', 'Presets']

  const renderTabBar = () => (
    <div className="flex mb-5" style={{ borderBottom: `1px solid ${C.border}` }}>
      {TABS.map((tab) => (
        <button
          key={tab}
          onClick={() => setActiveTab(tab)}
          className="px-4 py-2 text-sm transition-colors focus:outline-none"
          style={{
            color: activeTab === tab ? C.cyan : C.muted,
            borderBottom: activeTab === tab ? `2px solid ${C.cyan}` : '2px solid transparent',
          }}
        >
          {tab}
        </button>
      ))}
    </div>
  )

  // ── Overview ──────────────────────────────────────────────────────────────

  const renderOverview = () => (
    <div className="grid grid-cols-2 gap-4 auto-rows-auto">
      {[
        {
          label: 'Status',
          content: (
            <div className="flex items-center gap-2">
              <StatusDot status={agentStatus.status} />
              <span className="capitalize text-sm text-white">{agentStatus.status.replace('_', ' ')}</span>
              {agentStatus.detail && <span className="text-sm" style={{ color: C.muted }}>— {agentStatus.detail}</span>}
            </div>
          ),
        },
        {
          label: 'Active session',
          content: <p className="text-sm" style={{ color: agentStatus.sessionId ? '#E8EAED' : C.muted }}>{agentStatus.sessionId ?? 'No active session'}</p>,
        },
        {
          label: 'Context usage',
          content: (
            <>
              <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                <div
                  className="h-1.5 rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, ((agentStatus.estimatedTokens ?? 0) / 100_000) * 100)}%`,
                    background: C.cyan,
                    boxShadow: `0 0 6px ${C.cyan}`,
                  }}
                />
              </div>
              <p className="text-xs mt-1.5" style={{ color: C.muted, fontFamily: "'SF Mono','Fira Code',monospace" }}>
                {(agentStatus.estimatedTokens ?? 0).toLocaleString()} / 100,000 tokens
              </p>
            </>
          ),
        },
        {
          label: 'Constraints',
          content: (
            <p className="text-sm" style={{ color: '#E8EAED', fontFamily: "'SF Mono','Fira Code',monospace", fontSize: 12 }}>
              {selectedAgent.maxIterations} iterations · ${selectedAgent.maxCostUsd} max
            </p>
          ),
        },
        {
          label: 'Cost so far',
          content: <p className="text-sm" style={{ color: C.muted }}>—</p>,
        },
      ].map(({ label, content }) => (
        <div key={label} className="rounded-lg p-4" style={{ background: C.panel, border: `1px solid ${C.border}` }}>
          <h3 className="text-xs uppercase tracking-wider mb-2" style={{ color: C.muted }}>{label}</h3>
          {content}
        </div>
      ))}
    </div>
  )

  // ── Files ─────────────────────────────────────────────────────────────────

  const saveFile = async (name: string) => {
    const keyMap: Record<string, string> = {
      SOUL: 'soul', AGENTS: 'agents', IDENTITY: 'identity', USER: 'user', 'DAILY NOTE': dailyKey,
    }
    const key = keyMap[name]
    if (!key) return
    setFileSaving((prev) => ({ ...prev, [name]: true }))
    try {
      await gateway.request('memory.identity.set', { agentId: 'tier1_agent', key, content: fileContents[name] ?? '' })
    } catch { /* silent */ } finally {
      setFileSaving((prev) => ({ ...prev, [name]: false }))
    }
  }

  const renderFiles = () => (
    <div className="grid grid-cols-2 gap-4">
      {['SOUL', 'AGENTS', 'IDENTITY', 'USER', 'DAILY NOTE'].map((name) => (
        <div key={name} className={`rounded-lg p-4${name === 'DAILY NOTE' ? ' col-span-2' : ''}`} style={{ background: C.panel, border: `1px solid ${C.border}` }}>
          <h4 className={`text-sm font-medium ${name === 'DAILY NOTE' ? 'mb-1' : 'mb-3'} text-white`}>{name}</h4>
          {name === 'DAILY NOTE' && (
            <p className="text-[11px] mb-3" style={{ color: C.muted }}>
              Auto-expires after 7 days. Dave can call <span style={{ color: C.cyan }}>memory_promote</span> to graduate a note to a permanent milestone. Edits apply to new sessions.
            </p>
          )}
          {revealed[name] ? (
            <textarea
              className="w-full h-36 p-2 text-xs rounded resize-none focus:outline-none"
              style={{ background: 'rgba(2,4,8,0.9)', border: `1px solid ${C.cyanBorder}`, color: '#9CA3AF' }}
              autoFocus
              value={fileContents[name] ?? ''}
              placeholder={`No ${name.toLowerCase()} content yet — paste or type here`}
              onChange={(e) => setFileContents((prev) => ({ ...prev, [name]: e.target.value }))}
              onBlur={() => setRevealed((prev) => ({ ...prev, [name]: false }))}
            />
          ) : (
            <div
              className="h-36 rounded flex items-center justify-center cursor-pointer transition-colors"
              style={{ background: 'rgba(2,4,8,0.6)', border: `1px solid ${C.border}` }}
              onClick={() => setRevealed((prev) => ({ ...prev, [name]: true }))}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = C.cyanBorder)}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = C.border)}
            >
              <span className="text-sm" style={{ color: fileContents[name] ? C.cyan : C.muted }}>
                {fileContents[name] ? 'Click to edit' : 'Click to reveal'}
              </span>
            </div>
          )}
          <button
            className="mt-3 w-full py-1.5 text-xs rounded transition-colors"
            style={{
              background: fileSaving[name] ? 'rgba(0,200,255,0.08)' : 'rgba(0,200,255,0.06)',
              border: `1px solid ${C.cyanBorder}`,
              color: C.cyan,
              cursor: fileSaving[name] ? 'wait' : 'pointer',
            }}
            onClick={() => saveFile(name)}
            disabled={fileSaving[name]}
          >
            {fileSaving[name] ? 'Saving…' : 'Save'}
          </button>
        </div>
      ))}
    </div>
  )

  // ── Tools ─────────────────────────────────────────────────────────────────

  const TOOL_GROUPS = [
    { category: 'File',      names: ['file_read', 'file_write', 'file_edit'] },
    { category: 'Web',       names: ['web_fetch', 'web_search'] },
    { category: 'Memory',    names: ['memory_write', 'memory_replace', 'memory_remove', 'memory_get', 'memory_search', 'memory_supersede'] },
    { category: 'Exec',      names: ['exec'] },
    { category: 'Artifacts', names: ['artifact_write'] },
    { category: 'Pipeline',  names: ['subagent_spawn'] },
  ]

  const renderTools = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: C.muted }}>Saved per agent to localStorage</p>
        <button
          onClick={() => saveToolConfig(toolToggles)}
          className="px-3 py-1 text-xs rounded transition-colors"
          style={{
            background: toolSaved ? 'rgba(0,200,255,0.14)' : C.cyanBg,
            border: `1px solid ${C.cyanBorder}`,
            color: toolSaved ? '#fff' : C.cyan,
          }}
        >
          {toolSaved ? 'Saved ✓' : 'Save'}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {(['Minimal', 'Research', 'Build', 'Full'] as const).map((p) => (
          <button key={p} onClick={() => applyPreset(p)}
            className="px-3 py-1 text-xs rounded transition-colors"
            style={{ background: C.cyanBg, border: `1px solid ${C.cyanBorder}`, color: '#67e8f9' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,200,255,0.14)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = C.cyanBg)}
          >
            {p}
          </button>
        ))}
        <button onClick={() => setToolToggles(Object.fromEntries(tools.map((t) => [t.name, true])))}
          className="px-3 py-1 text-xs rounded transition-colors"
          style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${C.border}`, color: '#9CA3AF' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.09)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
        >
          Enable All
        </button>
        <button onClick={() => setToolToggles(Object.fromEntries(tools.map((t) => [t.name, false])))}
          className="px-3 py-1 text-xs rounded transition-colors"
          style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${C.border}`, color: '#9CA3AF' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.09)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
        >
          Disable All
        </button>
      </div>
      <div className="space-y-3">
        {TOOL_GROUPS.map(({ category, names }) => (
          <div key={category} className="rounded-lg p-3" style={{ background: C.panel, border: `1px solid ${C.border}` }}>
            <h4 className="text-xs uppercase tracking-wider mb-2" style={{ color: C.muted }}>{category}</h4>
            {names.map((toolName) => {
              const tool = tools.find((t) => t.name === toolName)
              const credentialed = selectedAgent.allowedTools?.includes(toolName) ?? false
              const isExec = tool?.requiresExplicitEnable
              const isOrchestratorOnly = toolName === 'subagent_spawn'
              return (
                <div key={toolName} className="flex items-center justify-between py-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={toolToggles[toolName] ?? false}
                      disabled={!credentialed || (isExec && !execGloballyOn)}
                      onChange={(e) => setToolToggles({ ...toolToggles, [toolName]: e.target.checked })}
                      style={{ accentColor: C.cyan }}
                    />
                    <span className="text-sm" style={{ color: credentialed ? '#E8EAED' : C.muted }}>{toolName}</span>
                    {!credentialed && <span style={{ color: C.muted, fontSize: 12 }}>🔒</span>}
                    {isExec && (execGloballyOn ? (
                      <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(245,158,11,0.12)', color: C.amber, border: `1px solid ${C.amber}55`, fontWeight: 700, letterSpacing: '0.04em' }}>
                        ⚠ ARMED
                      </span>
                    ) : (
                      <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171', border: '1px solid rgba(239,68,68,0.25)' }}>
                        shell access off — enable in Settings
                      </span>
                    ))}
                    {isOrchestratorOnly && selectedAgent.tier !== 2 && (
                      <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.05)', color: C.muted, border: `1px solid ${C.border}` }}>
                        Orchestrator only
                      </span>
                    )}
                  </div>
                  <span className="text-xs max-w-xs truncate" style={{ color: C.muted }}>{tool?.description ?? ''}</span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )

  // ── Empty state ───────────────────────────────────────────────────────────

  const renderEmptyState = (title: string, body: string) => (
    <div className="flex flex-col items-center justify-center h-56 text-center">
      <div className="w-10 h-10 rounded-full flex items-center justify-center mb-3"
        style={{ background: C.cyanBg, border: `1px solid ${C.cyanBorder}` }}>
        <svg className="w-5 h-5" fill="none" stroke={C.cyan} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
      </div>
      <p className="font-medium text-sm text-white mb-1">{title}</p>
      <p className="text-xs max-w-xs" style={{ color: C.muted }}>{body}</p>
    </div>
  )

  // ── Channels ──────────────────────────────────────────────────────────────

  const renderChannels = () => (
    <div className="grid grid-cols-2 gap-4">
      {['Telegram', 'Discord', 'WhatsApp', 'iMessage'].map((ch) => (
        <div key={ch} className="rounded-lg p-4 flex flex-col items-center gap-2"
          style={{ background: C.panel, border: `1px solid ${C.border}` }}>
          <div className="w-12 h-12 rounded-full"
            style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${C.border}` }} />
          <p className="font-medium text-sm text-white">{ch}</p>
          <p className="text-xs" style={{ color: C.muted }}>Not connected</p>
          <button className="px-3 py-1 text-xs rounded cursor-not-allowed opacity-50"
            style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid rgba(255,255,255,0.06)`, color: '#4b5563' }}
            disabled>
            Coming soon
          </button>
        </div>
      ))}
    </div>
  )

  // ── Presets ───────────────────────────────────────────────────────────────

  const PRESET_DESCRIPTIONS: Record<string, string> = {
    Minimal:  '3 tools — file_read, memory_get, memory_search',
    Research: '5 tools — adds web_fetch, web_search',
    Build:    '8 tools — adds file_write, file_edit, artifact_write',
    Full:     'All credentialed tools',
  }

  const renderPresets = () => (
    <div className="grid grid-cols-2 gap-4">
      {(['Minimal', 'Research', 'Build', 'Full'] as const).map((p) => (
        <div key={p} className="rounded-lg p-4"
          style={{ background: C.panel, border: `1px solid ${C.cyanBorder}` }}>
          <h4 className="font-medium text-sm text-white mb-1">{p}</h4>
          <p className="text-xs mb-3" style={{ color: C.muted }}>{PRESET_DESCRIPTIONS[p]}</p>
          <button
            onClick={() => applyPreset(p)}
            className="px-3 py-1 text-xs rounded transition-colors"
            style={{ background: C.cyanBg, border: `1px solid ${C.cyanBorder}`, color: '#67e8f9' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,200,255,0.14)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = C.cyanBg)}
          >
            Apply
          </button>
        </div>
      ))}
    </div>
  )

  // ── Router ────────────────────────────────────────────────────────────────

  const renderContent = () => {
    switch (activeTab) {
      case 'Overview': return renderOverview()
      case 'Files':    return renderFiles()
      case 'Tools':    return renderTools()
      case 'Skills':   return renderEmptyState('No skills installed yet', 'Skills extend what this agent can do. The skills system is coming in a future phase.')
      case 'Plugins':  return renderEmptyState('No plugins installed', 'Plugin support is planned for a future phase.')
      case 'Channels': return renderChannels()
      case 'Presets':  return renderPresets()
      default:         return null
    }
  }

  return (
    <div className="flex h-full text-white overflow-hidden">
      {renderRoster()}
      <div className="flex-1 flex flex-col p-6 overflow-auto min-w-0">
        <div className="mb-5">
          <h2 className="text-lg font-semibold text-white">{DISPLAY_NAMES[selected] ?? selected}</h2>
          <p className="text-xs mt-0.5" style={{ color: C.muted }}>
            Tier {selectedAgent.tier} · {selectedAgent.allowedTools.length} credentialed tools
          </p>
        </div>
        {renderTabBar()}
        <div className="flex-1 overflow-y-auto">{renderContent()}</div>
      </div>
    </div>
  )
}

export default AgentsPage
