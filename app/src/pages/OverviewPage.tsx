import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { gateway } from '../lib/gateway-client'
import type { GatewayEvent } from '../lib/gateway-client'
import { useSettings } from '../lib/settings'

interface SessionRow {
  id: string
  agentId: string
  title: string
  createdAt: number
  updatedAt: number
}

interface Pipeline {
  id: string
  name: string
  status: string
  currentStepId?: string
  tokensUsed: number
  costUsdUsed: number
  updatedAt: number
}

interface AgentStatusPayload {
  agentId: string
  status: string
  detail?: string
}

interface FeedEntry {
  id: number
  time: number
  label: string
  detail: string
  kind: 'session' | 'pipeline' | 'tool' | 'agent' | 'error'
}

const TODAY_START = new Date().setHours(0, 0, 0, 0)

const feedBorderColor: Record<string, string> = {
  session: '#3B82F6',
  pipeline: '#F59E0B',
  tool: '#00C8FF',
  agent: '#7B61FF',
  error: '#EF4444',
}

const feedLabelColor: Record<string, string> = {
  session: 'text-blue-400',
  pipeline: 'text-amber-400',
  tool: 'text-cyan-400',
  agent: 'text-violet-400',
  error: 'text-red-400',
}

const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
)

const PipelineIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7M11 18H8a2 2 0 0 1-2-2V9"/>
  </svg>
)

const BellIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
)

const AgentsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
)

export const OverviewPage: React.FC = () => {
  const navigate = useNavigate()
  const { settings } = useSettings()
  const [gatewayOk, setGatewayOk] = useState(false)
  const [uptime, setUptime] = useState(0)
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [modelsOk, setModelsOk] = useState(false)
  const [activeProvider, setActiveProvider] = useState<string>('local')
  const [daveStatus, setDaveStatus] = useState<string>('Offline')
  const [daveDetail, setDaveDetail] = useState<string>('')
  const [totalTokens, setTotalTokens] = useState(0)
  const [totalCost, setTotalCost] = useState(0)
  const [feed, setFeed] = useState<FeedEntry[]>([])
  const feedSeqRef = useRef(0)

  const addFeed = useCallback((entry: Omit<FeedEntry, 'id' | 'time'>) => {
    feedSeqRef.current += 1
    const id = feedSeqRef.current
    setFeed((prev) => [{ ...entry, id, time: Date.now() }, ...prev].slice(0, 20))
  }, [])

  useEffect(() => {
    gateway.request('health', {}).then((res) => {
      const r = res as { status?: string; uptime?: number; provider?: string; model?: string }
      setGatewayOk(r.status === 'ok')
      setUptime(r.uptime ?? 0)
      setActiveProvider(r.provider ?? 'local')
    }).catch(() => setGatewayOk(false))

    gateway.request('sessions.list', {}).then((res) => {
      const r = res as { sessions?: SessionRow[] }
      setSessions(r.sessions ?? [])
    }).catch(() => {})

    gateway.request('models.list', {}).then((res) => {
      const r = res as { models?: unknown[] }
      setModelsOk((r.models?.length ?? 0) > 0)
    }).catch(() => setModelsOk(false))

    gateway.request('monitor.subscribe', {}).then((res) => {
      const r = res as { tick?: { pipelines?: Pipeline[]; agents?: AgentStatusPayload[] } }
      if (r.tick?.pipelines) setPipelines(r.tick.pipelines)
      // Gateway is up and Dave is reachable — mark Online. agent.status events will update from here.
      setDaveStatus(prev => prev === 'Offline' ? 'Online' : prev)
    }).catch(() => {})

    const refreshSessions = () => {
      gateway.request('sessions.list', {}).then((res) => {
        const r = res as { sessions?: SessionRow[] }
        setSessions(r.sessions ?? [])
      }).catch(() => {})
    }

    const unsub = gateway.onEvent((event: GatewayEvent) => {
      if (event.event === 'monitor.tick' && event.payload) {
        const tick = event.payload as {
          pipelines?: Pipeline[]
          agents?: AgentStatusPayload[]
          totalTokens?: number
          totalCostUsd?: number
        }
        if (tick.pipelines) setPipelines(tick.pipelines)
        // Use gateway-side totals (covers chat + pipelines), not just pipelines.
        if (typeof tick.totalTokens === 'number') setTotalTokens(tick.totalTokens)
        if (typeof tick.totalCostUsd === 'number') setTotalCost(tick.totalCostUsd)
        // Refresh sessions list so "Sessions Today" picks up new chats.
        refreshSessions()
      }
      if (event.event === 'agent.status' && event.payload) {
        const p = event.payload as unknown as AgentStatusPayload
        if (p.agentId?.toLowerCase().includes('dave') || p.agentId === 'tier1_agent') {
          const mapped = p.status === 'idle' ? 'Online'
            : p.status === 'thinking' ? 'Thinking'
            : p.status === 'tool_running' ? 'Working'
            : p.status
          setDaveStatus(mapped)
          setDaveDetail(p.detail ?? '')
          addFeed({ label: 'Dave', detail: p.detail ?? p.status, kind: 'agent' })
        }
      }
      if (event.event === 'pipeline.tick' && event.payload) {
        const p = event.payload as { name?: string; status?: string }
        addFeed({ label: 'Pipeline', detail: `${p.name ?? 'pipeline'} → ${p.status}`, kind: 'pipeline' })
      }
      if (event.event === 'session.tool' && event.payload) {
        const p = event.payload as { toolName?: string }
        addFeed({ label: 'Tool', detail: p.toolName ?? 'tool call', kind: 'tool' })
      }
    })

    return () => {
      unsub()
      gateway.request('monitor.unsubscribe', {}).catch(() => {})
    }
  }, [addFeed])

  // "Today" = touched today (updated_at), not just created today.
  // A session started at 23:55 yesterday and still in use right now should count.
  const sessionsToday = sessions.filter((s) => (s.updatedAt ?? s.createdAt) >= TODAY_START).length
  const running = pipelines.filter((p) => p.status === 'running').length
  const pending = pipelines.filter((p) => p.status === 'paused').length

  const fmtUptime = (s: number) => {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }

  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const daveOnline = daveStatus !== 'Offline'
  const daveThinking = daveStatus === 'Thinking' || daveStatus === 'Working'

  const daveDotColor = daveOnline ? (daveThinking ? '#a78bfa' : '#4ade80') : '#f87171'
  const davePillBg = daveOnline ? (daveThinking ? 'rgba(167,139,250,0.12)' : 'rgba(74,222,128,0.1)') : 'rgba(248,113,113,0.1)'
  const davePillBorder = daveOnline ? (daveThinking ? 'rgba(167,139,250,0.3)' : 'rgba(74,222,128,0.25)') : 'rgba(248,113,113,0.25)'
  const davePillText = daveOnline ? (daveThinking ? '#c4b5fd' : '#86efac') : '#fca5a5'
  const daveAccent = daveThinking ? '#7B61FF' : daveOnline ? '#00FF88' : '#EF4444'

  const statCards = [
    {
      label: 'Sessions Today',
      value: String(sessionsToday),
      sub: `${sessions.length} total`,
      accent: '#00C8FF',
      valueColor: '#ffffff',
    },
    {
      label: 'Tokens Used',
      value: totalTokens > 0 ? totalTokens.toLocaleString() : '0',
      sub: `$${totalCost.toFixed(4)}`,
      accent: '#00FF88',
      valueColor: '#ffffff',
    },
    {
      label: 'Pipelines',
      value: String(running),
      sub: running > 0 ? 'running now' : pending > 0 ? `${pending} pending approval` : 'none running',
      accent: '#F59E0B',
      valueColor: running > 0 ? '#fcd34d' : '#ffffff',
    },
    {
      label: 'Gateway Uptime',
      value: gatewayOk ? fmtUptime(uptime) : '—',
      sub: gatewayOk ? 'Connected' : 'Offline',
      accent: gatewayOk ? '#00FF88' : '#EF4444',
      valueColor: gatewayOk ? '#ffffff' : '#fca5a5',
    },
  ]

  // Health reflects EVERY instance's provider, not just the active chat one — so a
  // provider used only by the pipeline instance shows as in-use (with its model and
  // role), not "Not selected".
  type HealthStatus = 'active' | 'idle' | 'error'
  const instances = settings?.instances ?? []
  const activeInstanceId = settings?.activeInstanceId
  const roleOf = (i: { id: string; type?: string }) =>
    i.type === 'pipeline' ? 'pipeline' : i.id === activeInstanceId ? 'chat' : 'instance'
  const providerHealth = (provider: string): { status: HealthStatus; detail: string } => {
    const using = instances.filter(i => i.provider === provider)
    if (using.length === 0) return { status: 'idle', detail: 'Not configured' }
    // Reachability is only known live for the ACTIVE provider (via modelsOk); a
    // provider assigned to another instance is shown as in-use.
    const status: HealthStatus = (activeProvider === provider && !modelsOk) ? 'error' : 'active'
    const detail = using.map(i => `${i.model} · ${roleOf(i)}`).join('   ')
    return { status, detail }
  }
  const lmHealth = providerHealth('local')
  const orHealth = providerHealth('openrouter')

  const healthItems: { label: string; status: HealthStatus; detail: string }[] = [
    { label: 'Gateway',    status: gatewayOk ? 'active' : 'error', detail: gatewayOk ? 'Connected' : 'Offline' },
    { label: 'LM Studio',  status: lmHealth.status, detail: lmHealth.detail },
    { label: 'OpenRouter', status: orHealth.status, detail: orHealth.detail },
    { label: 'SQLite',     status: gatewayOk ? 'active' : 'error', detail: gatewayOk ? `WAL mode · ${fmtUptime(uptime)}` : 'Offline' },
  ]

  const DOT: Record<HealthStatus, { color: string; glow: boolean }> = {
    active: { color: '#00C8FF', glow: true },
    idle:   { color: '#6b7280', glow: false },
    error:  { color: '#ef4444', glow: true },
  }

  return (
    <div className="p-6 space-y-5 h-full overflow-y-auto">

      {/* Top row: Dave hero + stat cards */}
      <div className="grid grid-cols-5 gap-4">

        {/* Dave hero card */}
        <div
          className="relative rounded-xl p-5 overflow-hidden flex flex-col justify-between"
          style={{
            background: 'rgba(6,10,16,0.92)',
            border: `1px solid ${daveAccent}28`,
            borderTop: `2px solid ${daveAccent}`,
          }}
        >
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ background: `radial-gradient(ellipse at 50% 0%, ${daveAccent}22 0%, transparent 60%)` }}
          />
          <div className="relative">
            <p className="text-xs uppercase tracking-widest text-gray-500 mb-3">Personal Agent</p>
            <p className="text-3xl font-bold text-white mb-4">Dave</p>
            <div
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm font-medium"
              style={{ background: davePillBg, borderColor: davePillBorder, color: davePillText }}
            >
              <span className="relative flex h-2 w-2 shrink-0">
                {daveThinking && (
                  <span
                    className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
                    style={{ background: daveDotColor }}
                  />
                )}
                <span
                  className="relative inline-flex rounded-full h-2 w-2"
                  style={{ background: daveDotColor }}
                />
              </span>
              {daveStatus}
            </div>
            {daveDetail && (
              <p className="text-xs text-gray-500 mt-2 truncate">{daveDetail}</p>
            )}
          </div>
          <p className="relative text-xs text-gray-600 mt-4">Tier 1 &middot; Always on</p>
        </div>

        {/* Stat cards */}
        {statCards.map(({ label, value, sub, accent, valueColor }) => (
          <div
            key={label}
            className="relative rounded-xl p-5 flex flex-col justify-between cursor-default transition-all duration-200"
            style={{
              background: 'rgba(6,10,16,0.88)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderTop: `2px solid ${accent}`,
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLDivElement
              el.style.background = 'rgba(255,255,255,0.06)'
              el.style.boxShadow = `0 0 30px ${accent}10`
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLDivElement
              el.style.background = 'rgba(255,255,255,0.04)'
              el.style.boxShadow = ''
            }}
          >
            <p className="text-xs uppercase tracking-widest text-gray-500 mb-3">{label}</p>
            <p className="text-4xl font-bold tracking-tight" style={{ color: valueColor, fontFamily: "'JetBrains Mono', 'SF Mono', monospace" }}>
              {value}
            </p>
            {sub && <p className="text-xs text-gray-500 mt-2">{sub}</p>}
          </div>
        ))}
      </div>

      {/* System health strip */}
      <div
        className="rounded-xl px-5 py-4"
        style={{ background: 'rgba(6,10,16,0.88)', border: '1px solid rgba(255,255,255,0.07)' }}
      >
        <p className="text-xs uppercase tracking-widest text-gray-500 mb-3">System Health</p>
        <div className="flex items-center gap-3 flex-wrap">
          {healthItems.map(({ label, status, detail }) => (
            <div
              key={label}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium border"
              style={{ background: 'rgba(0,200,255,0.07)', color: '#67e8f9', borderColor: 'rgba(0,200,255,0.22)' }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{
                  background: DOT[status].color,
                  boxShadow: DOT[status].glow ? `0 0 6px ${DOT[status].color}` : 'none',
                }}
              />
              <span>{label}</span>
              <span className="opacity-40 text-xs">&middot;</span>
              <span className="text-xs opacity-60">{detail}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-3 gap-4">

        {/* Activity feed */}
        <div
          className="col-span-2 rounded-xl p-5"
          style={{ background: 'rgba(6,10,16,0.88)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <p className="text-xs uppercase tracking-widest text-gray-500 mb-4">Recent Activity</p>
          {feed.length === 0 ? (
            <p className="text-sm text-gray-600 py-8 text-center">
              No activity yet &mdash; send Dave a message to start.
            </p>
          ) : (
            <div className="space-y-0.5">
              {feed.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-3 py-2 px-3 rounded-r-lg text-sm"
                  style={{
                    borderLeft: `3px solid ${feedBorderColor[e.kind]}`,
                    background: `${feedBorderColor[e.kind]}0a`,
                  }}
                >
                  <span className="text-xs text-gray-600 shrink-0 font-mono w-10">
                    {fmtTime(e.time)}
                  </span>
                  <span className={`shrink-0 text-xs font-semibold uppercase tracking-wider w-16 ${feedLabelColor[e.kind]}`}>
                    {e.label}
                  </span>
                  <span className="text-gray-400 text-sm truncate">{e.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick actions */}
        <div
          className="rounded-xl p-5 flex flex-col gap-3"
          style={{ background: 'rgba(6,10,16,0.88)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <p className="text-xs uppercase tracking-widest text-gray-500 mb-1">Quick Actions</p>

          <button
            onClick={() => navigate('/chat')}
            className="w-full py-3 px-4 rounded-xl text-sm font-semibold transition-all duration-200 flex items-center gap-3 active:scale-95"
            style={{
              background: 'rgba(0,200,255,0.1)',
              border: '1px solid rgba(0,200,255,0.35)',
              color: '#00C8FF',
              boxShadow: '0 0 20px rgba(0,200,255,0.15)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(0,200,255,0.16)'
              e.currentTarget.style.boxShadow = '0 0 28px rgba(0,200,255,0.28)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(0,200,255,0.1)'
              e.currentTarget.style.boxShadow = '0 0 20px rgba(0,200,255,0.15)'
            }}
          >
            <PlusIcon />
            New session with Dave
          </button>

          <button
            onClick={() => navigate('/pipelines/runs')}
            className="w-full py-3 px-4 rounded-xl text-sm font-medium transition-all duration-200 flex items-center gap-3"
            style={{
              background: 'rgba(0,200,255,0.04)',
              border: '1px solid rgba(0,200,255,0.15)',
              color: '#67e8f9',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(0,200,255,0.09)'
              e.currentTarget.style.borderColor = 'rgba(0,200,255,0.28)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(0,200,255,0.04)'
              e.currentTarget.style.borderColor = 'rgba(0,200,255,0.15)'
            }}
          >
            <PipelineIcon />
            {running > 0 ? `${running} active pipeline${running > 1 ? 's' : ''}` : 'View pipelines'}
          </button>

          <button
            onClick={() => navigate('/pipelines/approvals')}
            className="w-full py-3 px-4 rounded-xl text-sm font-medium transition-all duration-200 flex items-center gap-3"
            style={{
              background: pending > 0 ? 'rgba(245,158,11,0.1)' : 'rgba(0,200,255,0.04)',
              border: pending > 0 ? '1px solid rgba(245,158,11,0.3)' : '1px solid rgba(0,200,255,0.15)',
              color: pending > 0 ? '#fcd34d' : '#67e8f9',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = pending > 0 ? 'rgba(245,158,11,0.16)' : 'rgba(0,200,255,0.09)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = pending > 0 ? 'rgba(245,158,11,0.1)' : 'rgba(0,200,255,0.04)'
            }}
          >
            <BellIcon />
            <span className="flex-1 text-left">Pending approvals</span>
            {pending > 0 && (
              <span
                className="text-xs font-bold px-2 py-0.5 rounded-full"
                style={{ background: '#F59E0B', color: '#000' }}
              >
                {pending}
              </span>
            )}
          </button>

          <button
            onClick={() => navigate('/agents')}
            className="w-full py-3 px-4 rounded-xl text-sm font-medium transition-all duration-200 flex items-center gap-3 mt-auto"
            style={{
              background: 'rgba(0,200,255,0.04)',
              border: '1px solid rgba(0,200,255,0.12)',
              color: '#4db8cc',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(0,200,255,0.09)'
              e.currentTarget.style.color = '#67e8f9'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(0,200,255,0.04)'
              e.currentTarget.style.color = '#4db8cc'
            }}
          >
            <AgentsIcon />
            View all agents
          </button>
        </div>

      </div>
    </div>
  )
}

export default OverviewPage
