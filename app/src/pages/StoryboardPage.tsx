import React, { useEffect, useRef, useState } from 'react'
import { gateway } from '../lib/gateway-client'
import { button, card, input, linkButton } from '../components/video-ui'
import { StoryboardPlan } from '../components/StoryboardPlan'
import { followsOn, type Film, type FilmPicture, type Stage } from '../components/storyboard-types'

interface FilmSummary { id: string; title: string; stage: Stage; seconds: number; look: string; thumbLink: string | null; updatedAt: number }
interface CastMember { id: string; name: string; wording: string; thumb: string | null }
interface Live { shotId?: string; step?: number; steps?: number; preview?: string }
interface FfmpegFound { path: string; version: string; old: boolean }
// The same words as the gateway's (film-director.ts): one install line per system.
const NO_FFMPEG = 'Making a film needs ffmpeg. Install it (Ubuntu: sudo apt install ffmpeg; Mac: brew install ffmpeg; ' +
  'Windows: winget install Gyan.FFmpeg, a third-party build), then restart Mission Control.'
const REPLACES_FILM = 'This makes the film again in place of the one you have. The one you have is removed from the Video page, ' +
  'unless you star it there first. Carry on?'

const STAGES: Record<Stage, string> = {
  story: 'Story', plan: 'Planned', places: 'Round one pictures', shots: 'Round two pictures', making: 'Being made', done: 'Done', stopped: 'Stopped',
}
const LENGTHS: Record<number, string> = { 30: '30 seconds', 60: '1 minute', 90: '1 minute 30', 120: '2 minutes' }
const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

/** One slot's pictures to choose from (a master, a pose, a turnaround or a face): big, and a tap chooses. */
const Slot: React.FC<{
  label: string; pictures: FilmPicture[]; chosen: string | null; links: Record<string, string>; disabled: boolean; note?: string
  onChoose: (pictureId: string) => void; onMore: () => Promise<boolean>; working: boolean
}> = ({ label, pictures, chosen, links, disabled, note, onChoose, onMore, working }) => {
  // Make more (two pictures) waits its turn behind the pictures being made, and its boxes show only once it starts: say
  // so meanwhile (live test: it looked as if the press did nothing). Once nothing is being made (finished, failed or
  // stopped) the note goes.
  const [expected, setExpected] = useState(0)
  const more = () => void onMore().then((queued) => { if (queued) setExpected((n) => (working ? Math.max(n, pictures.length) : pictures.length) + 2) })
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-300">{label}</span>
        {note && <span className="text-xs text-gray-500">{note}</span>}
        {working && pictures.length < expected && <span className="text-xs text-gray-400">More on the way: they show here when their turn comes.</span>}
        {pictures.length > 0 && <button onClick={more} disabled={disabled} className="text-xs ml-auto" style={linkButton(disabled ? '#4B5563' : '#67e8f9')}>Make more</button>}
      </div>
      <div className="flex flex-wrap gap-3">
        {pictures.length === 0 && <span className="text-xs text-gray-600">No pictures yet.</span>}
        {pictures.map((p) => {
          const isChosen = p.imageId !== null && p.imageId === chosen
          const box: React.CSSProperties = {
            width: 240, height: 135, borderRadius: 8, overflow: 'hidden', background: 'rgba(255,255,255,0.03)',
            border: `2px solid ${isChosen ? '#22d3ee' : 'transparent'}`, padding: 0, cursor: p.imageId && !disabled ? 'pointer' : 'default',
          }
          if (!p.imageId || !links[p.imageId]) {
            const waiting = p.status === 'queued' || p.status === 'running'
            // A pose of several characters adds them one edit at a time.
            const making = p.steps > 1 ? `Adding character ${p.step} of ${p.steps}...` : 'Making...'
            const text = waiting ? making : p.status === 'cancelled' ? 'Stopped before it was finished' : 'This one failed'
            return <div key={p.id} style={box} className="text-xs text-gray-500 flex items-center justify-center">{text}</div>
          }
          return (
            <button key={p.id} onClick={() => onChoose(p.id)} disabled={disabled || isChosen} style={box} aria-pressed={isChosen} title={isChosen ? 'Chosen' : 'Choose this one'}>
              <img src={links[p.imageId]} alt={`${label}, variation ${p.seed}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Step 1: the story, its length and look, sound, and the cast. A new film is made from here. */
const StoryForm: React.FC<{ film: Film | null; onSaved: (id: string) => void; onError: (m: string) => void }> = ({ film, onSaved, onError }) => {
  const [cast, setCast] = useState<CastMember[]>([])
  const [title, setTitle] = useState(film?.title ?? '')
  const [story, setStory] = useState(film?.story ?? '')
  const [seconds, setSeconds] = useState(film?.seconds ?? 60)
  const [look, setLook] = useState(film?.look ?? 'realistic')
  const [sound, setSound] = useState(film?.sound ?? true)
  const [castIds, setCastIds] = useState<string[]>(film?.cast.map((c) => c.castId) ?? [])
  const [castError, setCastError] = useState('')
  const early = !film || film.stage === 'story' || film.stage === 'plan'

  useEffect(() => {
    gateway.request<{ cast: CastMember[] }>('video.cast.list').then(({ cast: listed }) => setCast(listed), (err) => setCastError(errorText(err, 'Could not load the cast.')))
  }, [])

  const save = async () => {
    const fields = { title, story, seconds, look, sound, castIds }
    try {
      const { film: saved } = film
        ? await gateway.request<{ film: Film }>('video.film.update', { id: film.id, film: fields })
        : await gateway.request<{ film: Film }>('video.film.create', { film: fields })
      onSaved(saved.id)
    } catch (err) { onError(errorText(err, 'Could not save the film.')) }
  }

  // A character deleted from the cast after the film was made still shows, by the film's own copy.
  const choices = [...cast.map((c) => ({ id: c.id, name: c.name, thumb: c.thumb })),
    ...(film?.cast.filter((c) => !cast.some((m) => m.id === c.castId)).map((c) => ({ id: c.castId, name: c.name, thumb: null })) ?? [])]

  return (
    <div className="rounded-xl p-4 flex flex-col gap-2" style={card}>
      <h3 className="text-xs font-medium text-gray-300">1. Story</h3>
      <input aria-label="Title" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="px-2 py-1 rounded text-xs w-72" style={input} />
      <textarea aria-label="Story" rows={5} maxLength={2000} value={story} onChange={(e) => setStory(e.target.value)}
        placeholder="Tell the story in a few sentences: who, where, and what happens." className="px-2 py-1 rounded text-xs" style={input} />
      <div className="flex flex-wrap items-center gap-3">
        <select aria-label="Length" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className="px-2 py-1 rounded text-xs" style={input}>
          {Object.entries(LENGTHS).map(([s, label]) => <option key={s} value={s}>{label}</option>)}
        </select>
        <select aria-label="Look" value={look} disabled={!early} onChange={(e) => setLook(e.target.value)} className="px-2 py-1 rounded text-xs" style={input}>
          <option value="realistic">Realistic</option>
          <option value="cartoon">Cartoon</option>
        </select>
        <label className="text-xs text-gray-400 flex items-center gap-1">
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Sound
        </label>
      </div>
      <p className="text-xs text-gray-500">Cast {early ? '(add characters on the Video page)' : '(the look and the cast are fixed once pictures are made)'}</p>
      {castError && <p className="text-xs" style={{ color: '#f87171' }}>{castError}</p>}
      <div className="flex flex-wrap gap-3">
        {choices.length === 0 &&<span className="text-xs text-gray-600">The cast is empty. Add characters, with a picture each, on the Video page.</span>}
        {choices.map((c) => (
          <label key={c.id} className="text-xs text-gray-300 flex items-center gap-2">
            <input type="checkbox" disabled={!early} checked={castIds.includes(c.id)}
              onChange={(e) => setCastIds(e.target.checked ? [...castIds, c.id] : castIds.filter((id) => id !== c.id))} />
            {c.thumb && <img src={c.thumb} alt="" style={{ width: 32, height: 20, objectFit: 'cover', borderRadius: 4 }} />}
            {c.name}
          </label>
        ))}
      </div>
      <div><button onClick={() => void save()} disabled={title.trim() === '' || castIds.length === 0} className="px-3 py-1 rounded text-xs" style={button(true)}>{film ? 'Save' : 'Make the film'}</button></div>
    </div>
  )
}

/**
 * The Storyboard: a story becomes a film. The person writes the story and picks the cast, checks the plan, chooses
 * pictures in two rounds, and presses Make film; the gateway's director does the rest, one job at a time.
 */
export const StoryboardPage: React.FC = () => {
  const [films, setFilms] = useState<FilmSummary[]>([])
  const [filmId, setFilmId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [film, setFilm] = useState<Film | null>(null)
  const [links, setLinks] = useState<Record<string, string>>({})
  const [live, setLive] = useState<Live>({})
  const [ffmpeg, setFfmpeg] = useState<FfmpegFound | null | undefined>(undefined)
  const [comfyWarnings, setComfyWarnings] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const filmIdRef = useRef<string | null>(null)
  const reloadTimer = useRef<number | null>(null)

  const loadFilms = async () => {
    try {
      setFilms((await gateway.request<{ films: FilmSummary[] }>('video.film.list')).films)
    } catch (err) { setError(errorText(err, 'Could not load the films.')) }
  }
  const loadFilm = async (id = filmIdRef.current) => {
    if (!id) return
    try {
      const got = await gateway.request<{ film: Film; links: Record<string, string> }>('video.film.get', { id })
      if (filmIdRef.current !== id) return
      setFilm(got.film)
      setLinks(got.links)
    } catch (err) { setError(errorText(err, 'Could not load the film.')) }
  }
  const open = (id: string | null) => {
    filmIdRef.current = id
    setFilmId(id)
    setFilm(null)
    setLive({})
    setError('')
    setCreating(false)
    if (id) void loadFilm(id)
    else void loadFilms()
  }

  useEffect(() => {
    const loadFirst = async () => {
      await loadFilms()
      try {
        const status = await gateway.request<{ ffmpeg: FfmpegFound | null; warnings?: string[] }>('video.status')
        setFfmpeg(status.ffmpeg)
        // ComfyUI's own start-up advice (--disable-metadata among it), as on the Video page.
        setComfyWarnings(status.warnings ?? [])
      } catch { setFfmpeg(null) }
    }
    void loadFirst()
    // Debounced: a finished job sends a few events at once.
    const reloadSoon = () => {
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current)
      reloadTimer.current = window.setTimeout(() => { void loadFilm(); void loadFilms() }, 400)
    }
    const off = gateway.onEvent((ev) => {
      // A finished picture or clip arrives as a queue event; progress and stage changes as film events.
      if (ev.event === 'video.event') return reloadSoon()
      if (ev.event !== 'video.film') return
      const e = ev.payload as { filmId: string; stage: Stage; shotId?: string; step?: number; steps?: number; preview?: { mime: string; data: string } }
      if (e.filmId !== filmIdRef.current) return reloadSoon()
      if (e.step !== undefined || e.preview) {
        // Only JPEG and PNG previews are shown, as data: images.
        const preview = e.preview && /^image\/(jpeg|png)$/.test(e.preview.mime) ? `data:${e.preview.mime};base64,${e.preview.data}` : undefined
        setLive((was) => ({ shotId: e.shotId ?? was.shotId, step: e.step ?? was.step, steps: e.steps ?? was.steps, preview: preview ?? was.preview }))
        return
      }
      if (e.shotId) setLive({ shotId: e.shotId })
      reloadSoon()
    })
    return () => { off(); if (reloadTimer.current) window.clearTimeout(reloadTimer.current) }
  }, [])

  // True when the work was done; its refusal is shown otherwise.
  const act = async (work: () => Promise<unknown>, fallback: string): Promise<boolean> => {
    setError('')
    setBusy(true)
    try {
      await work()
      await loadFilm()
      return true
    } catch (err) {
      setError(errorText(err, fallback))
      return false
    } finally {
      setBusy(false)
    }
  }
  const makePictures = (request: Record<string, unknown>) =>
    act(() => gateway.request('video.film.pictures.make', { filmId: film!.id, request }), 'Could not make the pictures.')
  const choose = (pictureId: string) => {
    // A new master clears the pictures of every shot in that place: say so first.
    const picture = film!.pictures.find((p) => p.id === pictureId)
    const place = picture?.role === 'master' ? film!.places.find((p) => p.id === picture.ownerId) : undefined
    const cleared = place?.masterId && film!.shots.some((s) => s.placeId === place.id && (s.startId || s.endId))
    if (cleared && !window.confirm(`A new picture of ${place.name} clears the start and end pictures chosen for its shots, and they are made again. Carry on?`)) return
    void act(() => gateway.request('video.film.pictures.choose', { filmId: film!.id, pictureId }), 'Could not choose that picture.')
  }
  const stop = () => act(() => gateway.request('video.film.stop', { filmId: film!.id }), 'Could not stop the film.')
  // Making the film again replaces the joined film the person has: say so first.
  const remake = (work: () => Promise<unknown>) => {
    if (film!.videoId && !window.confirm(REPLACES_FILM)) return
    void act(work, 'Could not start the film.')
  }
  const deleteFilm = async () => {
    if (!film || !window.confirm(`Delete "${film.title}"? Its pictures and shots go for good. The finished film stays on the Video page.`)) return
    await act(() => gateway.request('video.film.delete', { id: film.id }), 'Could not delete the film.')
    open(null)
  }

  // ---- the film list ----
  if (!filmId) {
    return (
      <div className="p-6 h-full flex flex-col gap-4 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-300">Storyboard</h2>
          {!creating && <button onClick={() => setCreating(true)} className="px-3 py-1 rounded text-xs" style={button(true)}>New film</button>}
        </div>
        {creating && <StoryForm film={null} onSaved={(id) => open(id)} onError={setError} />}
        {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}
        {films.length === 0 && !creating && <p className="text-xs text-gray-500">No films yet. Press New film, write a short story and pick the cast.</p>}
        <div className="flex flex-wrap gap-4">
          {films.map((f) => (
            <button key={f.id} onClick={() => open(f.id)} className="rounded-xl p-3 flex flex-col gap-2 text-left" style={{ ...card, width: 260, cursor: 'pointer' }}>
              <div style={{ width: '100%', height: 132, borderRadius: 8, overflow: 'hidden', background: 'rgba(255,255,255,0.03)' }}>
                {f.thumbLink && <img src={f.thumbLink} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
              </div>
              <span className="text-xs text-gray-200">{f.title}</span>
              <span className="text-xs text-gray-500">{STAGES[f.stage]} · {f.seconds} seconds · {f.look}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (!film) return <div className="p-6 text-xs text-gray-500">{error || 'Loading the film...'}</div>

  // ---- one film ----
  const making = film.stage === 'making'
  const picturesBeingMade = film.pictures.some((p) => p.status === 'queued' || p.status === 'running')
  // Pictures made from older words or an older place picture are never offered; the one already chosen still shows.
  // Failed or stopped ones go once the slot has any other picture, made or on its way.
  const candidates = (ownerId: string, role: string, chosen: string | null) => {
    const shown = film.pictures.filter((p) => p.ownerId === ownerId && p.role === role && (!p.stale || (p.imageId !== null && p.imageId === chosen)))
    const ended = (p: FilmPicture) => p.status === 'failed' || p.status === 'cancelled'
    return shown.some((p) => !ended(p)) ? shown.filter((p) => !ended(p)) : shown
  }
  const roundOneDone = film.cast.every((c) => c.turnaroundId && c.faceId) && film.places.length > 0 && film.places.every((p) => p.masterId)
  const allPicturesChosen = film.shots.length > 0 && film.shots.every((s) => s.startId && (s.closeUp || s.endId))
  const canChoose = !making && ['places', 'shots', 'stopped', 'done'].includes(film.stage)
  const checkNote = 'Automatic check: off (no local model can see pictures yet)'

  return (
    <div className="p-6 h-full flex flex-col gap-4 overflow-y-auto">
      <div className="flex items-center gap-3">
        <button onClick={() => open(null)} className="text-xs" style={linkButton('#9CA3AF')}>All films</button>
        <h2 className="text-sm font-medium text-gray-300">{film.title}</h2>
        <span className="text-xs text-gray-500">{STAGES[film.stage]}</span>
        <button onClick={() => void deleteFilm()} disabled={making || busy} className="px-3 py-1 rounded text-xs ml-auto" style={button()}>Delete film</button>
      </div>
      {film.problem && <p className="text-xs" style={{ color: '#f87171' }}>{film.problem}</p>}
      {comfyWarnings.map((w) => <p key={w} className="text-xs" style={{ color: '#fcd34d' }}>{w}</p>)}
      {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}

      <StoryForm key={film.id} film={film} onSaved={() => void loadFilm()} onError={setError} />
      <StoryboardPlan film={film} onChanged={() => void loadFilm()} onError={setError} />

      {/* Round one: each character's sheet pictures and each place's master */}
      {film.shots.length > 0 && (
        <div className="rounded-xl p-4 flex flex-col gap-4" style={card}>
          <div className="flex items-center gap-3">
            <h3 className="text-xs font-medium text-gray-300">3. Pictures, round one: the characters and the places</h3>
            <span className="text-xs text-gray-500">{checkNote}</span>
            {picturesBeingMade && <button onClick={() => void stop()} className="px-3 py-1 rounded text-xs ml-auto" style={button()}>Stop</button>}
            <button onClick={() => void makePictures({ round: 'places' })} disabled={busy || making} className={`px-3 py-1 rounded text-xs ${picturesBeingMade ? '' : 'ml-auto'}`} style={button(true)}>
              {film.pictures.length === 0 ? 'Make the pictures' : 'Make the missing pictures'}
            </button>
          </div>
          {film.cast.map((c) => (
            <React.Fragment key={c.castId}>
              <Slot label={`${c.name}: front, side and back`} pictures={candidates(c.castId, 'turnaround', c.turnaroundId)} chosen={c.turnaroundId} links={links}
                disabled={!canChoose || busy} onChoose={(id) => void choose(id)} working={picturesBeingMade} onMore={() => makePictures({ ownerId: c.castId, role: 'turnaround' })} />
              <Slot label={`${c.name}: face`} pictures={candidates(c.castId, 'face', c.faceId)} chosen={c.faceId} links={links}
                disabled={!canChoose || busy} onChoose={(id) => void choose(id)} working={picturesBeingMade} onMore={() => makePictures({ ownerId: c.castId, role: 'face' })} />
            </React.Fragment>
          ))}
          {film.places.map((p, i) => (
            <Slot key={p.id} label={p.name} pictures={candidates(p.id, 'master', p.masterId)} chosen={p.masterId} links={links}
              note={i > 0 && !film.places[0]!.masterId ? `Made after you choose ${film.places[0]!.name}, so the light and style carry over` : 'Choose one with nobody in it: the characters are added later'}
              disabled={!canChoose || busy} onChoose={(id) => void choose(id)} working={picturesBeingMade} onMore={() => makePictures({ ownerId: p.id, role: 'master' })} />
          ))}
        </div>
      )}

      {/* Round two: the start and end picture of every shot, once round one is chosen */}
      {roundOneDone && (
        <div className="rounded-xl p-4 flex flex-col gap-4" style={card}>
          <div className="flex items-center gap-3">
            <h3 className="text-xs font-medium text-gray-300">4. Pictures, round two: how each shot starts and ends</h3>
            {picturesBeingMade && <button onClick={() => void stop()} className="px-3 py-1 rounded text-xs ml-auto" style={button()}>Stop</button>}
            <button onClick={() => void makePictures({ round: 'shots' })} disabled={busy || making} className={`px-3 py-1 rounded text-xs ${picturesBeingMade ? '' : 'ml-auto'}`} style={button(true)}>
              {film.pictures.some((p) => p.ownerKind === 'shot') ? 'Make the missing pictures' : 'Make the pictures'}
            </button>
          </div>
          {film.shots.map((s, i) => {
            return (
              <div key={s.id} className="flex flex-col gap-2">
                <p className="text-xs text-gray-400">Shot {i + 1}: {s.action}</p>
                {followsOn(film.shots[i - 1], s)
                  ? <p className="text-xs text-gray-500">Starts where shot {i} ends.</p>
                  : <Slot label={s.closeUp ? 'Close-up' : 'Start'} pictures={candidates(s.id, 'start', s.startId)} chosen={s.startId} links={links}
                      disabled={!canChoose || busy} onChoose={(id) => void choose(id)} working={picturesBeingMade} onMore={() => makePictures({ ownerId: s.id, role: 'start' })} />}
                {!s.closeUp && (
                  <Slot label="End" pictures={candidates(s.id, 'end', s.endId)} chosen={s.endId} links={links}
                    disabled={!canChoose || busy} onChoose={(id) => void choose(id)} working={picturesBeingMade} onMore={() => makePictures({ ownerId: s.id, role: 'end' })} />
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Make film, its progress, the shots and the finished film */}
      {allPicturesChosen && (
        <div className="rounded-xl p-4 flex flex-col gap-3" style={card}>
          <div className="flex items-center gap-3">
            <h3 className="text-xs font-medium text-gray-300">5. Make film</h3>
            {ffmpeg === null && <span className="text-xs" style={{ color: '#fcd34d' }}>{NO_FFMPEG}</span>}
            {ffmpeg?.old && <span className="text-xs" style={{ color: '#fcd34d' }}>ffmpeg {ffmpeg.version} is an old release. Films still join; update it when you can, for its later fixes.</span>}
            {making || picturesBeingMade
              ? <button onClick={() => void stop()} className="px-3 py-1 rounded text-xs ml-auto" style={button()}>Stop</button>
              : <button onClick={() => remake(() => gateway.request('video.film.make', { filmId: film.id }))} disabled={busy || !ffmpeg}
                  className="px-4 py-1.5 rounded text-xs ml-auto" style={{ ...button(true), opacity: busy || !ffmpeg ? 0.5 : 1 }}>
                  {film.shots.some((s) => s.clipId) ? 'Make film (carry on)' : 'Make film'}
                </button>}
          </div>
          {film.shots.map((s, i) => {
            const current = s.clipId !== null && s.clipRev === s.revision
            const now = making && live.shotId === s.id
            const pct = now && live.steps ? Math.round(((live.step ?? 0) / live.steps) * 100) : 0
            return (
              <div key={s.id} className="flex gap-4 items-start">
                <div style={{ width: 256, height: 144, background: 'rgba(255,255,255,0.03)', borderRadius: 8, overflow: 'hidden', flexShrink: 0 }}>
                  {now && live.preview
                    ? <img src={live.preview} alt="Live preview" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    : s.clipId && links[s.clipId]
                      ? <video src={links[s.clipId]} controls preload="metadata" style={{ width: '100%', height: '100%', background: '#000' }} />
                      : <div className="text-xs text-gray-600 h-full flex items-center justify-center">{now ? 'Starting...' : 'Not made yet'}</div>}
                </div>
                <div className="flex-1 min-w-0 flex flex-col gap-1">
                  <p className="text-xs text-gray-300">Shot {i + 1} · {s.seconds} seconds</p>
                  <p className="text-xs text-gray-500 truncate" title={s.action}>{s.action}</p>
                  {now && (
                    <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
                      <div style={{ width: `${pct}%`, height: 4, background: '#22d3ee', borderRadius: 2, transition: 'width 0.3s' }} />
                    </div>
                  )}
                  {s.clipId && !current && <p className="text-xs" style={{ color: '#fcd34d' }}>Made from older words or pictures: Make film makes it again.</p>}
                  {!making && current && (film.stage === 'done' || film.stage === 'stopped') && (
                    <span className="flex gap-3 text-xs">
                      <button onClick={() => remake(() => gateway.request('video.film.redo', { filmId: film.id, shotId: s.id, newSeed: false }))} disabled={busy} style={linkButton('#67e8f9')}>Make again</button>
                      <button onClick={() => remake(() => gateway.request('video.film.redo', { filmId: film.id, shotId: s.id, newSeed: true }))} disabled={busy} style={linkButton('#67e8f9')}>Make again, a new variation</button>
                    </span>
                  )}
                </div>
              </div>
            )
          })}
          {film.videoId && links[film.videoId] && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-gray-300">The film (also on the Video page, where it can be starred or downloaded)</p>
              <video src={links[film.videoId]} controls preload="metadata" style={{ width: 640, maxWidth: '100%', borderRadius: 8, background: '#000' }} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
