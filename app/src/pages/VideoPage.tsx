import React, { useEffect, useRef, useState } from 'react'
import { gateway } from '../lib/gateway-client'

type ParamSpec =
  | { kind: 'text'; maxLength: number; required?: boolean; default?: string }
  | { kind: 'int'; min: number; max: number; default?: number }
  | { kind: 'choice'; options: string[]; default?: string }
  | { kind: 'image'; required?: boolean }

interface Recipe { id: string; name: string; description: string; hardware: string; params: Record<string, ParamSpec> }

interface ComfyStatus {
  reachable: boolean
  url: string
  problem?: string
  version?: string
  warnings?: string[]
  recipes?: Array<{ id: string; missing: string[] }>
  device?: { name: string; vramTotalGb: number; vramFreeGb: number } | null
  diskBytes?: number
}

type Status = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

interface Video {
  id: string
  recipeId: string
  params: Record<string, unknown>
  status: Status
  error: string | null
  fileBytes: number | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  link: string | null
}

interface Live { step?: number; steps?: number; stage?: string; preview?: string; startedAt: number }

const card: React.CSSProperties = { background: 'rgba(6,10,16,0.88)', border: '1px solid rgba(255,255,255,0.07)' }
const input: React.CSSProperties = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: '#E5E7EB' }
const button = (primary = false): React.CSSProperties => ({
  background: primary ? 'rgba(0,200,255,0.12)' : 'rgba(255,255,255,0.05)',
  border: `1px solid ${primary ? 'rgba(0,200,255,0.35)' : 'rgba(255,255,255,0.1)'}`,
  color: primary ? '#67e8f9' : '#9CA3AF',
})

const LABELS: Record<string, string> = { prompt: 'Describe the video', negative: 'Avoid', seconds: 'Length (seconds)', aspect: 'Shape', seed: 'Variation number (0 = a new one each time)' }

const fmtDate = (ts: number) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const fmtSecs = (ms: number) => `${Math.round(ms / 1000)} s`

function startValues(recipe: Recipe): Record<string, string | number> {
  const values: Record<string, string | number> = {}
  for (const [name, spec] of Object.entries(recipe.params)) {
    if ('default' in spec && spec.default !== undefined) values[name] = spec.default
    else if (spec.kind !== 'image') values[name] = spec.kind === 'int' ? spec.min : ''
  }
  return values
}

export const VideoPage: React.FC = () => {
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [recipeId, setRecipeId] = useState('')
  const [values, setValues] = useState<Record<string, string | number>>({})
  const [status, setStatus] = useState<ComfyStatus | null>(null)
  const [videos, setVideos] = useState<Video[]>([])
  const [live, setLive] = useState<Record<string, Live>>({})
  const [error, setError] = useState('')
  const [comfyUrl, setComfyUrl] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const refreshTimer = useRef<number | null>(null)
  // Signed links change on every list call; keeping the one a player already has stops the
  // browser reloading every finished video each time the list refreshes. Links last an hour.
  const links = useRef<Map<string, { link: string; at: number }>>(new Map())
  const seenRunning = useRef<Set<string>>(new Set())

  const recipe = recipes.find((r) => r.id === recipeId)

  const loadVideos = async () => {
    try {
      const { videos: listed } = await gateway.request<{ videos: Video[] }>('video.list', { limit: 50 })
      const at = Date.now()
      setVideos(listed.map((v) => {
        const kept = links.current.get(v.id)
        if (kept && at - kept.at < 50 * 60 * 1000) return { ...v, link: kept.link }
        if (v.link) links.current.set(v.id, { link: v.link, at })
        return v
      }))
    } catch (err) {
      setError(`Could not load your videos: ${err instanceof Error ? err.message : 'no answer from Mission Control'}`)
    }
  }
  const loadStatus = async () => {
    try {
      const comfy = await gateway.request<ComfyStatus>('video.status')
      setStatus(comfy)
    } catch (err) {
      setStatus({ reachable: false, url: '', problem: `Could not ask Mission Control about ComfyUI: ${err instanceof Error ? err.message : 'no answer'}` })
    }
  }

  useEffect(() => {
    const loadSetup = async () => {
      try {
        const [{ recipes: available }, { settings }] = await Promise.all([
          gateway.request<{ recipes: Recipe[] }>('video.recipes'),
          gateway.request<{ settings: { comfyUrl: string } }>('settings.get'),
        ])
        setRecipes(available)
        setComfyUrl(settings.comfyUrl)
        if (available[0]) { setRecipeId(available[0].id); setValues(startValues(available[0])) }
      } catch (err) {
        setError(`Could not load the video recipes: ${err instanceof Error ? err.message : 'no answer from Mission Control'}`)
      }
      await Promise.all([loadStatus(), loadVideos()])
    }
    void loadSetup()
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    const off = gateway.onEvent((ev) => {
      if (ev.event !== 'video.event') return
      const e = ev.payload as { id: string; status: Status; step?: number; steps?: number; stage?: string; preview?: { mime: string; data: string } }
      if (e.status === 'running') {
        setLive((prev) => {
          const was = prev[e.id] ?? { startedAt: Date.now() }
          // Only JPEG and PNG previews ever reach here (checked by the gateway), shown as data: images.
          const preview = e.preview && /^image\/(jpeg|png)$/.test(e.preview.mime) ? `data:${e.preview.mime};base64,${e.preview.data}` : was.preview
          return { ...prev, [e.id]: { ...was, step: e.step ?? was.step, steps: e.steps ?? was.steps, stage: e.stage ?? was.stage, preview } }
        })
      } else {
        setLive((prev) => { const next = { ...prev }; delete next[e.id]; return next })
      }
      // Only status changes reload the list (progress and previews don't), debounced because a
      // finished job sends a few events at once.
      const firstRunning = e.status === 'running' && !seenRunning.current.has(e.id)
      if (e.status === 'running') seenRunning.current.add(e.id)
      if (e.status === 'running' && !firstRunning) return
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => void loadVideos(), 300)
    })
    return () => { off(); window.clearInterval(clock) }
  }, [])

  const pickRecipe = (id: string) => {
    const next = recipes.find((r) => r.id === id)
    setRecipeId(id)
    if (next) setValues(startValues(next))
  }

  const submit = async () => {
    if (!recipe) return
    setError('')
    try {
      // A seed of 0 asks the gateway to pick a random one (it is saved, so Use again repeats it).
      await gateway.request('video.submit', { recipeId: recipe.id, params: values })
      void loadVideos()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the video.')
    }
  }

  const stopVideo = async (id: string) => {
    try {
      await gateway.request('video.cancel', { id })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop the video.')
    }
  }

  const deleteVideo = async (id: string) => {
    if (!window.confirm('Delete this video? The file is removed for good.')) return
    try {
      await gateway.request('video.delete', { id })
      await loadVideos()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the video.')
    }
  }

  const saveComfyUrl = async () => {
    setError('')
    try {
      const res = await gateway.request<{ ok: boolean }>('settings.update', { comfyUrl })
      if (!res.ok) setError('That address was not saved: ComfyUI must be on this computer, like http://127.0.0.1:8188.')
      void loadStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the address.')
    }
  }

  const missing = status?.recipes?.find((r) => r.id === recipeId)?.missing ?? []
  const active = videos.filter((v) => v.status === 'queued' || v.status === 'running')
  const finished = videos.filter((v) => v.status !== 'queued' && v.status !== 'running')

  return (
    <div className="p-6 h-full flex flex-col gap-4 overflow-y-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">Video</h2>
        <button onClick={() => { void loadStatus(); void loadVideos() }} className="px-3 py-1 rounded text-xs" style={button()}>Refresh</button>
      </div>

      {/* ComfyUI connection */}
      <div className="rounded-xl p-4 flex flex-col gap-2" style={card}>
        <div className="flex items-center gap-2 text-xs">
          <span style={{ width: 8, height: 8, borderRadius: 4, background: status?.reachable ? '#34d399' : '#f87171', display: 'inline-block' }} />
          {status?.reachable
            ? <span className="text-gray-300">ComfyUI {status.version} at {status.url}{status.device ? ` · ${status.device.name}, ${status.device.vramFreeGb.toFixed(1)} of ${status.device.vramTotalGb.toFixed(1)} GB free` : ''}</span>
            : <span className="text-gray-300">{status?.problem ?? 'Checking ComfyUI...'}</span>}
        </div>
        {status?.warnings?.map((w) => <p key={w} className="text-xs" style={{ color: '#fcd34d' }}>{w}</p>)}
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500" htmlFor="comfy-url">ComfyUI address</label>
          <input id="comfy-url" value={comfyUrl} onChange={(e) => setComfyUrl(e.target.value)} className="px-2 py-1 rounded text-xs w-64" style={input} />
          <button onClick={() => void saveComfyUrl()} className="px-3 py-1 rounded text-xs" style={button()}>Save</button>
        </div>
      </div>

      {/* New video */}
      {recipe && (
        <div className="rounded-xl p-4 flex flex-col gap-3" style={card}>
          <div className="flex items-center gap-3">
            <select value={recipeId} onChange={(e) => pickRecipe(e.target.value)} className="px-2 py-1 rounded text-xs" style={input}>
              {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <span className="text-xs text-gray-500">{recipe.description}</span>
          </div>
          <p className="text-xs text-gray-600">{recipe.hardware}</p>
          {missing.length > 0 && <p className="text-xs" style={{ color: '#f87171' }}>ComfyUI is missing: {missing.join(', ')}</p>}
          {Object.entries(recipe.params).map(([name, spec]) => (
            <div key={name} className="flex flex-col gap-1">
              <label className="text-xs text-gray-500" htmlFor={`p-${name}`}>{LABELS[name] ?? name}</label>
              {spec.kind === 'text' && (
                <textarea id={`p-${name}`} rows={name === 'prompt' ? 4 : 2} maxLength={spec.maxLength} value={String(values[name] ?? '')}
                  onChange={(e) => setValues({ ...values, [name]: e.target.value })} className="px-2 py-1 rounded text-xs" style={input} />
              )}
              {spec.kind === 'int' && (
                <input id={`p-${name}`} type="number" min={spec.min} max={spec.max} step={1} value={Number(values[name] ?? spec.min)}
                  onChange={(e) => setValues({ ...values, [name]: Math.trunc(Number(e.target.value)) })} className="px-2 py-1 rounded text-xs w-40" style={input} />
              )}
              {spec.kind === 'choice' && (
                <select id={`p-${name}`} value={String(values[name] ?? '')} onChange={(e) => setValues({ ...values, [name]: e.target.value })} className="px-2 py-1 rounded text-xs w-40" style={input}>
                  {spec.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              )}
            </div>
          ))}
          {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}
          <div>
            <button onClick={() => void submit()} disabled={!status?.reachable} className="px-4 py-1.5 rounded text-xs" style={{ ...button(true), opacity: status?.reachable ? 1 : 0.5 }}>Make video</button>
          </div>
        </div>
      )}

      {/* Running and queued */}
      {active.map((v) => {
        const progress = live[v.id]
        const pct = progress?.steps ? Math.round(((progress.step ?? 0) / progress.steps) * 100) : 0
        return (
          <div key={v.id} className="rounded-xl p-4 flex gap-4" style={{ ...card, border: '1px solid rgba(0,200,255,0.25)', minHeight: 176 }}>
            <div style={{ width: 256, height: 144, background: 'rgba(255,255,255,0.03)', borderRadius: 8, overflow: 'hidden', flexShrink: 0 }}>
              {progress?.preview
                ? <img src={progress.preview} alt="Live preview" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                : <div className="text-xs text-gray-600 h-full flex items-center justify-center text-center p-3">
                    {v.status === 'queued' ? 'Waiting for the graphics card' : 'The preview appears once generating starts (loading the model comes first)'}
                  </div>}
            </div>
            <div className="flex-1 min-w-0 flex flex-col gap-2">
              <p className="text-xs text-gray-300 truncate">{String(v.params['prompt'] ?? '')}</p>
              <p className="text-xs text-gray-500">
                {v.status === 'queued' ? 'Waiting in the queue' : (progress?.stage ?? 'Starting')}
                {progress?.steps ? ` · step ${progress.step} of ${progress.steps}` : ''}
                {v.status === 'running' && v.startedAt ? ` · ${fmtSecs(now - v.startedAt)}` : ''}
              </p>
              <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
                <div style={{ width: `${pct}%`, height: 4, background: '#22d3ee', borderRadius: 2, transition: 'width 0.3s' }} />
              </div>
              <div>
                <button onClick={() => void stopVideo(v.id)} className="px-3 py-1 rounded text-xs" style={button()}>Stop</button>
              </div>
            </div>
          </div>
        )
      })}

      {/* Finished */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {finished.map((v) => (
          <div key={v.id} className="rounded-xl p-3 flex flex-col gap-2" style={card}>
            {v.status === 'done' && v.link
              ? <video src={v.link} controls preload="metadata" style={{ width: '100%', borderRadius: 8, background: '#000' }} />
              : <div className="text-xs p-3 rounded" style={{ background: 'rgba(255,255,255,0.03)', color: v.status === 'failed' ? '#f87171' : '#9CA3AF' }}>
                  {v.status === 'cancelled' ? 'Stopped' : (v.error ?? 'Failed')}
                </div>}
            <p className="text-xs text-gray-300" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {String(v.params['prompt'] ?? '')}
            </p>
            <div className="flex items-center justify-between text-xs text-gray-600">
              <span>
                {fmtDate(v.createdAt)}
                {v.startedAt && v.finishedAt ? ` · took ${fmtSecs(v.finishedAt - v.startedAt)}` : ''}
                {v.params['seed'] !== undefined ? ` · variation ${String(v.params['seed'])}` : ''}
              </span>
              <span className="flex gap-3">
                <button onClick={() => { pickRecipe(v.recipeId); setValues(v.params as Record<string, string | number>) }} style={{ background: 'none', border: 'none', color: '#67e8f9', cursor: 'pointer' }}>Use again</button>
                <button onClick={() => void deleteVideo(v.id)} style={{ background: 'none', border: 'none', color: '#6B7280', cursor: 'pointer' }}>Delete</button>
              </span>
            </div>
          </div>
        ))}
      </div>
      {videos.length === 0 && <p className="text-xs text-gray-600">No videos yet.</p>}
    </div>
  )
}
