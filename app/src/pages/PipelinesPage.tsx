import React, { useEffect, useState } from 'react'
import { gateway } from '../lib/gateway-client'
import type { GatewayEvent } from '../lib/gateway-client'
import { useSettings, updateInstance, listInstances, type ProviderName } from '../lib/settings'

interface Pipeline {
  id: string
  name: string
  status: string
  currentStepId?: string
  tokensUsed: number
  costUsdUsed: number
  createdAt: number
  updatedAt: number
  resumeToken?: string   // HMAC-signed token issued at approval_gate; required by pipelines.approve
}

const fmtDate = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const StatusPill: React.FC<{ status: string }> = ({ status }) => {
  const styles: Record<string, React.CSSProperties> = {
    running:   { background: 'rgba(0,200,255,0.1)',   border: '1px solid rgba(0,200,255,0.35)',  color: '#67e8f9' },
    completed: { background: 'rgba(0,255,136,0.08)',  border: '1px solid rgba(0,255,136,0.25)',  color: '#6ee7b7' },
    failed:    { background: 'rgba(239,68,68,0.1)',   border: '1px solid rgba(239,68,68,0.3)',   color: '#f87171' },
    paused:    { background: 'rgba(245,158,11,0.1)',  border: '1px solid rgba(245,158,11,0.35)', color: '#fcd34d' },
    pending:   { background: 'rgba(255,255,255,0.04)',border: '1px solid rgba(255,255,255,0.1)', color: '#6B7280' },
  }
  return (
    <span className="text-xs px-2 py-0.5 rounded" style={styles[status] ?? styles.pending}>
      {status}
    </span>
  )
}

const PipelineRow: React.FC<{ pipeline: Pipeline; onApprove?: (id: string) => void; onReject?: (id: string) => void; onAbort?: (id: string) => void; onClick?: () => void }> = ({ pipeline, onApprove, onReject, onAbort, onClick }) => (
  <div onClick={onClick} className="rounded-xl p-4 transition-all cursor-pointer hover:brightness-125" style={{
    background: 'rgba(6,10,16,0.88)',
    border: pipeline.status === 'running' ? '1px solid rgba(0,200,255,0.3)'
          : pipeline.status === 'paused'  ? '1px solid rgba(245,158,11,0.35)'
          : '1px solid rgba(255,255,255,0.07)',
    boxShadow: pipeline.status === 'running' ? '0 0 12px rgba(0,200,255,0.06)'
             : pipeline.status === 'paused'  ? '0 0 12px rgba(245,158,11,0.08)'
             : undefined,
  }}>
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-medium text-sm truncate">{pipeline.name}</span>
          <StatusPill status={pipeline.status} />
          {pipeline.status === 'running' && (
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: '#00C8FF', boxShadow: '0 0 6px #00C8FF' }} />
          )}
        </div>
        {pipeline.currentStepId && (
          <p className="text-xs text-gray-500">Step: {pipeline.currentStepId}</p>
        )}
        <p className="text-xs text-gray-600 mt-1">{fmtDate(pipeline.updatedAt)}</p>
      </div>
      <div className="text-right shrink-0 flex flex-col items-end gap-1">
        <p className="text-xs text-gray-400">{(pipeline.tokensUsed ?? 0).toLocaleString()} tok</p>
        <p className="text-xs text-gray-500">${(pipeline.costUsdUsed ?? 0).toFixed(4)}</p>
        {pipeline.status === 'running' && onAbort && (
          <button
            onClick={(e) => { e.stopPropagation(); onAbort(pipeline.id) }}
            className="mt-1 px-2 py-0.5 rounded text-xs transition-colors"
            style={{
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.3)',
              color: '#f87171',
            }}>
            Stop
          </button>
        )}
      </div>
    </div>
    {pipeline.status === 'paused' && onApprove && onReject && (
      <div className="mt-3 pt-3 border-t border-amber-500/20 flex gap-2">
        <p className="text-xs text-amber-300 flex-1">⏸ Waiting for approval</p>
        <button onClick={(e) => { e.stopPropagation(); onApprove(pipeline.id) }}
          className="px-3 py-1 bg-green-700/50 hover:bg-green-600/60 border border-green-600/40 rounded text-xs text-green-300 transition-colors">
          Approve
        </button>
        <button onClick={(e) => { e.stopPropagation(); onReject(pipeline.id) }}
          className="px-3 py-1 bg-red-900/40 hover:bg-red-800/50 border border-red-600/30 rounded text-xs text-red-400 transition-colors">
          Reject
        </button>
      </div>
    )}
  </div>
)

interface ArtifactMeta { id: string; type: string; title: string; stepId: string | null; createdAt: number }
interface RunStatus {
  id: string; name: string; status: string; currentStepId?: string
  error?: string | null; tokensUsed: number; costUsdUsed: number; createdAt: number; updatedAt: number
}

const ART_COLOR: Record<string, string> = {
  plan: '#a78bfa', code: '#67e8f9', review: '#fcd34d', report: '#6ee7b7', data: '#f9a8d4',
}

// Run-detail modal — click a run to see its step outputs (artifacts) and read each one.
const RunDetailModal: React.FC<{ run: Pipeline; onClose: () => void }> = ({ run, onClose }) => {
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([])
  const [selected, setSelected] = useState<(ArtifactMeta & { content: string }) | null>(null)
  const [loadingSel, setLoadingSel] = useState(false)

  useEffect(() => {
    gateway.request('pipelines.status', { id: run.id })
      .then(r => setStatus((r as { pipeline?: RunStatus }).pipeline ?? null)).catch(() => {})
    gateway.request('artifacts.list', { pipelineRunId: run.id, limit: 100 })
      .then(r => setArtifacts((r as { artifacts?: ArtifactMeta[] }).artifacts ?? [])).catch(() => {})
  }, [run.id])

  const openArtifact = (id: string) => {
    setLoadingSel(true)
    gateway.request('artifacts.get', { id })
      .then(r => setSelected((r as { artifact?: ArtifactMeta & { content: string } }).artifact ?? null))
      .catch(() => {})
      .finally(() => setLoadingSel(false))
  }

  const tok = status?.tokensUsed ?? run.tokensUsed ?? 0
  const cost = status?.costUsdUsed ?? run.costUsdUsed ?? 0
  const step = status?.currentStepId ?? run.currentStepId
  const err = status?.error

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)' }}>
      <div onClick={e => e.stopPropagation()} className="rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col"
        style={{ background: 'rgba(8,12,20,0.98)', border: '1px solid rgba(0,200,255,0.25)', boxShadow: '0 0 40px rgba(0,0,0,0.6)' }}>

        {/* header */}
        <div className="flex items-start justify-between gap-4 p-4 border-b border-white/10">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-medium text-sm truncate">{run.name}</span>
              <StatusPill status={status?.status ?? run.status} />
            </div>
            <p className="text-xs text-gray-500">{step ? `Step: ${step} · ` : ''}{tok.toLocaleString()} tok · ${cost.toFixed(4)}</p>
            <p className="text-[11px] text-gray-600 mt-0.5">{fmtDate(run.createdAt)} → {fmtDate(run.updatedAt)}</p>
            {err && <p className="text-xs text-red-400 mt-1">⚠ {err}</p>}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none shrink-0">×</button>
        </div>

        {/* body: outputs list | viewer */}
        <div className="flex-1 grid grid-cols-2 min-h-0">
          <div className="overflow-y-auto border-r border-white/10 p-3 space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Outputs ({artifacts.length})</p>
            {artifacts.length === 0 && <p className="text-xs text-gray-600">No outputs recorded for this run.</p>}
            {artifacts.map(a => (
              <button key={a.id} onClick={() => openArtifact(a.id)}
                className="w-full text-left rounded p-2 transition-colors"
                style={{ background: selected?.id === a.id ? 'rgba(0,200,255,0.08)' : 'rgba(255,255,255,0.02)', border: `1px solid ${selected?.id === a.id ? 'rgba(0,200,255,0.3)' : 'rgba(255,255,255,0.06)'}` }}>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: 'rgba(255,255,255,0.05)', color: ART_COLOR[a.type] ?? '#9ca3af' }}>{a.type}</span>
                  <span className="text-xs text-gray-200 truncate">{a.title}</span>
                </div>
                {a.stepId && <p className="text-[10px] text-gray-600 mt-1">step: {a.stepId}</p>}
              </button>
            ))}
          </div>
          <div className="overflow-y-auto p-3">
            {loadingSel ? <p className="text-xs text-gray-500">Loading…</p>
              : selected ? (
                <>
                  <p className="text-xs text-gray-300 font-medium mb-2">{selected.title}</p>
                  <pre className="text-[11px] text-gray-400 whitespace-pre-wrap break-words font-mono leading-relaxed">{selected.content}</pre>
                </>
              ) : <p className="text-xs text-gray-600">Select an output to view its content.</p>}
          </div>
        </div>
      </div>
    </div>
  )
}

interface AvailablePipeline { name: string; source: 'builtin' | 'user'; title?: string; description?: string }

// Where pipelines run: the model/provider of the pipeline-type instance. Editing here
// updates that instance, so both UI-launched and Dave-launched pipelines use it.
const PipelineModelPicker: React.FC = () => {
  const { settings } = useSettings()
  const [providers, setProviders] = useState<ProviderName[]>([])
  const [models, setModels] = useState<{ id: string; label?: string }[]>([])
  const pipelineInst = settings?.instances.find(i => i.type === 'pipeline') ?? null

  useEffect(() => { listInstances().then(r => { if (r) setProviders(r.availableProviders) }).catch(() => {}) }, [])
  useEffect(() => {
    if (!pipelineInst) return
    gateway.request('models.list', { provider: pipelineInst.provider })
      .then(r => setModels((r as { models?: { id: string; label?: string }[] }).models ?? []))
      .catch(() => setModels([]))
  }, [pipelineInst?.provider])

  if (!settings) return null
  if (!pipelineInst) {
    return (
      <div className="rounded-xl p-3 text-xs text-gray-500" style={{ background: 'rgba(6,10,16,0.88)', border: '1px solid rgba(255,255,255,0.07)' }}>
        No pipeline instance yet — in the sidebar, add one with Workspace = Pipeline.
      </div>
    )
  }

  // Keep the current model selectable even if the catalogue hasn't loaded or omits it.
  const options = models.some(m => m.id === pipelineInst.model)
    ? models
    : [{ id: pipelineInst.model, label: pipelineInst.model }, ...models]

  return (
    <div className="rounded-xl p-3 flex items-center gap-3 flex-wrap" style={{ background: 'rgba(6,10,16,0.88)', border: '1px solid rgba(0,200,255,0.2)' }}>
      <span className="text-xs text-gray-400 shrink-0">Pipelines run on</span>
      <select value={pipelineInst.provider}
        onChange={e => void updateInstance(pipelineInst.id, { provider: e.target.value as ProviderName })}
        className="rounded px-2 py-1 text-xs bg-black/40 border border-white/10 text-gray-200 focus:outline-none focus:border-cyan-500/50">
        {providers.map(p => <option key={p} value={p}>{p}</option>)}
      </select>
      <select value={pipelineInst.model}
        onChange={e => void updateInstance(pipelineInst.id, { model: e.target.value })}
        className="flex-1 min-w-[220px] rounded px-2 py-1 text-xs bg-black/40 border border-white/10 text-gray-200 focus:outline-none focus:border-cyan-500/50">
        {options.length === 0 && <option value="">Loading…</option>}
        {options.map(m => <option key={m.id} value={m.id}>{m.label ?? m.id}</option>)}
      </select>
    </div>
  )
}

export const PipelinesPage: React.FC = () => {
  const [tab, setTab] = useState<'runs' | 'approvals'>('runs')
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [available, setAvailable] = useState<AvailablePipeline[]>([])
  const [showRun, setShowRun] = useState(false)
  const [runName, setRunName] = useState('')
  const [runTask, setRunTask] = useState('')
  const [runStatus, setRunStatus] = useState<'idle' | 'launching' | 'error'>('idle')
  const [runError, setRunError] = useState('')
  const [detailRun, setDetailRun] = useState<Pipeline | null>(null)

  useEffect(() => {
    gateway.request('pipelines.list', {}).then((res) => {
      setPipelines((res as { pipelines?: Pipeline[] }).pipelines ?? [])
    }).catch(() => {})

    gateway.request('pipelines.available', {}).then((res) => {
      const list = (res as { pipelines?: AvailablePipeline[] }).pipelines ?? []
      setAvailable(list)
      if (list.length > 0 && !runName) setRunName(list[0].name)
    }).catch(() => {})

    gateway.request('monitor.subscribe', {}).then((res) => {
      const r = res as { tick?: { pipelines?: Pipeline[] } }
      if (r.tick?.pipelines) setPipelines(r.tick.pipelines)
    }).catch(() => {})

    const unsub = gateway.onEvent((event: GatewayEvent) => {
      if (event.event === 'monitor.tick' && event.payload) {
        const tick = event.payload as { pipelines?: Pipeline[] }
        if (tick.pipelines) setPipelines(tick.pipelines)
      }
    })

    return () => {
      unsub()
      gateway.request('monitor.unsubscribe', {}).catch(() => {})
    }
  }, [])

  const handleRunPipeline = async () => {
    if (!runName.trim() || !runTask.trim()) return
    setRunStatus('launching')
    setRunError('')
    try {
      await gateway.request('pipelines.run', {
        name: runName,
        context: { task: runTask },
      })
      setShowRun(false)
      setRunTask('')
      setRunStatus('idle')
      setTab('runs')
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to start pipeline')
      setRunStatus('error')
    }
  }

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    const row = pipelines.find(p => p.id === id)
    if (!row) {
      setRunError(`run ${id} not in current pipeline list`)
      return
    }
    if (!row.resumeToken) {
      setRunError('no resume token on this run — cannot decide (run may have moved off paused)')
      return
    }
    try {
      await gateway.request('pipelines.approve', {
        runId:    id,
        token:    row.resumeToken,
        decision,
      })
      setRunError('')
    } catch (err) {
      setRunError(err instanceof Error ? err.message : `failed to ${decision}`)
    }
  }

  const handleApprove = (id: string) => decide(id, 'approve')
  const handleReject  = (id: string) => decide(id, 'reject')

  const handleAbort = async (id: string) => {
    try {
      await gateway.request('pipelines.abort', { runId: id })
    } catch (err) {
      console.error('abort failed', err)
    }
  }

  const runs = pipelines
  const approvals = pipelines.filter((p) => p.status === 'paused')

  return (
    <div className="p-6 h-full flex flex-col gap-4 overflow-hidden">

      <PipelineModelPicker />

      {/* Run pipeline panel */}
      {showRun && (
        <div className="rounded-xl p-4" style={{
          background: 'rgba(6,10,16,0.95)',
          border: '1px solid rgba(0,200,255,0.3)',
          boxShadow: '0 0 20px rgba(0,200,255,0.06)',
        }}>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium" style={{ color: '#00C8FF' }}>Run Pipeline</span>
            <button onClick={() => { setShowRun(false); setRunStatus('idle'); setRunError('') }}
              className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
          </div>
          <div className="flex flex-col gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Pipeline</label>
              <select value={runName} onChange={e => setRunName(e.target.value)}
                className="w-full rounded px-3 py-2 text-sm bg-black/40 border border-white/10 text-gray-200 focus:outline-none focus:border-cyan-500/50">
                {available.length === 0 && <option value="">Loading…</option>}
                {available.map(p => (
                  <option key={p.name} value={p.name}>
                    {p.title ? `${p.title} (${p.name})` : p.name}{p.source === 'user' ? ' — user' : ''}
                  </option>
                ))}
              </select>
              {(() => {
                const sel = available.find(p => p.name === runName)
                return sel?.description ? <p className="text-[11px] text-gray-500 mt-1">{sel.description}</p> : null
              })()}
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Task</label>
              <input
                value={runTask}
                onChange={e => setRunTask(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleRunPipeline()}
                placeholder="e.g. What is the latest news on AI regulation?"
                className="w-full rounded px-3 py-2 text-sm bg-black/40 border border-white/10 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-500/50"
              />
            </div>
            {runError && <p className="text-xs text-red-400">{runError}</p>}
            <button
              onClick={handleRunPipeline}
              disabled={runStatus === 'launching' || !runTask.trim()}
              className="w-full py-2 rounded text-sm font-medium transition-all disabled:opacity-40"
              style={{
                background: 'rgba(0,200,255,0.12)',
                border: '1px solid rgba(0,200,255,0.35)',
                color: '#00C8FF',
              }}>
              {runStatus === 'launching' ? 'Launching…' : 'Launch'}
            </button>
          </div>
        </div>
      )}

      {/* Sub-tabs */}
      <div className="flex items-center gap-1 border-b border-white/10 pb-0">
        {([['runs', 'Runs'], ['approvals', 'Approvals']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className="px-4 py-2 text-sm transition-colors focus:outline-none"
            style={{
              color: tab === id ? '#00C8FF' : '#6B7280',
              borderBottom: tab === id ? '2px solid #00C8FF' : '2px solid transparent',
            }}>
            {label}
            {id === 'approvals' && approvals.length > 0 && (
              <span className="ml-2 bg-amber-500 text-black text-xs font-bold px-1.5 py-0.5 rounded-full">
                {approvals.length}
              </span>
            )}
          </button>
        ))}
        <div className="ml-auto pb-1">
          <button
            onClick={() => { setShowRun(r => !r); setRunStatus('idle'); setRunError('') }}
            className="px-3 py-1 rounded text-xs font-medium transition-all"
            style={{
              background: showRun ? 'rgba(0,200,255,0.15)' : 'rgba(0,200,255,0.08)',
              border: '1px solid rgba(0,200,255,0.3)',
              color: '#00C8FF',
            }}>
            + Run Pipeline
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto space-y-3">
        {tab === 'runs' && (
          runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-gray-600">
              <p className="font-medium">No pipeline runs yet</p>
              <p className="text-xs mt-1">Runs appear here when Dave triggers a pipeline.</p>
            </div>
          ) : runs.map((p) => <PipelineRow key={p.id} pipeline={p} onAbort={handleAbort} onClick={() => setDetailRun(p)} />)
        )}
        {tab === 'approvals' && (
          approvals.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-gray-600">
              <p className="font-medium">No approvals waiting</p>
              <p className="text-xs mt-1">When a pipeline hits an approval gate, it will appear here and in chat.</p>
            </div>
          ) : approvals.map((p) => (
            <PipelineRow key={p.id} pipeline={p} onApprove={handleApprove} onReject={handleReject} onClick={() => setDetailRun(p)} />
          ))
        )}
      </div>

      {detailRun && <RunDetailModal run={detailRun} onClose={() => setDetailRun(null)} />}
    </div>
  )
}

export default PipelinesPage
