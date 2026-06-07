import React, { useEffect, useState } from 'react'
import { gateway } from '../lib/gateway-client'

interface Artifact {
  id: string
  type: string
  title: string
  content?: string
  agentId: string | null
  sessionId?: string | null
  pipelineRunId?: string | null
  createdAt: number
}

const fmtDate = (ts: number) =>
  new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

const TYPE_STYLES: Record<string, { bg: string; border: string; color: string }> = {
  plan:    { bg: 'rgba(245,158,11,0.1)',  border: 'rgba(245,158,11,0.35)',  color: '#fcd34d' },
  code:    { bg: 'rgba(0,200,255,0.08)',  border: 'rgba(0,200,255,0.3)',    color: '#67e8f9' },
  review:  { bg: 'rgba(139,92,246,0.1)', border: 'rgba(139,92,246,0.3)',   color: '#c4b5fd' },
  report:  { bg: 'rgba(0,255,136,0.07)', border: 'rgba(0,255,136,0.25)',   color: '#6ee7b7' },
  data:    { bg: 'rgba(59,130,246,0.1)', border: 'rgba(59,130,246,0.3)',   color: '#93c5fd' },
}

const TypeBadge: React.FC<{ type: string }> = ({ type }) => {
  const s = TYPE_STYLES[type] ?? { bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.1)', color: '#9CA3AF' }
  return (
    <span className="text-xs px-2 py-0.5 rounded font-mono" style={{
      background: s.bg, border: `1px solid ${s.border}`, color: s.color,
    }}>
      {type}
    </span>
  )
}

const ArtifactRow: React.FC<{ artifact: Artifact; expanded: boolean; onToggle: () => void; onDelete: () => void }> = ({
  artifact, expanded, onToggle, onDelete,
}) => (
  <div
    className="rounded-xl transition-all cursor-pointer"
    style={{
      background: 'rgba(6,10,16,0.88)',
      border: expanded ? '1px solid rgba(0,200,255,0.25)' : '1px solid rgba(255,255,255,0.07)',
      boxShadow: expanded ? '0 0 16px rgba(0,200,255,0.05)' : undefined,
    }}
    onClick={onToggle}
  >
    <div className="flex items-start justify-between gap-4 p-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <TypeBadge type={artifact.type} />
          <span className="text-sm font-medium text-gray-200 truncate">{artifact.title}</span>
        </div>
        <p className="text-xs text-gray-600">
          {artifact.agentId ?? 'unknown agent'} · {fmtDate(artifact.createdAt)}
        </p>
      </div>
      <div className="flex items-center gap-3 shrink-0 mt-0.5">
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          title="Delete artifact"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#6B7280', fontSize: 13, lineHeight: 1 }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#f87171')}
          onMouseLeave={(e) => (e.currentTarget.style.color = '#6B7280')}
        >
          ✕
        </button>
        <span className="text-gray-600 text-sm">{expanded ? '▲' : '▼'}</span>
      </div>
    </div>
    {expanded && artifact.content !== undefined && (
      <div className="px-4 pb-4 border-t border-white/5 pt-3">
        <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words leading-relaxed font-mono"
          style={{ maxHeight: 480, overflowY: 'auto' }}>
          {artifact.content}
        </pre>
        <p className="text-xs text-gray-700 mt-3 font-mono">{artifact.id}</p>
      </div>
    )}
  </div>
)

export const ArtifactsPage: React.FC = () => {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [fullContent, setFullContent] = useState<Record<string, string>>({})

  const load = () => {
    setLoading(true)
    gateway.request('artifacts.list', { limit: 50 })
      .then((res) => {
        const r = res as { artifacts?: Artifact[] }
        setArtifacts(r.artifacts ?? [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleToggle = async (artifact: Artifact) => {
    if (expandedId === artifact.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(artifact.id)
    if (fullContent[artifact.id] !== undefined) return
    try {
      const res = await gateway.request('artifacts.get', { id: artifact.id }) as { artifact?: Artifact }
      if (res.artifact?.content !== undefined) {
        setFullContent(prev => ({ ...prev, [artifact.id]: res.artifact!.content! }))
        setArtifacts(prev => prev.map(a => a.id === artifact.id ? { ...a, content: res.artifact!.content } : a))
      }
    } catch { /* ignore */ }
  }

  const handleDelete = async (artifact: Artifact) => {
    if (!window.confirm(`Delete artifact "${artifact.title}"?`)) return
    try {
      await gateway.request('artifacts.delete', { id: artifact.id })
      setArtifacts(prev => prev.filter(a => a.id !== artifact.id))
      if (expandedId === artifact.id) setExpandedId(null)
    } catch { /* ignore */ }
  }

  return (
    <div className="p-6 h-full flex flex-col gap-4 overflow-hidden">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">Artifacts</h2>
        <button
          onClick={load}
          className="px-3 py-1 rounded text-xs transition-all"
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: '#6B7280',
          }}>
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2">
        {loading ? (
          <div className="flex items-center justify-center h-48 text-gray-600 text-sm">Loading…</div>
        ) : artifacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-600">
            <p className="font-medium">No artifacts yet</p>
            <p className="text-xs mt-1">Artifacts appear here when agents complete tasks.</p>
          </div>
        ) : (
          artifacts.map(a => (
            <ArtifactRow
              key={a.id}
              artifact={a}
              expanded={expandedId === a.id}
              onToggle={() => handleToggle(a)}
              onDelete={() => handleDelete(a)}
            />
          ))
        )}
      </div>
    </div>
  )
}

export default ArtifactsPage
