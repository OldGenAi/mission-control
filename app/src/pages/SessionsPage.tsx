import React, { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { gateway } from '../lib/gateway-client'

interface SessionRow {
  id: string
  agentId: string
  title: string
  createdAt: number
  updatedAt: number
  deletedAt?: number | null
}

type View = 'active' | 'trash'

const PAGE_SIZE = 20

const fmtDate = (ts: number) =>
  new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

const sessionStatus = (s: SessionRow): { label: string; color: string } => {
  const age = Date.now() - s.updatedAt
  if (age < 5 * 60 * 1000) return { label: 'Active', color: '#00C8FF' }
  if (age < 60 * 60 * 1000) return { label: 'Idle', color: '#F59E0B' }
  return { label: 'Ended', color: '#4B5563' }
}

export const SessionsPage: React.FC = () => {
  const navigate = useNavigate()
  const [view, setView] = useState<View>('active')
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [editId, setEditId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = (v: View = view) => {
    setLoading(true)
    gateway.request(v === 'trash' ? 'sessions.listDeleted' : 'sessions.list', {})
      .then((res) => setSessions((res as { sessions?: SessionRow[] }).sessions ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load(view)
    setPage(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable; re-run only on view change
  }, [view])

  const switchView = (v: View) => { setEditId(null); setView(v) }

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return q
      ? sessions.filter((s) => s.title.toLowerCase().includes(q) || s.agentId.toLowerCase().includes(q))
      : sessions
  }, [sessions, search])

  const pageCount = Math.ceil(filtered.length / PAGE_SIZE)
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // Active → moves the session to Trash (recoverable). Not destructive.
  const handleDelete = async (id: string) => {
    setBusyId(id)
    try {
      await gateway.request('sessions.delete', { sessionId: id })
      setSessions((prev) => prev.filter((s) => s.id !== id))
    } catch { /* ignore */ }
    setBusyId(null)
  }

  // Trash → brings the session back to Active, messages intact.
  const handleRestore = async (id: string) => {
    setBusyId(id)
    try {
      await gateway.request('sessions.restore', { sessionId: id })
      setSessions((prev) => prev.filter((s) => s.id !== id))
    } catch { /* ignore */ }
    setBusyId(null)
  }

  // Trash → permanent. Irreversible, so confirm first.
  const handlePurge = async (id: string) => {
    if (!window.confirm('Delete this session forever? Its messages cannot be recovered.')) return
    setBusyId(id)
    try {
      await gateway.request('sessions.purge', { sessionId: id })
      setSessions((prev) => prev.filter((s) => s.id !== id))
    } catch { /* ignore */ }
    setBusyId(null)
  }

  const commitRename = async (id: string) => {
    const title = editTitle.trim()
    try {
      await gateway.request('sessions.rename', { sessionId: id, title })
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
    } catch { /* ignore */ }
    setEditId(null)
  }

  const tabBtn = (v: View): React.CSSProperties => ({
    padding: '6px 14px', fontSize: 12, borderRadius: 8, cursor: 'pointer',
    background: view === v ? 'rgba(0,200,255,0.12)' : 'rgba(255,255,255,0.03)',
    border: `1px solid ${view === v ? 'rgba(0,200,255,0.4)' : 'rgba(255,255,255,0.07)'}`,
    color: view === v ? '#67e8f9' : '#9ca3af', transition: 'all 0.15s',
    fontWeight: view === v ? 600 : 400,
  })

  return (
    <div className="p-6 h-full flex flex-col gap-4 overflow-hidden">
      {/* Search + view toggle */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" fill="none" stroke="#4B5563" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0) }}
            placeholder="Search sessions…"
            className="w-full pl-9 pr-4 py-2 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none transition-colors"
            style={{ background: 'rgba(6,10,16,0.88)', border: '1px solid rgba(255,255,255,0.07)' }}
            onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(0,200,255,0.4)')}
            onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)')}
          />
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => switchView('active')} style={tabBtn('active')}>Active</button>
          <button onClick={() => switchView('trash')} style={tabBtn('trash')}>Trash</button>
        </div>
        <span className="text-xs ml-auto" style={{ color: '#4B5563' }}>{filtered.length} session{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto rounded-xl" style={{ background: 'rgba(6,10,16,0.88)', border: '1px solid rgba(255,255,255,0.07)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left">
              {['Session', 'Agent', 'Status', view === 'trash' ? 'Deleted' : 'Last updated', 'Created', ''].map((h, i) => (
                <th key={`${h}-${i}`} className="px-4 py-3 text-xs uppercase tracking-wider text-gray-500 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-600">Loading…</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-600">{view === 'trash' ? 'Trash is empty.' : 'No sessions found.'}</td></tr>
            ) : visible.map((s) => {
              const status = sessionStatus(s)
              const isEditing = editId === s.id
              const isTrash = view === 'trash'
              return (
                <tr
                  key={s.id}
                  className={`border-b border-white/5 transition-colors ${isTrash ? '' : 'hover:bg-white/5 cursor-pointer'}`}
                  onClick={() => !isEditing && !isTrash && navigate(`/chat?sessionId=${s.id}`)}
                >
                  <td className="px-4 py-3 max-w-xs">
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => commitRename(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(s.id)
                          if (e.key === 'Escape') setEditId(null)
                        }}
                        className="rounded px-2 py-1 text-sm text-white focus:outline-none w-full"
                        style={{ background: 'rgba(6,10,16,0.9)', border: '1px solid rgba(0,200,255,0.4)' }}
                      />
                    ) : (
                      <span className="truncate block">{s.title || <span className="text-gray-500 italic">Untitled</span>}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400">{s.agentId}</td>
                  <td className="px-4 py-3" style={{ color: isTrash ? '#f87171' : status.color, fontFamily: "'SF Mono','Fira Code',monospace", fontSize: 12 }}>{isTrash ? 'In Trash' : status.label}</td>
                  <td className="px-4 py-3 text-gray-400">{isTrash ? (s.deletedAt ? fmtDate(s.deletedAt) : '—') : fmtDate(s.updatedAt)}</td>
                  <td className="px-4 py-3 text-gray-500">{fmtDate(s.createdAt)}</td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex gap-2 justify-end">
                      {isTrash ? (
                        <>
                          <button
                            onClick={() => handleRestore(s.id)}
                            disabled={busyId === s.id}
                            className="px-2 py-1 text-xs rounded transition-colors disabled:opacity-50"
                            style={{ background: 'rgba(0,255,136,0.08)', border: '1px solid rgba(0,255,136,0.25)', color: '#6ee7b7' }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,255,136,0.15)')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(0,255,136,0.08)')}
                          >
                            {busyId === s.id ? '…' : 'Restore'}
                          </button>
                          <button
                            onClick={() => handlePurge(s.id)}
                            disabled={busyId === s.id}
                            className="px-2 py-1 text-xs rounded transition-colors disabled:opacity-50"
                            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171' }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(239,68,68,0.15)')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(239,68,68,0.08)')}
                          >
                            {busyId === s.id ? '…' : 'Delete forever'}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => { setEditId(s.id); setEditTitle(s.title) }}
                            className="px-2 py-1 text-xs rounded transition-colors"
                            style={{ background: 'rgba(0,200,255,0.06)', border: '1px solid rgba(0,200,255,0.2)', color: '#67e8f9' }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,200,255,0.12)')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(0,200,255,0.06)')}
                          >
                            Rename
                          </button>
                          <button
                            onClick={() => handleDelete(s.id)}
                            disabled={busyId === s.id}
                            className="px-2 py-1 text-xs rounded transition-colors disabled:opacity-50"
                            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171' }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(239,68,68,0.15)')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(239,68,68,0.08)')}
                            title="Move to Trash (recoverable)"
                          >
                            {busyId === s.id ? '…' : 'Delete'}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
            className="px-3 py-1 text-xs rounded disabled:opacity-30 transition-colors"
            style={{ background: 'rgba(0,200,255,0.06)', border: '1px solid rgba(0,200,255,0.2)', color: '#67e8f9' }}>
            ← Prev
          </button>
          <span className="text-xs" style={{ color: '#4B5563' }}>{page + 1} / {pageCount}</span>
          <button onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}
            className="px-3 py-1 text-xs rounded disabled:opacity-30 transition-colors"
            style={{ background: 'rgba(0,200,255,0.06)', border: '1px solid rgba(0,200,255,0.2)', color: '#67e8f9' }}>
            Next →
          </button>
        </div>
      )}
    </div>
  )
}

export default SessionsPage
