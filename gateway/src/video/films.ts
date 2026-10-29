// The Storyboard's films: a story, the film's own copy of its cast, its places and shots, and the candidate pictures
// to choose from (storyboard spec 4, 8 and 15). Every field is checked here as the cast's are, every id must belong
// to its film, and nothing changes while the film is being made.
//
// Security-sensitive. Do not modify without Claude review.
//
// - A picture passed between owners is copied to a new id (the film's copy of a cast picture), and a stored picture
//   is removed only when no live row anywhere still names it (the cast, any live film, a Video page job's params).
// - Make film starts with one compare-and-set on films.stage, so two presses can't start two runs, and only one film
//   is made at a time.
// - Each shot has a revision that goes up whenever its words or pictures change; a clip made for an older revision
//   is thrown away by the director.

import { randomBytes, randomInt } from 'node:crypto'
import type Database from 'better-sqlite3'
import { VideoRequestError } from './jobs.js'
import { hasControlCharacter } from './params.js'
import type { StoredImage } from './image-input.js'

export const MAX_FILMS = 50
export const MAX_PLACES = 8
export const MAX_SHOTS = 30
/** The most pictures to choose from for one master, pose, turnaround or face. */
export const MAX_CANDIDATES = 12
const MAX_FILM_CAST = 8
const MAX_TITLE = 60
const MAX_STORY = 2000
const MAX_PLACE_TEXT = 500
const MAX_PROP = 300
const MAX_ACTION = 600
const MAX_POSE = 300
const MAX_SEED = 2 ** 40
const FILM_SECONDS = [30, 60, 90, 120]
const LOOKS = ['realistic', 'cartoon']
const JOINS = ['follows', 'fade_short', 'fade_long']
const ID = /^[0-9a-f]{32}$/
// As for cast names: a line break or an invisible character would break a one-line field.
const NOT_ONE_PLAIN_LINE = /[\n\t]|\p{Cf}/u
export const STOP_FIRST = 'Stop the film first.'

export type FilmStage = 'story' | 'plan' | 'places' | 'shots' | 'making' | 'done' | 'stopped'
export type OwnerKind = 'place' | 'shot' | 'cast'

// Before any picture is made the look and the cast can still change; after, pictures can be chosen.
const EARLY_STAGES: ReadonlySet<string> = new Set(['story', 'plan'])
const PICTURE_STAGES: ReadonlySet<string> = new Set(['places', 'shots', 'stopped', 'done'])
const MAKE_FROM: ReadonlySet<string> = new Set(['shots', 'stopped', 'done'])
export const ROLE_OWNER: Readonly<Record<string, OwnerKind>> ={ master: 'place', empty: 'place', start: 'shot', end: 'shot', turnaround: 'cast', face: 'cast' }

const FILM_FIELDS = new Set(['title', 'story', 'seconds', 'look', 'sound', 'castIds'])
const PLACE_FIELDS = new Set(['id', 'name', 'description', 'keep', 'prop'])
const SHOT_FIELDS = new Set(['id', 'placeId', 'castId', 'action', 'startPose', 'endPose', 'seconds', 'joins', 'closeUp', 'seed'])

/** What the film store needs from the video queue's media folder (VideoJobs). */
export interface FilmMedia {
  findImage(id: unknown): StoredImage | null
  copyImage(id: string): string | null
  removeImage(id: string): void
  pictureOf(jobId: string): string | null
  cancelFilmJob(jobId: string, filmId: string): boolean
  deleteFilmRows(filmId: string): void
  filmFilePath(id: string, filmId: string): string | null
}

export interface FilmCastMember { castId: string; name: string; wording: string; pictureId: string | null; turnaroundId: string | null; faceId: string | null }

export interface FilmPlace {
  id: string; position: number; name: string; description: string; keep: string; prop: string | null
  masterId: string | null; emptyId: string | null; sheetId: string | null
}

export interface FilmShot {
  id: string; position: number; placeId: string; castId: string; action: string; startPose: string; endPose: string | null
  seconds: number; joins: string; closeUp: boolean; seed: number; startId: string | null; endId: string | null
  clipId: string | null; clipSeed: number | null; revision: number; clipRev: number | null
}

export interface FilmPicture {
  id: string; ownerKind: OwnerKind; ownerId: string; role: string; jobId: string; status: string | null; imageId: string | null
  seed: number; checkState: string; checkNotes: string | null; createdAt: number
}

export interface FilmSummary { id: string; title: string; stage: FilmStage; seconds: number; look: string; thumbId: string | null; updatedAt: number }

export interface Film {
  id: string; title: string; story: string; seconds: number; look: string; sound: boolean; stage: FilmStage
  problem: string | null; videoId: string | null; createdAt: number; updatedAt: number
  cast: FilmCastMember[]; places: FilmPlace[]; shots: FilmShot[]; pictures: FilmPicture[]
}

interface FilmRow { id: string; title: string; story: string; seconds: number; look: string; sound: number; stage: FilmStage; problem: string | null; videoId: string | null; createdAt: number; updatedAt: number }

const FILM_COLUMNS = 'id, title, story, seconds, look, sound, stage, problem, video_id AS videoId, created_at AS createdAt, updated_at AS updatedAt'
const CAST_COLUMNS = 'cast_id AS castId, name, wording, picture_id AS pictureId, turnaround_id AS turnaroundId, face_id AS faceId'
const PLACE_COLUMNS = 'id, position, name, description, keep, prop, master_id AS masterId, empty_id AS emptyId, sheet_id AS sheetId'
const SHOT_COLUMNS = `id, position, place_id AS placeId, cast_id AS castId, action, start_pose AS startPose, end_pose AS endPose, seconds, joins,
  close_up AS closeUp, seed, start_id AS startId, end_id AS endId, clip_id AS clipId, clip_seed AS clipSeed, revision, clip_rev AS clipRev`

// Every column of a film's tables that names a stored picture.
const PICTURE_REFERENCES = [
  ['film_cast', 'picture_id'], ['film_cast', 'turnaround_id'], ['film_cast', 'face_id'],
  ['film_places', 'master_id'], ['film_places', 'empty_id'], ['film_places', 'sheet_id'],
  ['film_shots', 'start_id'], ['film_shots', 'end_id'], ['film_pictures', 'image_id'],
] as const

function fieldsOf(input: unknown, what: string, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new VideoRequestError(`The ${what} must be an object.`)
  const fields = input as Record<string, unknown>
  const stray = Object.keys(fields).find((key) => !allowed.has(key))
  if (stray) throw new VideoRequestError(`unknown field: ${stray}`)
  return fields
}

function text(value: unknown, field: string, max: number, opts: { oneLine?: boolean; empty?: string } = {}): string {
  if (typeof value !== 'string') throw new VideoRequestError(`The ${field} must be text.`)
  if ([...value].length > max) throw new VideoRequestError(`The ${field} can be at most ${max} characters.`)
  if (hasControlCharacter(value)) throw new VideoRequestError(`The ${field} contains a control character.`)
  const trimmed = value.trim()
  if (opts.oneLine && NOT_ONE_PLAIN_LINE.test(trimmed)) throw new VideoRequestError(`The ${field} must be one line of plain text.`)
  if (opts.empty && trimmed === '') throw new VideoRequestError(opts.empty)
  return trimmed
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null
  return text(value, field, max) || null
}

function choice(value: unknown, options: readonly (string | number)[], message: string): string | number {
  if (!options.includes(value as string | number)) throw new VideoRequestError(message)
  return value as string | number
}

function anId(value: unknown): string | null {
  return typeof value === 'string' && ID.test(value) ? value : null
}

const toShot = (row: Omit<FilmShot, 'closeUp'> & { closeUp: number }): FilmShot => ({ ...row, closeUp: row.closeUp !== 0 })

export class FilmStore {
  constructor(
    private readonly db: Database.Database,
    private readonly media: FilmMedia,
    private readonly timing = { stopWaitMs: 60_000, stopPollMs: 250 },
  ) {}

  list(): FilmSummary[] {
    return this.db.prepare(`SELECT f.id, f.title, f.stage, f.seconds, f.look, f.updated_at AS updatedAt,
      (SELECT master_id FROM film_places p WHERE p.film_id = f.id AND p.deleted_at IS NULL ORDER BY p.position LIMIT 1) AS thumbId
      FROM films f WHERE f.deleted_at IS NULL ORDER BY f.created_at DESC, f.rowid DESC`).all() as FilmSummary[]
  }

  get(id: unknown): Film | null {
    const film = this.find(id)
    if (!film) return null
    const cast = this.db.prepare(`SELECT ${CAST_COLUMNS} FROM film_cast WHERE film_id = ? ORDER BY rowid`).all(film.id) as FilmCastMember[]
    const places = this.db.prepare(`SELECT ${PLACE_COLUMNS} FROM film_places WHERE film_id = ? AND deleted_at IS NULL ORDER BY position`).all(film.id) as FilmPlace[]
    const shots = (this.db.prepare(`SELECT ${SHOT_COLUMNS} FROM film_shots WHERE film_id = ? AND deleted_at IS NULL ORDER BY position`).all(film.id) as Parameters<typeof toShot>[0][]).map(toShot)
    // A candidate's picture is known once its job is done, before anyone chooses it.
    const pictures = this.db.prepare(`SELECT fp.id, fp.owner_kind AS ownerKind, fp.owner_id AS ownerId, fp.role, fp.job_id AS jobId, v.status,
      COALESCE(fp.image_id, CASE WHEN v.status = 'done' AND v.deleted_at IS NULL THEN v.image_id END) AS imageId,
      fp.seed, fp.check_state AS checkState, fp.check_notes AS checkNotes, fp.created_at AS createdAt
      FROM film_pictures fp LEFT JOIN videos v ON v.id = fp.job_id WHERE fp.film_id = ? ORDER BY fp.created_at, fp.rowid`).all(film.id) as FilmPicture[]
    return { ...film, sound: film.sound !== 0, cast, places, shots, pictures }
  }

  /** A new film at the story stage, with its own copy of each chosen cast member. */
  create(input: unknown): Film {
    const fields = this.filmFields(input)
    const castIds = this.liveCast(fields['castIds'])
    const count = (this.db.prepare(`SELECT COUNT(*) AS n FROM films WHERE deleted_at IS NULL`).get() as { n: number }).n
    if (count >= MAX_FILMS) throw new VideoRequestError(`There can be at most ${MAX_FILMS} films. Delete one you no longer need.`)
    const id = randomBytes(16).toString('hex')
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO films (id, title, story, seconds, look, sound, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'story', ?, ?)`)
        .run(id, fields.title, fields.story, fields.seconds, fields.look, fields.sound ? 1 : 0, now, now)
      for (const castId of castIds) this.addCast(id, castId)
    })()
    return this.get(id)!
  }

  /**
   * Changes a film's title, story, length, look, sound or cast. Its plan is kept. The look and the cast can change only
   * before pictures are made, since every picture is drawn in that look from those characters.
   */
  update(id: unknown, input: unknown): Film {
    const film = this.editable(id)
    const fields = this.filmFields(input)
    const wanted = fields['castIds']
    const current = this.db.prepare(`SELECT cast_id AS castId, name FROM film_cast WHERE film_id = ? ORDER BY rowid`).all(film.id) as Array<{ castId: string; name: string }>
    this.db.transaction(() => {
      if (EARLY_STAGES.has(film.stage)) {
        const castIds = this.liveCast(wanted)
        const leaving = current.filter((c) => !castIds.includes(c.castId))
        // Every check before any change, as removing a character also removes the film's copy of its picture.
        for (const { castId, name } of leaving) {
          if (this.db.prepare(`SELECT 1 FROM film_shots WHERE film_id = ? AND cast_id = ? AND deleted_at IS NULL`).get(film.id, castId)) {
            throw new VideoRequestError(`A shot uses ${name}: change or delete that shot first.`)
          }
        }
        for (const { castId } of leaving) this.removeCast(film.id, castId)
        for (const castId of castIds) {
          if (current.some((c) => c.castId === castId)) this.refreshCast(film.id, castId)
          else this.addCast(film.id, castId)
        }
      } else {
        if (fields.look !== film.look) throw new VideoRequestError('The look can\'t change once pictures are being made. Start a new film for another look.')
        const same = Array.isArray(wanted) && wanted.length === current.length && current.every((c) => wanted.includes(c.castId))
        if (!same) throw new VideoRequestError('The cast can\'t change once pictures are being made.')
      }
      this.db.prepare(`UPDATE films SET title = ?, story = ?, seconds = ?, look = ?, sound = ?, updated_at = ? WHERE id = ?`)
        .run(fields.title, fields.story, fields.seconds, fields.look, fields.sound ? 1 : 0, Date.now(), film.id)
    })()
    return this.get(film.id)!
  }

  /**
   * Soft-deletes a film and removes its own pictures and shot clips from disk once nothing else uses them. Its picture
   * jobs are stopped first, and no file is touched until they have ended. The joined film stays on the Video page.
   */
  async delete(id: unknown): Promise<boolean> {
    const film = this.find(id)
    if (!film) return false
    if (film.stage === 'making') throw new VideoRequestError(STOP_FIRST)
    const active = () => this.db.prepare(`SELECT id FROM videos WHERE film_id = ? AND deleted_at IS NULL AND status IN ('queued', 'running')`).all(film.id) as Array<{ id: string }>
    for (const job of active()) this.media.cancelFilmJob(job.id, film.id)
    const giveUpAt = performance.now() + this.timing.stopWaitMs
    while (active().length > 0) {
      if (performance.now() >= giveUpAt) throw new VideoRequestError('Mission Control is still stopping this film\'s pictures. Try again in a moment.')
      await new Promise((resolve) => setTimeout(resolve, this.timing.stopPollMs))
    }
    // No waiting from here on, so nothing can start a job for this film in between.
    const still = this.find(film.id)
    if (!still) return false
    if (still.stage === 'making') throw new VideoRequestError(STOP_FIRST)
    const pictures = this.picturesOf(film.id)
    this.db.prepare(`UPDATE films SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`).run(Date.now(), film.id)
    this.media.deleteFilmRows(film.id)
    for (const picture of pictures) if (!this.pictureInUse(picture)) this.media.removeImage(picture)
    return true
  }

  /** Adds a place at the end of the plan, or changes one when `id` names it. */
  savePlace(filmId: unknown, input: unknown): FilmPlace {
    const film = this.editable(filmId)
    const fields = fieldsOf(input, 'place', PLACE_FIELDS)
    const name = text(fields['name'], 'place name', MAX_TITLE, { oneLine: true, empty: 'The place needs a name.' })
    const description = text(fields['description'], 'description', MAX_PLACE_TEXT, { empty: 'Describe the place.' })
    const keep = text(fields['keep'], 'list of what stays the same', MAX_PLACE_TEXT, { empty: 'Say what must stay the same in this place.' })
    const prop = optionalText(fields['prop'], 'prop', MAX_PROP)
    const now = Date.now()
    if (fields['id'] !== undefined) {
      const place = this.place(film.id, fields['id'])
      this.db.prepare(`UPDATE film_places SET name = ?, description = ?, keep = ?, prop = ? WHERE id = ?`).run(name, description, keep, prop, place.id)
      this.touch(film.id, now)
      return this.place(film.id, place.id)
    }
    const count = this.livePlaces(film.id).length
    if (count >= MAX_PLACES) throw new VideoRequestError(`A film can have at most ${MAX_PLACES} places.`)
    const id = randomBytes(16).toString('hex')
    this.db.prepare(`INSERT INTO film_places (id, film_id, position, name, description, keep, prop) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, film.id, count, name, description, keep, prop)
    this.touch(film.id, now)
    return this.place(film.id, id)
  }

  deletePlace(filmId: unknown, id: unknown): boolean {
    const film = this.editable(filmId)
    const place = this.findPlace(film.id, id)
    if (!place) return false
    if (this.db.prepare(`SELECT 1 FROM film_shots WHERE place_id = ? AND deleted_at IS NULL`).get(place.id)) {
      throw new VideoRequestError('Shots happen in this place: move or delete those shots first.')
    }
    this.db.transaction(() => {
      this.db.prepare(`UPDATE film_places SET deleted_at = ? WHERE id = ?`).run(Date.now(), place.id)
      this.renumber('film_places', this.livePlaces(film.id))
      this.touch(film.id)
    })()
    return true
  }

  movePlace(filmId: unknown, id: unknown, position: unknown): void {
    const film = this.editable(filmId)
    const place = this.place(film.id, id)
    this.move('film_places', this.livePlaces(film.id), place.id, position)
    this.touch(film.id)
  }

  /** Adds a shot at the end of the plan, or changes one when `id` names it. A change drops the pictures it makes wrong. */
  saveShot(filmId: unknown, input: unknown): FilmShot {
    const film = this.editable(filmId)
    const fields = fieldsOf(input, 'shot', SHOT_FIELDS)
    const place = this.findPlace(film.id, fields['placeId'])
    if (!place) throw new VideoRequestError('That place is not in this film.')
    const castId = anId(fields['castId'])
    if (!castId || !this.db.prepare(`SELECT 1 FROM film_cast WHERE film_id = ? AND cast_id = ?`).get(film.id, castId)) {
      throw new VideoRequestError('That character is not in this film\'s cast.')
    }
    const action = text(fields['action'], 'action', MAX_ACTION, { empty: 'Say what happens in the shot.' })
    const startPose = text(fields['startPose'], 'start pose', MAX_POSE, { empty: 'Say how the shot starts (the start pose).' })
    const closeUp = fields['closeUp'] ?? false
    if (typeof closeUp !== 'boolean') throw new VideoRequestError('closeUp must be true or false.')
    const endPose = optionalText(fields['endPose'], 'end pose', MAX_POSE)
    const seconds = fields['seconds']
    if (closeUp) {
      if (endPose !== null) throw new VideoRequestError('A close-up has no end pose: it ends where the shot ends.')
      if (seconds !== 4 && seconds !== 5) throw new VideoRequestError('A close-up lasts 4 or 5 seconds.')
    } else {
      if (endPose === null) throw new VideoRequestError('Say how the shot ends (the end pose), or make it a close-up.')
      if (!Number.isInteger(seconds) || (seconds as number) < 4 || (seconds as number) > 8) throw new VideoRequestError('A shot lasts 4 to 8 seconds, in whole seconds.')
    }
    const joins = choice(fields['joins'], JOINS, `How the shot joins the one before must be one of: ${JOINS.join(', ')}.`) as string
    const seedIn = fields['seed'] ?? 0
    if (!Number.isInteger(seedIn) || (seedIn as number) < 0 || (seedIn as number) > MAX_SEED) throw new VideoRequestError(`The seed must be a whole number from 0 to ${MAX_SEED}.`)
    const seed = seedIn === 0 ? randomInt(1, MAX_SEED) : (seedIn as number)

    if (fields['id'] !== undefined) {
      const shot = this.shot(film.id, fields['id'])
      const samePlace = shot.placeId === place.id && shot.castId === castId && shot.closeUp === closeUp
      const startId = samePlace && shot.startPose === startPose ? shot.startId : null
      const endId = samePlace && shot.endPose === endPose ? shot.endId : null
      const changed = !samePlace || shot.action !== action || shot.startPose !== startPose || shot.endPose !== endPose ||
        shot.seconds !== seconds || shot.joins !== joins || (fields['seed'] !== undefined && shot.seed !== seed)
      this.db.prepare(`UPDATE film_shots SET place_id = ?, cast_id = ?, action = ?, start_pose = ?, end_pose = ?, seconds = ?, joins = ?, close_up = ?,
        seed = ?, start_id = ?, end_id = ?, revision = revision + ? WHERE id = ?`)
        .run(place.id, castId, action, startPose, endPose, seconds, joins, closeUp ? 1 : 0, fields['seed'] === undefined ? shot.seed : seed,
          startId, endId, changed ? 1 : 0, shot.id)
      this.touch(film.id)
      return this.shot(film.id, shot.id)
    }
    const count = this.liveShots(film.id).length
    if (count >= MAX_SHOTS) throw new VideoRequestError(`A film can have at most ${MAX_SHOTS} shots.`)
    const id = randomBytes(16).toString('hex')
    this.db.prepare(`INSERT INTO film_shots (id, film_id, position, place_id, cast_id, action, start_pose, end_pose, seconds, joins, close_up, seed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, film.id, count, place.id, castId, action, startPose, endPose, seconds, joins, closeUp ? 1 : 0, seed)
    this.touch(film.id)
    return this.shot(film.id, id)
  }

  deleteShot(filmId: unknown, id: unknown): boolean {
    const film = this.editable(filmId)
    const shot = this.findShot(film.id, id)
    if (!shot) return false
    this.db.transaction(() => {
      this.db.prepare(`UPDATE film_shots SET deleted_at = ? WHERE id = ?`).run(Date.now(), shot.id)
      this.renumber('film_shots', this.liveShots(film.id))
      this.touch(film.id)
    })()
    return true
  }

  moveShot(filmId: unknown, id: unknown, position: unknown): void {
    const film = this.editable(filmId)
    const shot = this.shot(film.id, id)
    this.move('film_shots', this.liveShots(film.id), shot.id, position)
    this.touch(film.id)
  }

  /**
   * Records a picture job the director queued as a candidate for one of this film's places, shots or cast members.
   * The role must fit the owner, and the job must be this film's own picture job.
   */
  addCandidate(filmId: unknown, input: { ownerKind: string; ownerId: unknown; role: string; jobId: unknown; seed: number; checkState?: 'none' | 'off' }): string {
    const film = this.film(filmId)
    const ownerId = this.checkSlot(film.id, input.ownerKind, input.ownerId, input.role, 1)
    const jobId = anId(input.jobId)
    if (!jobId || !this.db.prepare(`SELECT 1 FROM videos WHERE id = ? AND film_id = ? AND kind = 'picture' AND deleted_at IS NULL`).get(jobId, film.id)) {
      throw new VideoRequestError('That picture job is not this film\'s.')
    }
    if (!Number.isInteger(input.seed)) throw new VideoRequestError('The seed must be a whole number.')
    const id = randomBytes(16).toString('hex')
    this.db.prepare(`INSERT INTO film_pictures (id, film_id, owner_kind, owner_id, role, job_id, seed, check_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, film.id, input.ownerKind, ownerId, input.role, jobId, input.seed, input.checkState ?? 'none', Date.now())
    return id
  }

  /**
   * Checks that `adding` more candidates may go to this slot (the role fits the owner, the owner is this film's, and
   * the slot stays within MAX_CANDIDATES), before the director queues their jobs. Returns the owner's id.
   */
  checkSlot(filmId: unknown, ownerKind: string, ownerId: unknown, role: string, adding: number): string {
    const film = this.film(filmId)
    if (ROLE_OWNER[role] === undefined || ROLE_OWNER[role] !== ownerKind) throw new VideoRequestError('That role doesn\'t fit what the picture is for.')
    const owner = this.ownerOf(film.id, ownerKind as OwnerKind, ownerId)
    const count = (this.db.prepare(`SELECT COUNT(*) AS n FROM film_pictures WHERE film_id = ? AND owner_id = ? AND role = ?`).get(film.id, owner, role) as { n: number }).n
    if (count + adding > MAX_CANDIDATES) throw new VideoRequestError(`There can be at most ${MAX_CANDIDATES} pictures to choose from here. Choose one of them.`)
    return owner
  }

  /** The director moving a film between its stages (the user's edits move it from story to plan). */
  setStage(filmId: string, stage: FilmStage, problem: string | null = null): void {
    this.db.prepare(`UPDATE films SET stage = ?, problem = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(stage, problem, Date.now(), filmId)
  }

  /** A place with no picture of it on its own yet uses its chosen master (made with no people or animals in it). */
  useMasterAsEmpty(filmId: string): void {
    this.db.prepare(`UPDATE film_places SET empty_id = master_id WHERE film_id = ? AND empty_id IS NULL AND master_id IS NOT NULL AND deleted_at IS NULL`).run(filmId)
  }

  setSheet(filmId: string, placeId: string, imageId: string): void {
    this.db.prepare(`UPDATE film_places SET sheet_id = ? WHERE id = ? AND film_id = ? AND deleted_at IS NULL`).run(imageId, placeId, filmId)
  }

  /** Records a finished clip, only if the shot hasn't changed since it was queued. False: throw the clip away. */
  recordClip(filmId: string, shotId: string, revision: number, clipId: string, seed: number): boolean {
    return this.db.prepare(`UPDATE film_shots SET clip_id = ?, clip_seed = ?, clip_rev = ? WHERE id = ? AND film_id = ? AND revision = ? AND deleted_at IS NULL`)
      .run(clipId, seed, revision, shotId, filmId, revision).changes === 1
  }

  /** The finished film: its joined video and the `done` stage. Returns the film it replaces, if any. */
  setJoined(filmId: string, videoId: string): string | null {
    const before = this.find(filmId)?.videoId ?? null
    this.db.prepare(`UPDATE films SET video_id = ?, stage = 'done', problem = NULL, updated_at = ? WHERE id = ?`).run(videoId, Date.now(), filmId)
    return before
  }

  /** Redo: the shot's clip is no longer current, made again with a new seed if asked. */
  prepareRedo(filmId: unknown, shotId: unknown, newSeed: boolean): void {
    const film = this.editable(filmId)
    if (!MAKE_FROM.has(film.stage) || film.stage === 'shots') throw new VideoRequestError('Make the film first; then any shot can be made again.')
    const shot = this.shot(film.id, shotId)
    if (newSeed) this.db.prepare(`UPDATE film_shots SET seed = ?, revision = revision + 1 WHERE id = ?`).run(randomInt(1, MAX_SEED), shot.id)
    else this.db.prepare(`UPDATE film_shots SET clip_rev = NULL WHERE id = ?`).run(shot.id)
  }

  /**
   * Chooses one of this film's finished candidates as a place's master or empty picture, a shot's start or end, or a
   * character's turnaround or face. The pictures made from the old choice are dropped, and the shots they fed are
   * marked for remaking (their revision goes up).
   */
  choose(filmId: unknown, pictureId: unknown): void {
    const film = this.editable(filmId)
    if (!PICTURE_STAGES.has(film.stage)) throw new VideoRequestError('You can choose pictures once they are being made.')
    const id = anId(pictureId)
    const picture = id ? this.db.prepare(`SELECT owner_kind AS ownerKind, owner_id AS ownerId, role, job_id AS jobId, image_id AS imageId
      FROM film_pictures WHERE id = ? AND film_id = ?`).get(id, film.id) as { ownerKind: OwnerKind; ownerId: string; role: string; jobId: string; imageId: string | null } | undefined : undefined
    if (!picture) throw new VideoRequestError('That picture is no longer in this film.')
    const imageId = picture.imageId ?? this.media.pictureOf(picture.jobId)
    if (!imageId) throw new VideoRequestError('That picture is not finished yet.')
    const ownerId = this.ownerOf(film.id, picture.ownerKind, picture.ownerId)

    this.db.transaction(() => {
      this.db.prepare(`UPDATE film_pictures SET image_id = ? WHERE id = ?`).run(imageId, id)
      const remake = this.db.prepare(`UPDATE film_shots SET revision = revision + 1 WHERE id = ?`)
      switch (picture.role) {
        case 'master':
          this.db.prepare(`UPDATE film_places SET master_id = ?, empty_id = NULL, sheet_id = NULL WHERE id = ?`).run(imageId, ownerId)
          this.db.prepare(`UPDATE film_shots SET start_id = NULL, end_id = NULL, revision = revision + 1 WHERE place_id = ? AND deleted_at IS NULL`).run(ownerId)
          break
        case 'empty':
          this.db.prepare(`UPDATE film_places SET empty_id = ? WHERE id = ?`).run(imageId, ownerId)
          this.dropSheets(film.id, [ownerId])
          break
        case 'start':
          this.db.prepare(`UPDATE film_shots SET start_id = ? WHERE id = ?`).run(imageId, ownerId)
          remake.run(ownerId)
          break
        case 'end': {
          this.db.prepare(`UPDATE film_shots SET end_id = ? WHERE id = ?`).run(imageId, ownerId)
          remake.run(ownerId)
          // A shot that follows on in the same place starts where this one ends (and the join drops its first frame).
          const shots = this.liveShots(film.id)
          const at = shots.findIndex((s) => s.id === ownerId)
          const next = shots[at + 1]
          if (next && next.joins === 'follows' && next.placeId === shots[at]!.placeId && !next.closeUp) {
            this.db.prepare(`UPDATE film_shots SET start_id = ? WHERE id = ?`).run(imageId, next.id)
            remake.run(next.id)
          }
          break
        }
        case 'turnaround':
        case 'face': {
          this.db.prepare(`UPDATE film_cast SET ${picture.role === 'face' ? 'face_id' : 'turnaround_id'} = ? WHERE film_id = ? AND cast_id = ?`).run(imageId, film.id, ownerId)
          const places = this.db.prepare(`SELECT DISTINCT place_id AS placeId FROM film_shots WHERE film_id = ? AND cast_id = ? AND deleted_at IS NULL`).all(film.id, ownerId) as Array<{ placeId: string }>
          this.dropSheets(film.id, places.map((p) => p.placeId))
          break
        }
      }
      this.touch(film.id)
    })()
  }

  /**
   * Make film: moves the film to `making` with one compare-and-set, so a second press, or a second film, is refused.
   * Every shot needs its pictures chosen first.
   */
  beginMaking(filmId: unknown): void {
    const film = this.film(filmId)
    if (film.stage === 'making') throw new VideoRequestError('This film is already being made.')
    if (!MAKE_FROM.has(film.stage)) throw new VideoRequestError('Choose the pictures first.')
    const shots = this.liveShots(film.id)
    if (shots.length === 0) throw new VideoRequestError('This film has no shots yet.')
    const unready = shots.findIndex((s) => !s.startId || (!s.closeUp && !s.endId))
    if (unready >= 0) throw new VideoRequestError(`Choose the pictures for shot ${unready + 1} first.`)
    const started = this.db.prepare(`UPDATE films SET stage = 'making', problem = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL
      AND stage IN ('shots', 'stopped', 'done') AND NOT EXISTS (SELECT 1 FROM films WHERE stage = 'making' AND deleted_at IS NULL)`).run(Date.now(), film.id)
    if (started.changes !== 1) throw new VideoRequestError('Only one film is made at a time, and another film is being made. Wait for it to finish, or stop it first.')
  }

  /** A stored picture, only while a live film uses it (for the /media/picture route). */
  picturePath(id: unknown): StoredImage | null {
    const imageId = anId(id)
    if (!imageId) return null
    const used = PICTURE_REFERENCES.some(([table, column]) => this.db.prepare(
      `SELECT 1 FROM ${table} t JOIN films f ON f.id = t.film_id AND f.deleted_at IS NULL WHERE t.${column} = ? LIMIT 1`).get(imageId)) ||
      this.db.prepare(`SELECT 1 FROM videos v JOIN films f ON f.id = v.film_id AND f.deleted_at IS NULL WHERE v.image_id = ? AND v.deleted_at IS NULL LIMIT 1`).get(imageId)
    return used ? this.media.findImage(imageId) : null
  }

  /** A finished shot clip, only while its film is live (for the /media/video route; the Video page never sees it). */
  clipPath(id: unknown): string | null {
    const clipId = anId(id)
    if (!clipId) return null
    const row = this.db.prepare(`SELECT v.film_id AS filmId FROM videos v JOIN films f ON f.id = v.film_id AND f.deleted_at IS NULL WHERE v.id = ?`).get(clipId) as { filmId: string } | undefined
    return row ? this.media.filmFilePath(clipId, row.filmId) : null
  }

  private find(id: unknown): FilmRow | null {
    const filmId = anId(id)
    if (!filmId) return null
    return (this.db.prepare(`SELECT ${FILM_COLUMNS} FROM films WHERE id = ? AND deleted_at IS NULL`).get(filmId) as FilmRow | undefined) ?? null
  }

  private film(id: unknown): FilmRow {
    const film = this.find(id)
    if (!film) throw new VideoRequestError('That film no longer exists.')
    return film
  }

  // A film that may be changed: not while it is being made.
  private editable(id: unknown): FilmRow {
    const film = this.film(id)
    if (film.stage === 'making') throw new VideoRequestError(STOP_FIRST)
    return film
  }

  private filmFields(input: unknown): { title: string; story: string; seconds: number; look: string; sound: boolean; castIds: unknown } {
    const fields = fieldsOf(input, 'film', FILM_FIELDS)
    const title = text(fields['title'], 'title', MAX_TITLE, { oneLine: true, empty: 'The film needs a title.' })
    const story = text(fields['story'], 'story', MAX_STORY)
    const seconds = choice(fields['seconds'], FILM_SECONDS, 'The film\'s length must be 30, 60, 90 or 120 seconds.') as number
    const look = choice(fields['look'], LOOKS, 'The look must be realistic or cartoon.') as string
    if (typeof fields['sound'] !== 'boolean') throw new VideoRequestError('sound must be true or false.')
    return { title, story, seconds, look, sound: fields['sound'], castIds: fields['castIds'] }
  }

  // The chosen cast ids, each a live member of the cast, none twice.
  private liveCast(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) throw new VideoRequestError('Choose at least one character from the cast.')
    if (value.length > MAX_FILM_CAST) throw new VideoRequestError(`A film can have at most ${MAX_FILM_CAST} characters.`)
    const ids = value.map((v) => {
      const id = anId(v)
      if (!id || !this.db.prepare(`SELECT 1 FROM video_cast WHERE id = ? AND deleted_at IS NULL`).get(id)) throw new VideoRequestError('That character is no longer in the cast.')
      return id
    })
    if (new Set(ids).size !== ids.length) throw new VideoRequestError('A character is chosen twice.')
    return ids
  }

  // The film's own copy of a cast member: its name and wording now, and a copy of its picture under a new id.
  private addCast(filmId: string, castId: string): void {
    const member = this.db.prepare(`SELECT name, wording, image_id AS imageId FROM video_cast WHERE id = ?`).get(castId) as { name: string; wording: string; imageId: string | null }
    const pictureId = member.imageId ? this.media.copyImage(member.imageId) : null
    this.db.prepare(`INSERT INTO film_cast (film_id, cast_id, name, wording, picture_id) VALUES (?, ?, ?, ?, ?)`).run(filmId, castId, member.name, member.wording, pictureId)
  }

  private refreshCast(filmId: string, castId: string): void {
    this.db.prepare(`UPDATE film_cast SET name = (SELECT name FROM video_cast WHERE id = ?), wording = (SELECT wording FROM video_cast WHERE id = ?)
      WHERE film_id = ? AND cast_id = ?`).run(castId, castId, filmId, castId)
  }

  private removeCast(filmId: string, castId: string): void {
    const row = this.db.prepare(`SELECT picture_id AS pictureId, turnaround_id AS turnaroundId, face_id AS faceId FROM film_cast WHERE film_id = ? AND cast_id = ?`)
      .get(filmId, castId) as Record<string, string | null>
    this.db.prepare(`DELETE FROM film_cast WHERE film_id = ? AND cast_id = ?`).run(filmId, castId)
    for (const picture of Object.values(row)) if (picture && !this.pictureInUse(picture)) this.media.removeImage(picture)
  }

  private findPlace(filmId: string, id: unknown): FilmPlace | null {
    const placeId = anId(id)
    if (!placeId) return null
    return (this.db.prepare(`SELECT ${PLACE_COLUMNS} FROM film_places WHERE id = ? AND film_id = ? AND deleted_at IS NULL`).get(placeId, filmId) as FilmPlace | undefined) ?? null
  }

  private place(filmId: string, id: unknown): FilmPlace {
    const place = this.findPlace(filmId, id)
    if (!place) throw new VideoRequestError('That place is no longer in this film.')
    return place
  }

  private findShot(filmId: string, id: unknown): FilmShot | null {
    const shotId = anId(id)
    if (!shotId) return null
    const row = this.db.prepare(`SELECT ${SHOT_COLUMNS} FROM film_shots WHERE id = ? AND film_id = ? AND deleted_at IS NULL`).get(shotId, filmId) as Parameters<typeof toShot>[0] | undefined
    return row ? toShot(row) : null
  }

  private shot(filmId: string, id: unknown): FilmShot {
    const shot = this.findShot(filmId, id)
    if (!shot) throw new VideoRequestError('That shot is no longer in this film.')
    return shot
  }

  private livePlaces(filmId: string): FilmPlace[] {
    return this.db.prepare(`SELECT ${PLACE_COLUMNS} FROM film_places WHERE film_id = ? AND deleted_at IS NULL ORDER BY position`).all(filmId) as FilmPlace[]
  }

  private liveShots(filmId: string): FilmShot[] {
    return (this.db.prepare(`SELECT ${SHOT_COLUMNS} FROM film_shots WHERE film_id = ? AND deleted_at IS NULL ORDER BY position`).all(filmId) as Parameters<typeof toShot>[0][]).map(toShot)
  }

  // The id of the place, shot or cast member a candidate belongs to, checked against this film.
  private ownerOf(filmId: string, kind: OwnerKind, id: unknown): string {
    if (kind === 'place') return this.findPlace(filmId, id)?.id ?? this.refuse('That place is not in this film.')
    if (kind === 'shot') return this.findShot(filmId, id)?.id ?? this.refuse('That shot is no longer in this film.')
    const castId = anId(id)
    if (!castId || !this.db.prepare(`SELECT 1 FROM film_cast WHERE film_id = ? AND cast_id = ?`).get(filmId, castId)) {
      this.refuse('That character is not in this film\'s cast.')
    }
    return castId
  }

  private refuse(message: string): never {
    throw new VideoRequestError(message)
  }

  // A place's sheet shows the characters and the place, so it is made again, and every shot it guided with it.
  private dropSheets(filmId: string, placeIds: string[]): void {
    for (const placeId of placeIds) {
      this.db.prepare(`UPDATE film_places SET sheet_id = NULL WHERE id = ? AND film_id = ?`).run(placeId, filmId)
      this.db.prepare(`UPDATE film_shots SET revision = revision + 1 WHERE place_id = ? AND film_id = ? AND deleted_at IS NULL`).run(placeId, filmId)
    }
  }

  private move(table: 'film_places' | 'film_shots', rows: Array<{ id: string }>, id: string, position: unknown): void {
    if (!Number.isInteger(position) || (position as number) < 0 || (position as number) >= rows.length) throw new VideoRequestError('That position is outside the list.')
    const order = rows.filter((r) => r.id !== id)
    order.splice(position as number, 0, { id })
    this.db.transaction(() => this.renumber(table, order))()
  }

  private renumber(table: 'film_places' | 'film_shots', rows: Array<{ id: string }>): void {
    const set = this.db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`)
    rows.forEach((row, i) => set.run(i, row.id))
  }

  private touch(filmId: string, now = Date.now()): void {
    // A first place or shot turns a story into a plan.
    this.db.prepare(`UPDATE films SET updated_at = ?, stage = CASE WHEN stage = 'story' THEN 'plan' ELSE stage END WHERE id = ?`).run(now, filmId)
  }

  // Every stored picture this film's rows name, its finished picture jobs' pictures among them.
  private picturesOf(filmId: string): string[] {
    const ids = new Set<string>()
    for (const [table, column] of PICTURE_REFERENCES) {
      for (const row of this.db.prepare(`SELECT ${column} AS id FROM ${table} WHERE film_id = ? AND ${column} IS NOT NULL`).all(filmId) as Array<{ id: string }>) ids.add(row.id)
    }
    for (const row of this.db.prepare(`SELECT image_id AS id FROM videos WHERE film_id = ? AND image_id IS NOT NULL`).all(filmId) as Array<{ id: string }>) ids.add(row.id)
    return [...ids]
  }

  // True while anything else still names the picture: the cast (even a deleted member, whose picture stays as it
  // always has), a live film's rows, or a live job (a Video page job's params, a picture job's output).
  private pictureInUse(imageId: string): boolean {
    if (this.db.prepare(`SELECT 1 FROM video_cast WHERE image_id = ? LIMIT 1`).get(imageId)) return true
    for (const [table, column] of PICTURE_REFERENCES) {
      if (this.db.prepare(`SELECT 1 FROM ${table} t JOIN films f ON f.id = t.film_id AND f.deleted_at IS NULL WHERE t.${column} = ? LIMIT 1`).get(imageId)) return true
    }
    return this.db.prepare(`SELECT 1 FROM videos WHERE deleted_at IS NULL AND (image_id = ? OR params LIKE ?) LIMIT 1`).get(imageId, `%"${imageId}"%`) !== undefined
  }
}
