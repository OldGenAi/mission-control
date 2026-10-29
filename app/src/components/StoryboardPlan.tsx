// The Storyboard's plan: a film's places and shots, each editable, moved up and down, added or deleted. The
// gateway checks every field (video/films.ts); the page shows its plain-words refusals.
import React, { useState } from 'react'
import { gateway } from '../lib/gateway-client'
import { button, card, input, linkButton } from './video-ui'
import { JOINS, type Film, type FilmCast, type FilmPlace, type FilmShot } from './storyboard-types'

// The most characters in one shot (the gateway's MAX_SHOT_CAST): a man and his two dogs were proven together.
const MAX_SHOT_CAST = 3

interface PlaceDraft { id?: string; name: string; description: string; keep: string; prop: string }
interface CharacterDraft { castId: string; startPose: string; endPose: string }
interface ShotDraft { id?: string; placeId: string; characters: CharacterDraft[]; action: string; seconds: number; joins: string; closeUp: boolean }

const placeDraft = (p: FilmPlace): PlaceDraft => ({ id: p.id, name: p.name, description: p.description, keep: p.keep, prop: p.prop ?? '' })
const shotDraft = (s: FilmShot): ShotDraft => ({
  id: s.id, placeId: s.placeId, action: s.action, seconds: s.seconds, joins: s.joins, closeUp: s.closeUp,
  characters: s.characters.map((c) => ({ castId: c.castId, startPose: c.startPose, endPose: c.endPose ?? '' })),
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
    // The keep words go into every pose picture of the place: say so before chosen pictures are cleared.
    const clears = place && draft.keep.trim() !== place.keep && film.shots.some((s) => s.placeId === place.id && (s.startId || s.endId))
    if (clears && !window.confirm(`Changing what stays the same in ${place.name} means the start and end pictures of its shots are made again. Carry on?`)) return
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
    placeId: film.places.at(-1)?.id ?? '', characters: film.cast[0] ? [{ castId: film.cast[0].castId, startPose: '', endPose: '' }] : [],
    action: '', seconds: 6, joins: 'follows', closeUp: false,
  }
  const [draft, setDraft] = useState<ShotDraft>(shot ? shotDraft(shot) : empty)
  const saved = JSON.stringify(shot ? shotDraft(shot) : empty)
  const changed = JSON.stringify(draft) !== saved
  const set = (patch: Partial<ShotDraft>) => setDraft({ ...draft, ...patch })

  const save = async () => {
    try {
      const characters = draft.characters.map(({ endPose, ...c }) => (draft.closeUp ? c : { ...c, endPose }))
      await gateway.request('video.film.shot.save', { filmId: film.id, shot: { ...draft, characters } })
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
  const most = draft.closeUp ? 1 : MAX_SHOT_CAST
  const nameOf = (castId: string) => film.cast.find((c) => c.castId === castId)?.name ?? 'This character'
  // Ticking adds a character at the end: the pictures add them in this order.
  const toggle = (castId: string, on: boolean) => set({
    characters: on ? [...draft.characters, { castId, startPose: '', endPose: '' }] : draft.characters.filter((c) => c.castId !== castId),
  })
  const setCharacter = (i: number, patch: Partial<CharacterDraft>) => set({ characters: draft.characters.map((c, j) => (j === i ? { ...c, ...patch } : c)) })

  return (
    <div className="flex flex-col gap-1 rounded p-3" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">Shot {index + 1}</span>
        <select aria-label="Place" value={draft.placeId} disabled={!editable} onChange={(e) => set({ placeId: e.target.value })} className="px-2 py-1 rounded text-xs" style={input}>
          {film.places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select aria-label="Length" value={draft.seconds} disabled={!editable} onChange={(e) => set({ seconds: Number(e.target.value) })} className="px-2 py-1 rounded text-xs" style={input}>
          {seconds.map((s) => <option key={s} value={s}>{s} seconds</option>)}
        </select>
        <select aria-label="How it joins the shot before" value={draft.joins} disabled={!editable} onChange={(e) => set({ joins: e.target.value })} className="px-2 py-1 rounded text-xs" style={input}>
          {Object.entries(JOINS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <label className="text-xs text-gray-400 flex items-center gap-1">
          <input type="checkbox" checked={draft.closeUp} disabled={!editable}
            onChange={(e) => set({
              closeUp: e.target.checked, seconds: e.target.checked ? Math.min(draft.seconds, 5) : draft.seconds,
              characters: e.target.checked ? draft.characters.slice(0, 1) : draft.characters,
            })} />
          Close-up
        </label>
        {shot && <span className="ml-auto"><RowTools first={index === 0} last={index === film.shots.length - 1} disabled={!editable} onMove={(by) => void move(by)} onDelete={() => void remove()} /></span>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-gray-500">{draft.closeUp ? 'Who (a close-up shows one):' : `Who is in it (up to ${MAX_SHOT_CAST}):`}</span>
        {film.cast.map((c) => {
          const at = draft.characters.findIndex((d) => d.castId === c.castId)
          const full = at < 0 && draft.characters.length >= most
          return (
            <label key={c.castId} className="text-xs text-gray-300 flex items-center gap-1">
              <input type="checkbox" checked={at >= 0} disabled={!editable || full} onChange={(e) => toggle(c.castId, e.target.checked)} />
              {c.name}
            </label>
          )
        })}
      </div>
      <textarea aria-label="What happens" rows={2} maxLength={600} value={draft.action} disabled={!editable} onChange={(e) => set({ action: e.target.value })}
        placeholder="What happens, calmly: walks to the door and sniffs it" className="px-2 py-1 rounded text-xs" style={input} />
      {draft.characters.length > 1 && <span className="text-xs text-gray-500">Say where each one is, so they stand apart. The pictures add them in this order.</span>}
      {draft.characters.map((c, i) => (
        <div key={c.castId} className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-400 w-24 truncate">{i + 1}. {nameOf(c.castId)}</span>
          <input aria-label={`How ${nameOf(c.castId)} starts`} value={c.startPose} maxLength={300} disabled={!editable} onChange={(e) => setCharacter(i, { startPose: e.target.value })}
            placeholder="How it starts: standing on the path on the left" className="px-2 py-1 rounded text-xs flex-1 min-w-48" style={input} />
          {!draft.closeUp && (
            <input aria-label={`How ${nameOf(c.castId)} ends`} value={c.endPose} maxLength={300} disabled={!editable} onChange={(e) => setCharacter(i, { endPose: e.target.value })}
              placeholder="How it ends: lying on the grass on the left" className="px-2 py-1 rounded text-xs flex-1 min-w-48" style={input} />
          )}
        </div>
      ))}
      {editable && (changed || !shot) && (
        <div className="flex gap-2">
          <button onClick={() => void save()} className="px-3 py-1 rounded text-xs" style={button(true)}>{shot ? 'Save' : 'Add shot'}</button>
          {(onCancel || changed) && <button onClick={() => (shot ? setDraft(JSON.parse(saved) as ShotDraft) : onCancel?.())} className="px-3 py-1 rounded text-xs" style={button()}>Cancel</button>}
        </div>
      )}
    </div>
  )
}

/** One word for what a character is, for the pictures' "exactly two dogs and one man". Saved when the box is left. */
const KindBox: React.FC<{ film: Film; member: FilmCast; editable: boolean; onSaved: () => void; onError: (m: string) => void }> = ({ film, member, editable, onSaved, onError }) => {
  const [kind, setKind] = useState(member.kind ?? '')
  const save = async () => {
    if (kind.trim().toLowerCase() === (member.kind ?? '')) return
    try {
      await gateway.request('video.film.cast.kind', { filmId: film.id, castId: member.castId, kind })
      onSaved()
    } catch (err) { onError(errorText(err, 'Could not save what the character is.')) }
  }
  return (
    <label className="text-xs text-gray-300 flex items-center gap-2">
      {member.name} is a
      <input aria-label={`What ${member.name} is`} value={kind} maxLength={20} disabled={!editable} onChange={(e) => setKind(e.target.value)} onBlur={() => void save()}
        placeholder="one word" className="px-2 py-1 rounded text-xs w-28" style={{ ...input, borderColor: member.kind ? undefined : '#fcd34d' }} />
    </label>
  )
}

/** The plan step: ask the local helper, then edit the places and shots by hand. */
export const StoryboardPlan: React.FC<{ film: Film; onChanged: () => void; onError: (m: string) => void }> = ({ film, onChanged, onError }) => {
  const [adding, setAdding] = useState<'place' | 'shot' | null>(null)
  const [planning, setPlanning] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  // Places and shots can change at any time except while the film is being made; a change makes the pictures it
  // affects out of date.
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
        <span className="text-xs text-gray-500">Places, then the shots in each. Up to {MAX_SHOT_CAST} characters on screen per shot; a shot never moves between places.</span>
        {canPlan && (
          <button onClick={() => void plan()} disabled={planning || film.cast.length === 0} className="px-3 py-1 rounded text-xs ml-auto" style={{ ...button(true), opacity: planning ? 0.6 : 1 }}>
            {planning ? 'The helper is planning...' : film.shots.length > 0 ? 'Plan again with the helper' : 'Plan with the helper'}
          </button>
        )}
      </div>
      {warnings.map((w) => <p key={w} className="text-xs" style={{ color: '#fcd34d' }}>{w}</p>)}

      <p className="text-xs text-gray-400">Who is who <span className="text-gray-500">(one word each; the helper fills any you leave empty)</span></p>
      <div className="flex flex-wrap gap-4">
        {film.cast.map((member) => (
          <KindBox key={`${member.castId}:${member.kind ?? ''}`} film={film} member={member} editable={editable} onSaved={onChanged} onError={onError} />
        ))}
      </div>

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
