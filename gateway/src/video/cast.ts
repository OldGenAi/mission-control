// The cast on the Video page: each character of a story has a name, fixed wording that goes into
// prompts word for word, and optionally a picture (an uploaded picture's id) to start clips from.
// Describing a character the same way every time is what keeps it from drifting between clips.
//
// Security-sensitive. Do not modify without Claude review.

import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { inspectImage } from './image-input.js'
import { VideoRequestError } from './jobs.js'
import { hasControlCharacter } from './params.js'

export const MAX_CAST = 50
export const MAX_THUMB_BYTES = 64 * 1024
const MAX_NAME = 60
const MAX_WORDING = 500
const ID = /^[0-9a-f]{32}$/
const THUMB_PREFIX = 'data:image/jpeg;base64,'
const FIELDS = new Set(['id', 'name', 'wording', 'imageId', 'thumb'])

export interface CastMember {
  id: string
  name: string
  wording: string
  imageId: string | null
  /** A small JPEG of the picture as a data: URL, made by the page, so the list can show it. */
  thumb: string | null
  createdAt: number
  updatedAt: number
}

const COLUMNS = 'id, name, wording, image_id AS imageId, thumb, created_at AS createdAt, updated_at AS updatedAt'

function checkedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new VideoRequestError(`The ${field} must be text.`)
  if ([...value].length > max) throw new VideoRequestError(`The ${field} can be at most ${max} characters.`)
  if (hasControlCharacter(value)) throw new VideoRequestError(`The ${field} contains a control character.`)
  return value
}

// Only a real JPEG goes in, so the page can put it straight into an <img> as a data: URL.
function checkedThumb(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const base64 = typeof value === 'string' && value.startsWith(THUMB_PREFIX) ? value.slice(THUMB_PREFIX.length) : ''
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new VideoRequestError('The thumbnail must be a JPEG picture.')
  // The length check bounds memory before decoding; the exact size is checked after.
  const tooLarge = new VideoRequestError('The thumbnail is too large.')
  if (base64.length > Math.ceil(MAX_THUMB_BYTES / 3) * 4) throw tooLarge
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > MAX_THUMB_BYTES) throw tooLarge
  const info = inspectImage(bytes)
  if (typeof info === 'string' || info.type !== 'jpeg') throw new VideoRequestError('The thumbnail must be a JPEG picture.')
  return value as string
}

export class VideoCast {
  constructor(
    private readonly db: Database.Database,
    private readonly hasImage: (id: string) => boolean,
  ) {}

  list(): CastMember[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM video_cast WHERE deleted_at IS NULL ORDER BY created_at, rowid`).all() as CastMember[]
  }

  /** Adds a character, or changes one when `id` names it. Refuses anything it can't store as given. */
  save(input: unknown): CastMember {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new VideoRequestError('The character must be an object.')
    const fields = input as Record<string, unknown>
    const unknown = Object.keys(fields).find((key) => !FIELDS.has(key))
    if (unknown) throw new VideoRequestError(`unknown field: ${unknown}`)

    const name = checkedText(fields['name'], 'name', MAX_NAME).trim()
    if (name === '') throw new VideoRequestError('The character needs a name.')
    const wording = checkedText(fields['wording'], 'wording', MAX_WORDING).trim()
    const imageId = fields['imageId'] ?? null
    if (imageId !== null && (typeof imageId !== 'string' || !ID.test(imageId) || !this.hasImage(imageId))) {
      throw new VideoRequestError('That picture is not uploaded (or has been removed). Choose it again.')
    }
    const thumb = checkedThumb(fields['thumb'])

    const id = fields['id']
    const existing = id === undefined ? null : this.find(id)
    if (id !== undefined && !existing) throw new VideoRequestError('That character is no longer in the cast.')
    const clash = this.list().find((m) => m.name.toLowerCase() === name.toLowerCase() && m.id !== existing?.id)
    if (clash) throw new VideoRequestError(`There is already a character called ${clash.name}.`)

    const now = Date.now()
    if (existing) {
      this.db.prepare(`UPDATE video_cast SET name = ?, wording = ?, image_id = ?, thumb = ?, updated_at = ? WHERE id = ?`)
        .run(name, wording, imageId, thumb, now, existing.id)
      return { ...existing, name, wording, imageId, thumb, updatedAt: now }
    }
    if (this.list().length >= MAX_CAST) throw new VideoRequestError(`The cast can have at most ${MAX_CAST} characters. Delete one you no longer use.`)
    const member: CastMember = { id: randomBytes(16).toString('hex'), name, wording, imageId, thumb, createdAt: now, updatedAt: now }
    this.db.prepare(`INSERT INTO video_cast (id, name, wording, image_id, thumb, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(member.id, name, wording, imageId, thumb, now, now)
    return member
  }

  // Soft delete, like videos: the row stays, but the character is gone from the cast and its name is free again.
  delete(id: unknown): boolean {
    if (!this.find(id)) return false
    return this.db.prepare(`UPDATE video_cast SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`).run(Date.now(), id).changes > 0
  }

  private find(id: unknown): CastMember | null {
    if (typeof id !== 'string' || !ID.test(id)) return null
    return (this.db.prepare(`SELECT ${COLUMNS} FROM video_cast WHERE id = ? AND deleted_at IS NULL`).get(id) as CastMember | undefined) ?? null
  }
}
