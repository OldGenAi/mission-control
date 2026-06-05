import React, { useEffect, useState } from 'react'
import { gateway } from '../lib/gateway-client'

interface Milestone {
  id: string
  agentId: string
  key: string
  content: string
  valid_from: number
}

const fmtDate = (ts: number) =>
  new Date(ts).toLocaleString([], {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

const MilestoneCard: React.FC<{ milestone: Milestone }> = ({ milestone }) => {
  const [expanded, setExpanded] = useState(false)
  const preview = milestone.content.length > 120 ? milestone.content.slice(0, 120) + '…' : milestone.content

  return (
    <div
      onClick={() => setExpanded((e) => !e)}
      className="rounded-xl p-4 cursor-pointer transition-all"
      style={{ background: 'rgba(6,10,16,0.88)', border: '1px solid rgba(255,255,255,0.07)' }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'rgba(0,200,255,0.3)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)')}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'rgba(0,200,255,0.08)', border: '1px solid rgba(0,200,255,0.25)', color: '#67e8f9' }}>
              milestone
            </span>
            <span className="text-xs text-gray-500">{milestone.agentId}</span>
          </div>
          <p className="font-medium text-sm text-gray-200 mb-1">{milestone.key}</p>
          <p className="text-sm text-gray-400 leading-relaxed">
            {expanded ? milestone.content : preview}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs text-gray-600">{fmtDate(milestone.valid_from)}</p>
          <p className="text-xs text-gray-600 mt-1">{expanded ? '▲ collapse' : '▼ expand'}</p>
        </div>
      </div>
    </div>
  )
}

export const MemoryPage: React.FC = () => {
  const [milestones, setMilestones] = useState<Milestone[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    gateway.request('memory.milestones', {})
      .then((res) => setMilestones((res as { milestones?: Milestone[] }).milestones ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filtered = search
    ? milestones.filter(
        (m) =>
          m.key.toLowerCase().includes(search.toLowerCase()) ||
          m.content.toLowerCase().includes(search.toLowerCase())
      )
    : milestones

  return (
    <div className="p-6 h-full flex flex-col gap-4 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search milestones…"
            className="w-full pl-9 pr-4 py-2 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none transition-colors"
            style={{ background: 'rgba(6,10,16,0.88)', border: '1px solid rgba(255,255,255,0.07)' }}
            onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(0,200,255,0.4)')}
            onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)')}
          />
        </div>
        <span className="text-xs text-gray-500">{filtered.length} milestone{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Cards */}
      <div className="flex-1 overflow-y-auto space-y-3">
        {loading ? (
          <div className="text-center py-12 text-gray-600">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-600">
            <p className="font-medium">No milestones yet</p>
            <p className="text-xs mt-2 max-w-xs text-center">
              Dave writes milestones here using{' '}
              <code className="text-gray-500">memory_write</code> with{' '}
              <code className="text-gray-500">type: milestone</code>.
              Only important checkpoints appear — not the full session history.
            </p>
          </div>
        ) : (
          filtered.map((m) => <MilestoneCard key={m.id} milestone={m} />)
        )}
      </div>
    </div>
  )
}

export default MemoryPage
