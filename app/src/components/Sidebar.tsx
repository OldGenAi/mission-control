import { useEffect, useState } from "react"
import { NavLink, useNavigate, useLocation } from "react-router-dom"
import { gateway } from "../lib/gateway-client"
import { listInstances, createInstance, setActiveInstance, deleteInstance, type Instance, type ProviderName } from "../lib/settings"

// SVG icon helper
const Icon = ({ d, children }: { d?: string; children?: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
    strokeLinecap="round" strokeLinejoin="round" width={15} height={15}>
    {d ? <path d={d} /> : children}
  </svg>
)

const icons: Record<string, React.ReactNode> = {
  overview:  <Icon><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></Icon>,
  chat:      <Icon d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  runs:      <Icon><polygon points="5 3 19 12 5 21 5 3"/></Icon>,
  approvals: <Icon><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></Icon>,
  artifacts: <Icon><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></Icon>,
  agents:    <Icon><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.58-7 8-7s8 3 8 7"/></Icon>,
  sessions:  <Icon><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></Icon>,
  memory:    <Icon><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></Icon>,
  live:      <Icon><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></Icon>,
  history:   <Icon><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></Icon>,
  errors:    <Icon><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></Icon>,
  channels:  <Icon><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.18h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.8a16 16 0 0 0 6.29 6.29l.98-.98a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></Icon>,
  settings:  <Icon><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></Icon>,
}

type NavItem = { label: string; href: string; icon: string }
type NavSection = { id: string; label: string; items: NavItem[] }

const SECTIONS: NavSection[] = [
  {
    id: "overview",
    label: "Overview",
    items: [{ label: "Overview", href: "/overview", icon: "overview" }],
  },
  {
    id: "chat",
    label: "Chat",
    items: [{ label: "Chat", href: "/chat", icon: "chat" }],
  },
  {
    id: "pipelines",
    label: "Pipelines",
    items: [
      { label: "Runs",      href: "/pipelines/runs",      icon: "runs"      },
      { label: "Approvals", href: "/pipelines/approvals", icon: "approvals" },
      { label: "Artifacts", href: "/artifacts",           icon: "artifacts" },
    ],
  },
  {
    id: "agents",
    label: "Agents",
    items: [
      { label: "Agents",   href: "/agents",   icon: "agents"   },
      { label: "Sessions", href: "/sessions", icon: "sessions" },
      { label: "Memory",   href: "/memory",   icon: "memory"   },
    ],
  },
  {
    id: "monitor",
    label: "Monitor",
    items: [
      { label: "Live",    href: "/monitor/live",    icon: "live"    },
      { label: "History", href: "/monitor/history", icon: "history" },
      { label: "Errors",  href: "/monitor/errors",  icon: "errors"  },
    ],
  },
  {
    id: "channels",
    label: "Channels",
    items: [{ label: "Channels", href: "/channels", icon: "channels" }],
  },
  {
    id: "settings",
    label: "Settings",
    items: [{ label: "Settings", href: "/settings", icon: "settings" }],
  },
]

const OGLogo = () => (
  <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
    <defs>
      <linearGradient id="og-grad" x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse">
        <stop offset="0%"   stopColor="#7c3aed" />
        <stop offset="55%"  stopColor="#6366f1" />
        <stop offset="100%" stopColor="#22d3ee" />
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="32" height="32" rx="10" fill="url(#og-grad)" opacity="0.18" />
    <rect x="2" y="2" width="32" height="32" rx="10" stroke="url(#og-grad)" strokeWidth="1.5" fill="none" />
    <text x="18" y="23" textAnchor="middle" fill="url(#og-grad)" fontSize="13" fontWeight="700" fontFamily="Inter, sans-serif">OG</text>
  </svg>
)

const ChevronIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" width={12} height={12}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
)

export function Sidebar() {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["settings"]))

  const toggle = (id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <OGLogo />
        <div className="sidebar-logo__text">
          <span className="sidebar-logo__name">Mission Control</span>
          <span className="sidebar-logo__eyebrow">OG AI</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="sidebar-nav">
        {SECTIONS.map(section => {
          const isCollapsed = collapsed.has(section.id)
          return (
            <div key={section.id} className="nav-section">
              <button
                className="nav-section__label"
                onClick={() => toggle(section.id)}
                type="button"
              >
                <span>{section.label}</span>
                <span className={`nav-section__chevron${isCollapsed ? " nav-section__chevron--collapsed" : ""}`}>
                  <ChevronIcon />
                </span>
              </button>
              {!isCollapsed && (
                <div className="nav-section__items">
                  {section.items.map(item => (
                    <NavLink
                      key={item.href}
                      to={item.href}
                      className={({ isActive }) =>
                        "nav-item" + (isActive ? " nav-item--active" : "")
                      }
                    >
                      <span className="nav-item__icon">{icons[item.icon]}</span>
                      <span>{item.label}</span>
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {/* Instances */}
      <InstancesPanel />

      {/* Footer */}
      <div className="sidebar-footer">
        <a href="#" className="nav-item" style={{ color: 'inherit', textDecoration: 'none' }}>Docs</a>
        <span className="sidebar-version">v0.2.0</span>
        <span className="sidebar-status-dot" title="Gateway online" />
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Instances panel — bottom of the sidebar.
// Lists instances, click to switch active, "+" to open the add modal.
// Subscribes to settings.changed so external edits show up live.
// ---------------------------------------------------------------------------

function InstancesPanel() {
  const [instances, setInstances] = useState<Instance[]>([])
  const [activeId,  setActiveId]  = useState<string | null>(null)
  const [available, setAvailable] = useState<ProviderName[]>([])
  const [showAdd,   setShowAdd]   = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  // The highlighted ("current") instance is sticky — it stays as you move through
  // general pages (Overview, Settings, Monitor…) and only changes when you open a
  // workspace that belongs to an instance: Chat (chat instance) or Runs (pipeline).
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const refresh = async () => {
    const r = await listInstances()
    if (!r) return
    setInstances(r.instances)
    setActiveId(r.activeInstanceId)
    setAvailable(r.availableProviders)
  }

  useEffect(() => {
    refresh()
    const unsub = gateway.onEvent(e => {
      if (e.event === 'settings.changed') refresh()
    })
    return unsub
  }, [])

  // Keep the sticky selection in step with the workspace you open: Chat → the chat
  // instance, Runs → the pipeline instance. General pages leave it unchanged.
  useEffect(() => {
    if (location.pathname.startsWith('/chat')) {
      const chat = instances.find(i => i.id === activeId) ?? instances.find(i => i.type !== 'pipeline')
      if (chat) setSelectedId(chat.id)
    } else if (location.pathname.startsWith('/pipelines')) {
      const pipe = instances.find(i => i.type === 'pipeline')
      if (pipe) setSelectedId(pipe.id)
    }
  }, [location.pathname, activeId, instances])

  const switchTo = async (inst: Instance) => {
    setSelectedId(inst.id)   // highlight the clicked instance immediately
    // A pipeline instance is a doorway to the Runs section, not the chat — open it
    // there and leave the chat's active instance untouched, so chat keeps its model.
    if (inst.type === 'pipeline') { navigate('/pipelines/runs'); return }
    navigate('/chat')
    if (inst.id === activeId) return
    const ok = await setActiveInstance(inst.id)
    if (ok) setActiveId(inst.id)
  }

  const remove = async (id: string) => {
    if (instances.length <= 1) return
    const ok = await deleteInstance(id)
    if (ok) await refresh()
  }

  return (
    <div className="px-3 py-3 border-t border-white/5 mt-2">
      <p className="text-xs uppercase tracking-wider text-gray-600 px-2 mb-2">Instances</p>
      <div className="flex flex-col gap-1">
        {instances.map(inst => {
          const isActive = inst.id === (selectedId ?? activeId)
          const initial  = inst.name.charAt(0).toUpperCase()
          return (
            <div key={inst.id}
              className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-colors cursor-pointer ${isActive ? 'bg-cyan-500/10 border-cyan-500/30' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}
              onClick={() => switchTo(inst)}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${isActive ? 'bg-cyan-500/30 border border-cyan-400/40 text-cyan-200' : 'bg-purple-600/40 border border-purple-500/30 text-purple-300'}`}>{initial}</span>
              <div className="flex flex-col leading-tight min-w-0">
                <span className={`text-xs truncate ${isActive ? 'text-cyan-200' : 'text-gray-400'}`}>{inst.name}</span>
                <span className="text-[10px] text-gray-600 truncate">{inst.type === 'pipeline' ? '→ Runs' : `${inst.provider} · ${inst.model}`}</span>
              </div>
              {instances.length > 1 && (
                <button
                  className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity text-gray-600 hover:text-red-400 text-xs"
                  onClick={e => { e.stopPropagation(); remove(inst.id) }}
                  title="Remove instance">×</button>
              )}
              {isActive && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-cyan-400" />}
            </div>
          )
        })}
      </div>
      <button
        className="mt-1.5 w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-gray-600 hover:text-gray-400 hover:bg-white/5 transition-colors text-xs"
        onClick={() => setShowAdd(true)}>
        <span className="w-5 h-5 rounded-full border border-dashed border-gray-700 flex items-center justify-center">+</span>
        Add instance
      </button>
      {showAdd && <AddInstanceModal available={available} onClose={() => setShowAdd(false)} onCreated={refresh} />}
    </div>
  )
}

function AddInstanceModal({ available, onClose, onCreated }: { available: ProviderName[]; onClose: () => void; onCreated: () => void }) {
  const [name, setName]         = useState('')
  const [provider, setProvider] = useState<ProviderName>(available[0] ?? 'local')
  const [model, setModel]       = useState('')
  const [type, setType]         = useState<'chat' | 'pipeline'>('chat')
  const [error, setError]       = useState<string | null>(null)
  const [busy, setBusy]         = useState(false)

  const submit = async () => {
    setError(null)
    if (!name.trim() || !model.trim()) { setError('Name and model are required.'); return }
    setBusy(true)
    const created = await createInstance(name.trim(), provider, model.trim(), type)
    setBusy(false)
    if (!created) { setError('Create failed — gateway rejected the request. Check provider credentials.'); return }
    onCreated()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#0a0f1a] border border-white/10 rounded-lg p-5 w-[360px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-medium text-white mb-3">Add instance</h3>
        <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Name</label>
        <input value={name} onChange={e => setName(e.target.value)} autoFocus
          placeholder="e.g. Coding-Sonnet"
          className="w-full mb-3 px-3 py-1.5 text-xs rounded bg-black/40 border border-white/10 text-gray-200 focus:outline-none focus:border-cyan-500/50" />
        <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Provider</label>
        <select value={provider} onChange={e => setProvider(e.target.value as ProviderName)}
          className="w-full mb-3 px-3 py-1.5 text-xs rounded bg-black/40 border border-white/10 text-gray-200 focus:outline-none focus:border-cyan-500/50">
          {available.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Workspace</label>
        <select value={type} onChange={e => setType(e.target.value as 'chat' | 'pipeline')}
          className="w-full mb-3 px-3 py-1.5 text-xs rounded bg-black/40 border border-white/10 text-gray-200 focus:outline-none focus:border-cyan-500/50">
          <option value="chat">Chat (Dave)</option>
          <option value="pipeline">Pipeline (Runs)</option>
        </select>
        <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Model</label>
        <input value={model} onChange={e => setModel(e.target.value)}
          placeholder="e.g. openai/gpt-oss-120b:free"
          className="w-full mb-3 px-3 py-1.5 text-xs rounded bg-black/40 border border-white/10 text-gray-200 focus:outline-none focus:border-cyan-500/50" />
        {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}
        <div className="flex justify-end gap-2 mt-2">
          <button onClick={onClose} className="px-3 py-1 text-xs rounded text-gray-400 hover:text-gray-200">Cancel</button>
          <button onClick={submit} disabled={busy}
            className="px-3 py-1 text-xs rounded bg-cyan-500/20 border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-50">
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}
