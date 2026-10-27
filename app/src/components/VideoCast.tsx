import React, { useEffect, useState } from 'react'
import { gateway } from '../lib/gateway-client'
import { button, card, input, linkButton, uploadPictureFile } from './video-ui'

export interface CastMember { id: string; name: string; wording: string; imageId: string | null; thumb: string | null }

interface Draft { id?: string; name: string; wording: string; imageId: string | null; thumb: string | null }

const EMPTY: Draft = { name: '', wording: '', imageId: null, thumb: null }

/**
 * The cast: each character of a story with fixed wording and a picture. "Add to prompt" puts the wording into
 * the video's description; "Start from picture" makes the character's picture the first frame.
 */
export const VideoCast: React.FC<{
  onAddToPrompt: (member: CastMember) => void
  onStartFrom: (member: CastMember) => void
}> = ({ onAddToPrompt, onStartFrom }) => {
  const [cast, setCast] = useState<CastMember[]>([])
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const load = async (): Promise<CastMember[]> => {
    try {
      const { cast: listed } = await gateway.request<{ cast: CastMember[] }>('video.cast.list')
      setCast(listed)
      return listed
    } catch (err) {
      setError(`Could not load the cast: ${err instanceof Error ? err.message : 'no answer from Mission Control'}`)
      return []
    }
  }
  // Open from the start once there is a cast, so it is there to use; an empty one stays folded away.
  useEffect(() => {
    const loadFirst = async () => { if ((await load()).length > 0) setOpen(true) }
    void loadFirst()
  }, [])

  const choosePicture = async (file: File | undefined) => {
    if (!file || !draft) return
    setError('')
    setUploading(true)
    try {
      const picture = await uploadPictureFile(file)
      setDraft({ ...draft, imageId: picture.id, thumb: picture.thumb || null })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload that picture.')
    } finally {
      setUploading(false)
    }
  }

  const save = async () => {
    if (!draft) return
    setError('')
    try {
      await gateway.request('video.cast.save', { member: draft })
      setDraft(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the character.')
    }
  }

  const remove = async (member: CastMember) => {
    if (!window.confirm(`Take ${member.name} out of the cast? Videos already made are not affected.`)) return
    try {
      await gateway.request('video.cast.delete', { id: member.id })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the character.')
    }
  }

  return (
    <div className="rounded-xl p-4 flex flex-col gap-3" style={card}>
      <div className="flex items-center gap-3">
        <button onClick={() => setOpen(!open)} className="text-xs text-gray-300" style={linkButton('#D1D5DB')} aria-expanded={open}>
          {open ? '▾' : '▸'} Cast{cast.length > 0 ? ` (${cast.length})` : ''}
        </button>
        <span className="text-xs text-gray-500">Describe each character once, the same way every clip, so they don't change between scenes.</span>
        {open && !draft && (
          <button onClick={() => setDraft(EMPTY)} className="px-3 py-1 rounded text-xs ml-auto" style={button()}>Add character</button>
        )}
      </div>

      {open && cast.map((member) => (
        <div key={member.id} className="flex items-center gap-3">
          <div style={{ width: 64, height: 40, flexShrink: 0, borderRadius: 6, overflow: 'hidden', background: 'rgba(255,255,255,0.03)' }}>
            {member.thumb && <img src={member.thumb} alt={member.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-200">{member.name}</p>
            <p className="text-xs text-gray-500 truncate" title={member.wording}>{member.wording || 'No wording yet'}</p>
          </div>
          <span className="flex gap-3 text-xs">
            <button onClick={() => onAddToPrompt(member)} disabled={!member.wording} style={linkButton(member.wording ? '#67e8f9' : '#4B5563')}>Add to prompt</button>
            {member.imageId && <button onClick={() => onStartFrom(member)} style={linkButton('#67e8f9')}>Start from picture</button>}
            <button onClick={() => setDraft({ id: member.id, name: member.name, wording: member.wording, imageId: member.imageId, thumb: member.thumb })}
              style={linkButton('#9CA3AF')}>Edit</button>
            <button onClick={() => void remove(member)} style={linkButton('#6B7280')}>Delete</button>
          </span>
        </div>
      ))}

      {open && draft && (
        <div className="flex flex-col gap-2 rounded p-3" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
          <label className="text-xs text-gray-500" htmlFor="cast-name">Name</label>
          <input id="cast-name" value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="px-2 py-1 rounded text-xs w-64" style={input} />
          <label className="text-xs text-gray-500" htmlFor="cast-wording">How to describe them, word for word (colour, markings, size, clothes)</label>
          <textarea id="cast-wording" rows={2} maxLength={500} value={draft.wording} onChange={(e) => setDraft({ ...draft, wording: e.target.value })}
            placeholder="black and white border collie, white blaze down the face, black left ear, white chest" className="px-2 py-1 rounded text-xs" style={input} />
          <div className="flex items-center gap-3">
            <input id="cast-picture" type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading}
              onChange={(e) => { void choosePicture(e.target.files?.[0]); e.target.value = '' }} className="sr-only" tabIndex={-1} />
            <button onClick={() => document.getElementById('cast-picture')?.click()} disabled={uploading} className="px-3 py-1 rounded text-xs" style={{ ...button(), opacity: uploading ? 0.6 : 1 }}>
              {draft.imageId ? 'Change picture' : 'Choose picture'}
            </button>
            {uploading && <span className="text-xs text-gray-500">Checking the picture...</span>}
            {draft.thumb && <img src={draft.thumb} alt="" style={{ maxHeight: 48, maxWidth: 96, borderRadius: 6 }} />}
            {draft.imageId && !uploading && <button onClick={() => setDraft({ ...draft, imageId: null, thumb: null })} className="px-3 py-1 rounded text-xs" style={button()}>Remove</button>}
          </div>
          <div className="flex gap-2">
            <button onClick={() => void save()} disabled={uploading || draft.name.trim() === ''} className="px-3 py-1 rounded text-xs" style={button(true)}>Save</button>
            <button onClick={() => { setDraft(null); setError('') }} className="px-3 py-1 rounded text-xs" style={button()}>Cancel</button>
          </div>
        </div>
      )}

      {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}
    </div>
  )
}
