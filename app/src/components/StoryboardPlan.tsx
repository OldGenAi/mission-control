// The Storyboard's plan: a film's places and shots, each editable, moved up and down, added or deleted. The
// gateway checks every field (video/films.ts); the page shows its plain-words refusals.
import React, { useState } from 'react'
import { gateway } from '../lib/gateway-client'
import { button, card, input, linkButton } from './video-ui'
import { JOINS, type Film, type FilmPlace, type FilmShot } from './storyboard-types'

interface PlaceDraft { id?: string; name: string; description: string; keep: string; prop: string }
interface ShotDraft {
  id?: string; placeId: string; castId: string; action: string; startPose: string; endPose: string
  seconds: number; joins: string; closeUp: boolean
}

const placeDraft = (p: FilmPlace): PlaceDraft => ({ id: p.id, name: p.name, description: p.description, keep: p.keep, prop: p.prop ?? '' })
const shotDraft = (s: FilmShot): ShotDraft => ({
  id: s.id, placeId: s.placeId, castId: s.castId, action: s.action, startPose: s.startPose, endPose: s.endPose ?? '',
  seconds: s.seconds, joins: s.joins, closeUp: s.closeUp,
})

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

/** Up, Down and Delete for one row of the plan. */
const RowTools: React.FC<{ first: boolean; last: boolean; disabled: boolean; onMove: (by: number) => void; onDelete: () => void }> = ({ first, last, disabled, onMove, onDelete }) => (
  <span className="flex gap-3 text-xs">
    <button onClick={() => onMove(-1)} disabled={disabled || first} style={linkButton(disabled || first ? '#4B5563' : '#9CA3AF')} aria-label="Move up">Up</button>
    <button onClick={() => onMove(1)} disabled={disabled || last} style={linkButton(disabled || last ? '#4B5563' : '#9CA3AF')} aria-label="Move down">Down</button>
    <button onClick={onDelete} disabled={disabled} style={linkButton(disabled ? '#4B5563' : '#6B7280')}>Delete</button>
  </span>
)

const PlaceEditor: React.FC<{
  film: Film; place: FilmPlace | null; index: number; editable: boolean; onSaved: () => void; onCancel?: () => void; onError: (m: string) => void
}> = ({ film, place, index, editable, onSaved, onCancel, onError }) => {
  const empty: PlaceDraft = { name: '', description: '', keep: '', prop: '' }
  // The parent keys this editor by the saved data: new data from the gateway starts a fresh draft, a reload with
  // the same data leaves typing alone.
  const [draft, setDraft] = useState<PlaceDraft>(place ? placeDraft(place) : empty)
  const saved = JSON.stringify(place ? placeDraft(place) : empty)
  const changed = JSON.stringify(draft) !== saved

  const save = async () => {
    try {
      await gateway.request('video.film.place.save', { filmId: film.id, place: { ...draft, prop: draft.prop.trim() || undefined } })
      onSaved()
    } catch (err) { onError(errorText(err, 'Could not save the place.')) }
  }
  const move = async (by: number) => {
    try { await gateway.request('video.film.place.move', { filmId: film.id, id: place!.id, position: index + by }); onSaved() } catch (err) { onError(errorText(err, 'Could not move the place.')) }
  }
  const remove = async () => {
    if (!window.confirm(`Delete the place "${place!.name}"?`)) return
    try { await gateway.request('video.film.place.delete', { filmId: film.id, id: place!.id }); onSaved() } catch (err) { onError(errorText(err, 'Could not delete the place.')) }
  }

  return (
    <div className="flex flex-col gap-1 rounded p-3" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500">Place {index + 1}</span>
        <input aria-label="Place name" value={draft.name} maxLength={60} disabled={!editable} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="The garden" className="px-2 py-1 rounded text-xs w-56" style={input} />
        {place && <span className="ml-auto"><RowTools first={index === 0} last={index === film.places.length - 1} disabled={!editable} onMove={(by) => void move(by)} onDelete={() => void remove()} /></span>}
      </div>
      <textarea aria-label="What it looks like" rows={2} maxLength={500} value={draft.description} disabled={!editable} onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        placeholder="What you can see: the setting, the light, the time of day, the furniture, the doors and windows" className="px-2 py-1 rounded text-xs" style={input} />
      <input aria-label="What stays the same" value={draft.keep} maxLength={500} disabled={!editable} onChange={(e) => setDraft({ ...draft, keep: e.target.value })}
        placeholder="What must stay the same, like: the red door stays wide open" className="px-2 py-1 rounded text-xs" style={input} />
      <input aria-label="Prop" value={draft.prop} maxLength={300} disabled={!editable} onChange={(e) => setDraft({ ...draft, prop: e.target.value })}
        placeholder="One prop, if there is one (optional)" className="px-2 py-1 rounded text-xs" style={input} />
      {editable && (changed || !place) && (
        <div className="flex gap-2">
          <button onClick={() => void save()} className="px-3 py-1 rounded text-xs" style={button(true)}>{place ? 'Save' : 'Add place'}</button>
          {(onCancel || changed) && <button onClick={() => (place ? setDraft(JSON.parse(saved) as PlaceDraft) : onCancel?.())} className="px-3 py-1 rounded text-xs" style={button()}>Cancel</button>}
        </div>
      )}
    </div>
  )
}

const ShotEditor: React.FC<{
  film: Film; shot: FilmShot | null; index: number; editable: boolean; onSaved: () => void; onCancel?: () => void; onError: (m: string) => void
}> = ({ film, shot, index, editable, onSaved, onCancel, onError }) => {
  const empty: ShotDraft = {
    placeId: film.places.at(-1)?.id ?? '', castId: film.cast[0]?.castId ?? '', action: '', startPose: '', endPose: '', seconds: 6, joins: 'follows', closeUp: false,
  }
  const [draft, setDraft] = useState<ShotDraft>(shot ? shotDraft(shot) : empty)
  const saved = JSON.stringify(shot ? shotDraft(shot) : empty)
  const changed = JSON.stringify(draft) !== saved
  const set = (patch: Partial<ShotDraft>) => setDraft({ ...draft, ...patch })

  const save = async () => {
    try {
      const { endPose, ...rest } = draft
      await gateway.request('video.film.shot.save', { filmId: film.id, shot: { ...rest, ...(draft.closeUp ? {} : { endPose }) } })
      onSaved()
    } catch (err) { onError(errorText(err, 'Could not save the shot.')) }
  }
  const move = async (by: number) => {
    try { await gateway.request('video.film.shot.move', { filmId: film.id, id: shot!.id, position: index + by }); onSaved() } catch (err) { onError(errorText(err, 'Could not move the shot.')) }
  }
  const remove = async () => {
    if (!window.confirm(`Delete shot ${index + 1}?`)) return
    try { await gateway.request('video.film.shot.delete', { filmId: film.id, id: shot!.id }); onSaved() } catch (err) { onError(errorText(err, 'Could not delete the shot.')) }
  }
  const seconds = draft.closeUp ? [4, 5] : [4, 5, 6, 7, 8]

  return (
    <div className="flex flex-col gap-1 rounded p-3" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">Shot {index + 1}</span>
        <select aria-label="Place" value={draft.placeId} disabled={!editable} onChange={(e) => set({ placeId: e.target.value })} className="px-2 py-1 rounded text-xs" style={input}>
          {film.places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select aria-label="Character" value={draft.castId} disabled={!editable} onChange={(e) => set({ castId: e.target.value })} className="px-2 py-1 rounded text-xs" style={input}>
          {film.cast.map((c) => <option key={c.castId} value={c.castId}>{c.name}</option>)}
        </select>
        <select aria-label="Length" value={draft.seconds} disabled={!editable} onChange={(e) => set({ seconds: Number(e.target.value) })} className="px-2 py-1 rounded text-xs" style={input}>
          {seconds.map((s) => <option key={s} value={s}>{s} seconds</option>)}
        </select>
        <select aria-label="How it joins the shot before" value={draft.joins} disabled={!editable} onChange={(e) => set({ joins: e.target.value })} className="px-2 py-1 rounded text-xs" style={input}>
          {Object.entries(JOINS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <label className="text-xs text-gray-400 flex items-center gap-1">
          <input type="checkbox" checked={draft.closeUp} disabled={!editable}
            onChange={(e) => set({ closeUp: e.target.checked, seconds: e.target.checked ? Math.min(draft.seconds, 5) : draft.seconds })} />
          Close-up
        </label>
        {shot && <span className="ml-auto"><RowTools first={index === 0} last={index === film.shots.length - 1} disabled={!editable} onMove={(by) => void move(by)} onDelete={() => void remove()} /></span>}
      </div>
      <textarea aria-label="What happens" rows={2} maxLength={600} value={draft.action} disabled={!editable} onChange={(e) => set({ action: e.target.value })}
        placeholder="What happens, calmly: walks to the door and sniffs it" className="px-2 py-1 rounded text-xs" style={input} />
      <input aria-label="How it starts" value={draft.startPose} maxLength={300} disabled={!editable} onChange={(e) => set({ startPose: e.target.value })}
        placeholder="How it starts: standing by the wall" className="px-2 py-1 rounded text-xs" style={input} />
      {!draft.closeUp && (
        <input aria-label="How it ends" value={draft.endPose} maxLength={300} disabled={!editable} onChange={(e) => set({ endPose: e.target.value })}
          placeholder="How it ends: standing at the door" className="px-2 py-1 rounded text-xs" style={input} />
      )}
      {editable && (changed || !shot) && (
        <div className="flex gap-2">
          <button onClick={() => void save()} className="px-3 py-1 rounded text-xs" style={button(true)}>{shot ? 'Save' : 'Add shot'}</button>
          {(onCancel || changed) && <button onClick={() => (shot ? setDraft(JSON.parse(saved) as ShotDraft) : onCancel?.())} className="px-3 py-1 rounded text-xs" style={button()}>Cancel</button>}
        </div>
      )}
    </div>
  )
}

/** The plan step: ask the local helper, then edit the places and shots by hand. */
export const StoryboardPlan: React.FC<{ film: Film; onChanged: () => void; onError: (m: string) => void }> = ({ film, onChanged, onError }) => {
  const [adding, setAdding] = useState<'place' | 'shot' | null>(null)
  const [planning, setPlanning] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  // Places and shots can change until pictures are made from them (then a new film is the way to a new plan).
  const editable = film.stage !== 'making'
  const canPlan = film.stage === 'story' || film.stage === 'plan'
  const total = film.shots.reduce((sum, s) => sum + s.seconds, 0)

  const plan = async (allowAddress?: string) => {
    const replace = film.places.length > 0 || film.shots.length > 0
    if (replace && !allowAddress && !window.confirm('Replace this film\'s places and shots with a new plan from the helper?')) return
    setPlanning(true)
    setWarnings([])
    try {
      const result = await gateway.request<{ confirm?: string; warnings?: string[] }>('video.film.plan', { filmId: film.id, replace, ...(allowAddress ? { allowAddress } : {}) })
      if (result.confirm) {
        setPlanning(false)
        if (window.confirm(`Your model server is at ${result.confirm}, another computer on your network. Send the story there?`)) await plan(result.confirm)
        return
      }
      setWarnings(result.warnings ?? [])
      onChanged()
    } catch (err) {
      onError(errorText(err, 'The helper could not plan this story.'))
    } finally {
      setPlanning(false)
    }
  }

  const done = () => { setAdding(null); onChanged() }

  return (
    <div className="rounded-xl p-4 flex flex-col gap-3" style={card}>
      <div className="flex items-center gap-3">
        <h3 className="text-xs font-medium text-gray-300">2. Plan</h3>
        <span className="text-xs text-gray-500">Places, then the shots in each. One character on screen per shot; a shot never moves between places.</span>
        {canPlan && (
          <button onClick={() => void plan()} disabled={planning || film.cast.length === 0} className="px-3 py-1 rounded text-xs ml-auto" style={{ ...button(true), opacity: planning ? 0.6 : 1 }}>
            {planning ? 'The helper is planning...' : film.shots.length > 0 ? 'Plan again with the helper' : 'Plan with the helper'}
          </button>
        )}
      </div>
      {warnings.map((w) => <p key={w} className="text-xs" style={{ color: '#fcd34d' }}>{w}</p>)}

      <p className="text-xs text-gray-400">Places</p>
      {film.places.map((place, i) => (
        <PlaceEditor key={`${place.id}:${JSON.stringify(placeDraft(place))}`} film={film} place={place} index={i} editable={editable} onSaved={onChanged} onError={onError} />
      ))}
      {adding === 'place'
        ? <PlaceEditor film={film} place={null} index={film.places.length} editable onSaved={done} onCancel={() => setAdding(null)} onError={onError} />
        : editable && film.places.length < 8 && <div><button onClick={() => setAdding('place')} className="px-3 py-1 rounded text-xs" style={button()}>Add place</button></div>}

      <p className="text-xs text-gray-400">
        Shots <span className="text-gray-500">({total} of {film.seconds} seconds)</span>
      </p>
      {film.shots.map((shot, i) => (
        <ShotEditor key={`${shot.id}:${JSON.stringify(shotDraft(shot))}`} film={film} shot={shot} index={i} editable={editable} onSaved={onChanged} onError={onError} />
      ))}
      {adding === 'shot'
        ? <ShotEditor film={film} shot={null} index={film.shots.length} editable onSaved={done} onCancel={() => setAdding(null)} onError={onError} />
        : editable && film.places.length > 0 && film.shots.length < 30 && <div><button onClick={() => setAdding('shot')} className="px-3 py-1 rounded text-xs" style={button()}>Add shot</button></div>}
    </div>
  )
}
