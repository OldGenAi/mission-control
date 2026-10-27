import React, { useEffect, useRef, useState } from 'react'
import { gateway } from '../lib/gateway-client'
import { lastFrame } from '../lib/last-frame'
import { VideoCast, type CastMember } from '../components/VideoCast'
import { button, card, input, linkButton, pictureSize, uploadPicture, uploadPictureFile, type UploadedPicture } from '../components/video-ui'

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
  kept: boolean
  link: string | null
}

interface Live { step?: number; steps?: number; stage?: string; preview?: string; startedAt: number }

// Finished videos are shown a few at a time, so a busy day doesn't bury the form.
const VIDEOS_PER_PAGE = 6

const LABELS: Record<string, string> = { image: 'Picture (it becomes the first frame)', prompt: 'Describe the video', negative: 'Avoid', seconds: 'Length (seconds)', aspect: 'Shape', seed: 'Variation number (0 = a new one each time)' }

/** The recipe shape that best fits a picture, so it isn't cropped more than it has to be. */
function shapeFor(width: number, height: number): string {
  const ratio = width / height
  return ratio > 1.2 ? '16:9' : ratio < 0.83 ? '9:16' : '1:1'
}

// The chosen picture is remembered until Remove is pressed, so a restart or crash doesn't lose it.
// The gateway keeps the picture itself; the browser keeps only its id and a thumbnail. The thumbnail
// is '' when there isn't one (it couldn't be made, or the picture came from Use again), and the size
// is 0 when unknown, which leaves the shape alone.
interface SavedPicture { id: string; thumb: string; width: number; height: number }
const SAVED_PICTURE_KEY = 'mc:video-picture'

function loadSavedPicture(): SavedPicture | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_PICTURE_KEY) ?? 'null') as SavedPicture | null
    if (!saved || !/^[0-9a-f]{32}$/.test(saved.id)) return null
    if (saved.thumb !== '' && !saved.thumb.startsWith('data:image/jpeg;base64,')) return null
    return saved
  } catch {
    return null
  }
}
function savePicture(picture: SavedPicture | null) {
  try {
    if (picture) localStorage.setItem(SAVED_PICTURE_KEY, JSON.stringify(picture))
    else localStorage.removeItem(SAVED_PICTURE_KEY)
  } catch { /* storage off: the picture is kept for this visit only */ }
}
const asSaved = (picture: UploadedPicture): SavedPicture => ({ id: picture.id, thumb: picture.thumb, width: picture.width, height: picture.height })

// "Keep this number" holds one variation number across clips, recipe changes and restarts, so a story keeps
// one look while its prompts change. Unticked, the number goes back to 0 (a new one each time).
const SEED_LOCK_KEY = 'mc:video-seed-lock'
const MAX_PICKED_SEED = 2 ** 40   // the same range the gateway picks from for 0
const MAX_SEED = 2 ** 48   // the most the recipes take

function loadSeedLock(): number | null {
  try {
    const seed = Number(localStorage.getItem(SEED_LOCK_KEY))
    return Number.isInteger(seed) && seed > 0 && seed <= MAX_SEED ? seed : null
  } catch {
    return null
  }
}
function saveSeedLock(seed: number | null) {
  try {
    if (seed) localStorage.setItem(SEED_LOCK_KEY, String(seed))
    else localStorage.removeItem(SEED_LOCK_KEY)
  } catch { /* storage off: the number is kept for this visit only */ }
}

const fmtDate = (ts: number) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const fmtSecs = (ms: number) => `${Math.round(ms / 1000)} s`

function startValues(recipe: Recipe, picture: SavedPicture | null, lockedSeed: number | null): Record<string, string | number> {
  const values: Record<string, string | number> = {}
  for (const [name, spec] of Object.entries(recipe.params)) {
    if ('default' in spec && spec.default !== undefined) values[name] = spec.default
    else if (spec.kind !== 'image') values[name] = spec.kind === 'int' ? spec.min : ''
    if (spec.kind === 'image' && picture) values[name] = picture.id
  }
  if (lockedSeed && 'seed' in recipe.params) values['seed'] = lockedSeed
  if (picture && picture.width > 0 && picture.height > 0 && 'aspect' in recipe.params && Object.values(recipe.params).some((s) => s.kind === 'image')) {
    values['aspect'] = shapeFor(picture.width, picture.height)
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
  const [pictures, setPictures] = useState<Record<string, string>>(() => {   // uploaded picture id -> data: URL shown as a thumbnail
    const saved = loadSavedPicture()
    return saved?.thumb ? { [saved.id]: saved.thumb } : {}
  })
  const [uploading, setUploading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)   // the Refresh button is working
  const [checkedAt, setCheckedAt] = useState<number | null>(null)   // when ComfyUI was last asked
  const [disk, setDisk] = useState<{ used: number; limit: number } | null>(null)   // the media folder, for the storage bar
  const [shown, setShown] = useState(VIDEOS_PER_PAGE)   // how many finished videos are on the page
  const [seedLock, setSeedLock] = useState<number | null>(loadSeedLock)   // the kept variation number, or null
  const seedLockRef = useRef(seedLock)
  const [continuing, setContinuing] = useState<string | null>(null)   // the video whose last frame is being read
  const formRef = useRef<HTMLDivElement>(null)
  const refreshTimer = useRef<number | null>(null)
  // Signed links change on every list call; keeping the one a player already has stops the
  // browser reloading every finished video each time the list refreshes. Links last an hour.
  const links = useRef<Map<string, { link: string; at: number }>>(new Map())
  const seenRunning = useRef<Set<string>>(new Set())

  const recipe = recipes.find((r) => r.id === recipeId)

  const loadVideos = async () => {
    try {
      const { videos: listed, diskBytes, diskLimitBytes } = await gateway.request<{ videos: Video[]; diskBytes: number; diskLimitBytes: number }>('video.list', { limit: 200 })
      const at = Date.now()
      setVideos(listed.map((v) => {
        const known = links.current.get(v.id)
        if (known && at - known.at < 50 * 60 * 1000) return { ...v, link: known.link }
        if (v.link) links.current.set(v.id, { link: v.link, at })
        return v
      }))
      setDisk({ used: diskBytes, limit: diskLimitBytes })
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
    setCheckedAt(Date.now())
  }
  // The Refresh button shows that it is working (a check can be quick enough to look like nothing happened), then when it last looked.
  const refresh = async () => {
    setRefreshing(true)
    await Promise.all([loadStatus(), loadVideos(), new Promise((resolve) => window.setTimeout(resolve, 600))])
    setRefreshing(false)
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
        if (available[0]) { setRecipeId(available[0].id); setValues(startValues(available[0], loadSavedPicture(), loadSeedLock())) }
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

  // While ComfyUI can't be reached, look again every few seconds: starting it then needs no Refresh press.
  const comfyReachable = Boolean(status?.reachable)
  useEffect(() => {
    if (comfyReachable) return
    const again = window.setInterval(() => void loadStatus(), 8000)
    return () => window.clearInterval(again)
  }, [comfyReachable])

  const pickRecipe = (id: string) => {
    const next = recipes.find((r) => r.id === id)
    setRecipeId(id)
    if (next) setValues(startValues(next, loadSavedPicture(), seedLockRef.current))
  }

  // The lock is also kept in a ref: Continue reads it after reading a video, which can take a while.
  const keepSeedLock = (seed: number | null) => {
    saveSeedLock(seed)
    seedLockRef.current = seed
    setSeedLock(seed)
  }
  // Ticking picks a number now (if the field says 0) and keeps it; unticking goes back to a new one each time.
  const lockSeed = (locked: boolean) => {
    const seed = locked ? (Number(values['seed']) || Math.floor(Math.random() * MAX_PICKED_SEED) + 1) : null
    keepSeedLock(seed)
    setValues((prev) => ({ ...prev, seed: seed ?? 0 }))
  }
  // Clearing the number (or typing 0) while it is kept would quietly send 0, a new one each time: that unticks the box instead.
  const changeSeed = (typed: number) => {
    if (seedLockRef.current !== null && typed <= 0) {
      lockSeed(false)
      return
    }
    const seed = Math.min(Math.max(typed, 0), MAX_SEED)
    setValues((prev) => ({ ...prev, seed }))
    if (seedLockRef.current !== null) keepSeedLock(seed)
  }

  // Moves the form to a recipe that starts from a picture, with this picture, keeping what is already written
  // (the variation number follows the lock, and a picture of known size picks the shape).
  const startFromPicture = (picture: SavedPicture, keep: Record<string, unknown>) => {
    const target = recipes.find((r) => Object.values(r.params).some((spec) => spec.kind === 'image'))
    if (!target) {
      setError('None of the recipes can start from a picture.')
      return
    }
    savePicture(picture)
    const thumb = picture.thumb
    if (thumb) setPictures((prev) => ({ ...prev, [picture.id]: thumb }))
    const next = startValues(target, picture, seedLockRef.current)
    for (const [name, value] of Object.entries(keep)) {
      const spec = target.params[name]
      if (!spec || spec.kind === 'image' || name === 'seed' || (name === 'aspect' && picture.width > 0)) continue
      if (typeof value === 'string' || typeof value === 'number') next[name] = value
    }
    setRecipeId(target.id)
    setValues(next)
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // The next clip starts where this one ends: its last frame becomes the picture, and its description stays to be changed.
  // A fresh link is asked for: the list's links last an hour, and the page may have been open longer.
  const continueFrom = async (v: Video) => {
    setError('')
    setContinuing(v.id)
    try {
      const { link } = await gateway.request<{ link: string }>('video.link', { id: v.id })
      startFromPicture(asSaved(await uploadPicture(await lastFrame(link))), v.params)
    } catch (err) {
      setError(`Could not continue from that clip: ${err instanceof Error ? err.message : 'no answer from Mission Control'}`)
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } finally {
      setContinuing(null)
    }
  }

  const addToPrompt = (member: CastMember) => {
    const words = `${member.name}: ${member.wording.replace(/[.\s]+$/, '')}.`
    const prompt = String(values['prompt'] ?? '')
    const spec = recipe?.params['prompt']
    const longest = spec?.kind === 'text' ? spec.maxLength : Infinity
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    if (prompt.includes(words)) return
    const next = prompt.trim() === '' ? words : `${prompt.trimEnd()} ${words}`
    if ([...next].length > longest) {
      setError(`Adding ${member.name} would make the description longer than ${longest} characters. Shorten it first.`)
      return
    }
    setError('')
    setValues((prev) => ({ ...prev, prompt: next }))
  }

  // The thumbnail has the picture's shape, so it picks the video's shape as a chosen picture would.
  const startFromCast = async (member: CastMember) => {
    if (!member.imageId) return
    const size = member.thumb ? await pictureSize(member.thumb) : { width: 0, height: 0 }
    startFromPicture({ id: member.imageId, thumb: member.thumb ?? '', ...size }, values)
  }

  const choosePicture = async (name: string, file: File | undefined) => {
    if (!file || !recipe) return
    setError('')
    setUploading(true)
    try {
      const uploaded = await uploadPictureFile(file)
      setPictures((prev) => ({ ...prev, [uploaded.id]: uploaded.dataUrl }))
      savePicture(asSaved(uploaded))
      setValues((prev) => {
        const next: Record<string, string | number> = { ...prev, [name]: uploaded.id }
        if ('aspect' in recipe.params) next['aspect'] = shapeFor(uploaded.width, uploaded.height)
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload that picture.')
    } finally {
      setUploading(false)
    }
  }

  // Takes the picture off the form. The stored copy stays with the gateway, as before.
  const removePicture = (name: string) => {
    savePicture(null)
    setValues((prev) => { const next = { ...prev }; delete next[name]; return next })
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

  const starVideo = async (id: string, kept: boolean) => {
    try {
      await gateway.request('video.keep', { id, kept })
      await loadVideos()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not star the video.')
    }
  }

  // Names the videos on the list, so one that finishes while the box is open is never cleared unseen.
  const clearUnstarred = async () => {
    const ids = finished.filter((v) => !v.kept).map((v) => v.id)
    if (ids.length === 0) return
    if (!window.confirm(`Delete ${ids.length} ${ids.length === 1 ? 'video that isn\'t' : 'videos that aren\'t'} starred? Starred videos stay. The files are removed for good.`)) return
    try {
      await gateway.request('video.clearUnkept', { ids })
      await loadVideos()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear the videos.')
    }
  }

  // Use again fills the form from an earlier video; its picture becomes the remembered one, as if chosen.
  const makeAgain = (v: Video) => {
    const next = recipes.find((r) => r.id === v.recipeId)
    const image = next && Object.entries(next.params).find(([name, spec]) => spec.kind === 'image' && typeof v.params[name] === 'string')
    if (image) savePicture({ id: v.params[image[0]] as string, thumb: '', width: 0, height: 0 })
    pickRecipe(v.recipeId)
    setValues(v.params as Record<string, string | number>)
    // A kept number moves to this clip's, so Use again repeats it exactly and the clips after it keep its look.
    if (typeof v.params['seed'] === 'number') changeSeed(v.params['seed'])
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
        <div className="flex items-center gap-3">
          {checkedAt && !refreshing && <span className="text-xs text-gray-500">Checked {new Date(checkedAt).toLocaleTimeString()}</span>}
          <button onClick={() => void refresh()} disabled={refreshing} className="px-3 py-1 rounded text-xs" style={{ ...button(), opacity: refreshing ? 0.6 : 1, cursor: refreshing ? 'wait' : 'pointer' }}>
            {refreshing ? 'Checking...' : 'Refresh'}
          </button>
        </div>
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

      <VideoCast onAddToPrompt={addToPrompt} onStartFrom={(member) => void startFromCast(member)} />

      {/* New video */}
      {recipe && (
        <div ref={formRef} className="rounded-xl p-4 flex flex-col gap-3" style={{ ...card, scrollMarginTop: 16 }}>
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
              {spec.kind === 'int' && name !== 'seed' && (
                <input id={`p-${name}`} type="number" min={spec.min} max={spec.max} step={1} value={Number(values[name] ?? spec.min)}
                  onChange={(e) => setValues({ ...values, [name]: Math.trunc(Number(e.target.value)) })} className="px-2 py-1 rounded text-xs w-40" style={input} />
              )}
              {spec.kind === 'int' && name === 'seed' && (
                <div className="flex items-center gap-3">
                  <input id={`p-${name}`} type="number" min={spec.min} max={spec.max} step={1} value={Number(values[name] ?? spec.min)}
                    onChange={(e) => changeSeed(Math.trunc(Number(e.target.value)))} className="px-2 py-1 rounded text-xs w-40" style={input} />
                  <label className="flex items-center gap-2 text-xs text-gray-400" title="Every clip uses this number until you untick it, even after a restart">
                    <input type="checkbox" checked={seedLock !== null} onChange={(e) => lockSeed(e.target.checked)} />
                    Keep this number for the next clips
                  </label>
                </div>
              )}
              {spec.kind === 'image' && (
                <div className="flex items-center gap-3">
                  <input id={`p-${name}`} type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading}
                    onChange={(e) => { void choosePicture(name, e.target.files?.[0]); e.target.value = '' }} className="sr-only" tabIndex={-1} />
                  <button onClick={() => document.getElementById(`p-${name}`)?.click()} disabled={uploading}
                    className="px-3 py-1 rounded text-xs" style={{ ...button(), opacity: uploading ? 0.6 : 1 }}>
                    {typeof values[name] === 'string' ? 'Change picture' : 'Choose picture'}
                  </button>
                  {uploading && <span className="text-xs text-gray-500">Checking the picture...</span>}
                  {typeof values[name] === 'string'
                    ? <>
                        {pictures[values[name] as string]
                          ? <img src={pictures[values[name] as string]} alt="The chosen picture" style={{ maxHeight: 72, maxWidth: 128, borderRadius: 6 }} />
                          : <span className="text-xs text-gray-500">Using the picture from before.</span>}
                        <button onClick={() => removePicture(name)} className="px-3 py-1 rounded text-xs" style={button()}>Remove</button>
                      </>
                    : !uploading && <span className="text-xs text-gray-500">No picture chosen</span>}
                </div>
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

      {/* Storage, and clearing out what isn't starred */}
      {disk && disk.limit > 0 && (disk.used > 0 || finished.length > 0) && (
        <div className="flex items-center gap-3">
          <div style={{ width: 160, height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
            <div style={{ width: `${Math.min(100, (disk.used / disk.limit) * 100)}%`, height: 4, borderRadius: 2, background: disk.used / disk.limit > 0.8 ? '#fbbf24' : '#22d3ee' }} />
          </div>
          <span className="text-xs text-gray-500">
            Videos and pictures use {(disk.used / 1024 ** 3).toFixed(1)} GB of {Math.round(disk.limit / 1024 ** 3)} GB
          </span>
          {finished.some((v) => !v.kept) && (
            <button onClick={() => void clearUnstarred()} className="px-3 py-1 rounded text-xs ml-auto" style={button()}>Clear unstarred</button>
          )}
        </div>
      )}

      {/* Finished */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {finished.slice(0, shown).map((v) => (
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
                <button onClick={() => void starVideo(v.id, !v.kept)} title={v.kept ? 'Starred: Clear unstarred leaves it alone' : 'Star it to keep it when you clear the rest'}
                  style={{ background: 'none', border: 'none', color: v.kept ? '#fbbf24' : '#6B7280', cursor: 'pointer' }}>{v.kept ? '★ Starred' : '☆ Star'}</button>
                {v.status === 'done' && v.link && (
                  <button onClick={() => void continueFrom(v)} disabled={continuing !== null} title="Start the next clip from the last frame of this one"
                    style={{ ...linkButton('#67e8f9'), opacity: continuing !== null && continuing !== v.id ? 0.5 : 1 }}>
                    {continuing === v.id ? 'Reading the last frame...' : 'Continue'}
                  </button>
                )}
                <button onClick={() => makeAgain(v)} disabled={continuing !== null} style={{ ...linkButton('#67e8f9'), opacity: continuing !== null ? 0.5 : 1 }}>Use again</button>
                <button onClick={() => void deleteVideo(v.id)} style={linkButton('#6B7280')}>Delete</button>
              </span>
            </div>
          </div>
        ))}
      </div>
      {finished.length > shown && (
        <div>
          <button onClick={() => setShown(shown + VIDEOS_PER_PAGE)} className="px-3 py-1 rounded text-xs" style={button()}>
            Show more ({finished.length - shown} older)
          </button>
        </div>
      )}
      {videos.length === 0 && <p className="text-xs text-gray-600">No videos yet.</p>}
    </div>
  )
}
