// Run with: npm test
// The Storyboard's film store (storyboard spec 8 and 15): every field checked, every id owned by its film, edits
// refused while a film is being made, one film made at a time, and deleting a film removes only its own files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/store/db.js'
import { VideoCast } from '../src/video/cast.js'
import { VideoJobs, VideoRequestError } from '../src/video/jobs.js'
import { FilmStore, MAX_FILMS, MAX_PLACES, MAX_SHOTS, MAX_CANDIDATES, slotBasis } from '../src/video/films.js'
import { ImageInputs } from '../src/video/image-input.js'
import { rgbPng } from '../src/video/png-strip.js'
import { referenceIdFor } from '../src/video/reference-cut.js'
import { registerFilmMakingMethods, registerVideoMethods } from '../src/methods/video.js'
import type { FilmDirector } from '../src/video/film-director.js'
import type { FilmHelper } from '../src/video/film-helper.js'
import { dispatch } from '../src/router.js'
import type { ConnectedClient } from '../src/types.js'
import type Database from 'better-sqlite3'

function png(width = 96, height = 64): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))])
}

function setup(timing = { stopWaitMs: 2000, stopPollMs: 10 }) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-films-'))
  const db = openDatabase(join(dir, 'test.sqlite'))
  const mediaDir = join(dir, 'media')
  const jobs = new VideoJobs(db, mediaDir, () => ({ comfyUrl: 'http://127.0.0.1:1', freeAfterJob: false }), () => {})
  const cast = new VideoCast(db, (id) => jobs.hasImage(id))
  const films = new FilmStore(db, jobs, timing)
  const picture = () => jobs.uploadImage(png().toString('base64')).id
  const rex = cast.save({ name: 'Rex', wording: 'black and white border collie, white blaze', imageId: picture() })
  const bess = cast.save({ name: 'Bess', wording: 'small brown terrier' })
  const tom = cast.save({ name: 'Tom', wording: 'a man in his sixties with a flat tweed cap', imageId: picture() })
  return { db, mediaDir, jobs, cast, films, picture, rex, bess, tom }
}

type Setup = ReturnType<typeof setup>

const FILM = { title: 'The red door', story: 'Rex finds a red door and goes through it.', seconds: 30, look: 'realistic', sound: true }

function filmWithPlan(s: Setup) {
  const film = s.films.create({ ...FILM, castIds: [s.rex.id] })
  const garden = s.films.savePlace(film.id, { name: 'The garden', description: 'a small walled garden', keep: 'the red door stays shut' })
  const kitchen = s.films.savePlace(film.id, { name: 'The kitchen', description: 'a farmhouse kitchen', keep: 'the table stays by the window', prop: 'a red ball' })
  const shot = (placeId: string, joins = 'follows', extra: Record<string, unknown> = {}) => s.films.saveShot(film.id, {
    placeId, characters: [{ castId: s.rex.id, startPose: 'standing by the wall', endPose: 'standing at the door' }], action: 'walks to the door', seconds: 6, joins, closeUp: false, ...extra,
  })
  const shots = [shot(garden.id, 'fade_short'), shot(garden.id), shot(kitchen.id, 'fade_long')]
  return { film, garden, kitchen, shots }
}

// A picture job the director would have queued for this film, finished with a stored picture.
function finishedPictureJob(s: Setup, filmId: string, status = 'done'): { jobId: string; imageId: string } {
  const jobId = randomBytes(16).toString('hex')
  const imageId = s.picture()
  s.db.prepare(`INSERT INTO videos (id, recipe_id, params, status, created_at, kind, film_id, image_id) VALUES (?, 'film-edit-fast', '{}', ?, ?, 'picture', ?, ?)`)
    .run(jobId, status, Date.now(), filmId, status === 'done' ? imageId : null)
  return { jobId, imageId }
}

function candidate(s: Setup, filmId: string, ownerKind: string, ownerId: string, role: string): { pictureId: string; imageId: string } {
  const { jobId, imageId } = finishedPictureJob(s, filmId)
  return { pictureId: s.films.addCandidate(filmId, { ownerKind, ownerId, role, jobId, seed: 7 }), imageId }
}

const refused = (fn: () => unknown, message?: RegExp) => assert.throws(fn, (err: unknown) => err instanceof VideoRequestError && (!message || message.test(err.message)))

function setStage(db: Database.Database, filmId: string, stage: string): void {
  db.prepare(`UPDATE films SET stage = ? WHERE id = ?`).run(stage, filmId)
}

test('a film is made with its own copy of the cast: name, wording and a new picture id, never the cast\'s own', () => {
  const s = setup()
  const film = s.films.create({ ...FILM, castIds: [s.rex.id, s.bess.id] })
  assert.match(film.id, /^[0-9a-f]{32}$/)
  assert.equal(film.stage, 'story')
  assert.deepEqual(film.cast.map((c) => [c.castId, c.name, c.wording]), [
    [s.rex.id, 'Rex', 'black and white border collie, white blaze'],
    [s.bess.id, 'Bess', 'small brown terrier'],
  ])
  const copy = film.cast[0]!.pictureId!
  assert.notEqual(copy, s.rex.imageId)
  assert.ok(s.jobs.hasImage(copy))
  assert.deepEqual(readFileSync(s.jobs.findImage(copy)!.path), readFileSync(s.jobs.findImage(s.rex.imageId!)!.path))
  assert.equal(film.cast[1]!.pictureId, null)
})

test('a later edit or delete of a cast member does not change a film that uses it', () => {
  const s = setup()
  const { film } = filmWithPlan(s)
  s.cast.save({ id: s.rex.id, name: 'Rex', wording: 'a golden retriever' })
  s.cast.delete(s.rex.id)
  const after = s.films.get(film.id)!
  assert.equal(after.cast[0]!.wording, 'black and white border collie, white blaze')
  assert.ok(s.jobs.hasImage(after.cast[0]!.pictureId!))
})

test('films are listed newest first, and deleted ones are gone', async () => {
  const s = setup()
  const a = s.films.create({ ...FILM, title: 'First', castIds: [s.rex.id] })
  s.db.prepare(`UPDATE films SET created_at = created_at - 1000 WHERE id = ?`).run(a.id)
  const b = s.films.create({ ...FILM, title: 'Second', castIds: [s.rex.id] })
  assert.deepEqual(s.films.list().map((f) => f.title), ['Second', 'First'])
  assert.equal(await s.films.delete(b.id), true)
  assert.deepEqual(s.films.list().map((f) => f.title), ['First'])
  assert.equal(s.films.get(b.id), null)
})

test('every film field is checked, and anything it cannot store as given is refused', () => {
  const s = setup()
  const ok = { ...FILM, castIds: [s.rex.id] }
  refused(() => s.films.create({ ...ok, extra: 1 }), /unknown field: extra/)
  refused(() => s.films.create({ ...ok, title: '' }), /title/)
  refused(() => s.films.create({ ...ok, title: 'Two\nlines' }), /one line/)
  refused(() => s.films.create({ ...ok, title: 'x'.repeat(61) }), /at most 60/)
  refused(() => s.films.create({ ...ok, story: 'x'.repeat(2001) }), /at most 2000/)
  refused(() => s.films.create({ ...ok, story: 'bell\u0007' }), /control character/)
  refused(() => s.films.create({ ...ok, seconds: 45 }), /30, 60, 90 or 120/)
  refused(() => s.films.create({ ...ok, look: 'noir' }), /realistic or cartoon/)
  refused(() => s.films.create({ ...ok, sound: 'yes' }), /sound/)
  refused(() => s.films.create({ ...ok, castIds: [] }), /at least one/)
  refused(() => s.films.create({ ...ok, castIds: ['../../etc/passwd'] }), /cast/)
  refused(() => s.films.create({ ...ok, castIds: ['c'.repeat(32)] }), /cast/)
  refused(() => s.films.create({ ...ok, castIds: [s.rex.id, s.rex.id] }), /twice/)
  refused(() => s.films.create(null))
  const story = 'Rex runs.\nThen he sleeps.'
  assert.equal(s.films.create({ ...ok, story }).story, story, 'a story may have line breaks')
})

test(`at most ${MAX_FILMS} films`, () => {
  const s = setup()
  for (let i = 0; i < MAX_FILMS; i++) s.films.create({ ...FILM, castIds: [s.rex.id] })
  refused(() => s.films.create({ ...FILM, castIds: [s.rex.id] }), new RegExp(`${MAX_FILMS} films`))
})

test('a film can be changed; the look and the cast only before any pictures are made', () => {
  const s = setup()
  const { film } = filmWithPlan(s)
  assert.equal(film.stage, 'story')
  const planned = s.films.get(film.id)!
  assert.equal(planned.stage, 'plan', 'adding places and shots makes a plan')
  const changed = s.films.update(film.id, { ...FILM, title: 'The blue door', look: 'cartoon', castIds: [s.rex.id, s.bess.id] })
  assert.equal(changed.title, 'The blue door')
  assert.equal(changed.look, 'cartoon')
  assert.equal(changed.cast.length, 2)
  assert.equal(changed.shots.length, 3, 'editing the story keeps the plan')
  refused(() => s.films.update(film.id, { ...FILM, castIds: [s.bess.id] }), /Rex/)

  setStage(s.db, film.id, 'places')
  assert.equal(s.films.update(film.id, { ...FILM, look: 'cartoon', castIds: [s.rex.id, s.bess.id], title: 'Later' }).title, 'Later')
  refused(() => s.films.update(film.id, { ...FILM, look: 'realistic', castIds: [s.rex.id, s.bess.id] }), /look/)
  refused(() => s.films.update(film.id, { ...FILM, look: 'cartoon', castIds: [s.rex.id] }), /cast/)
  refused(() => s.films.update('f'.repeat(32), { ...FILM, castIds: [s.rex.id] }), /no longer/)
})

test('places are checked, kept in order, moved, and at most eight', () => {
  const s = setup()
  const { film, garden, kitchen } = filmWithPlan(s)
  const add = { name: 'The lane', description: 'a country lane', keep: 'the gate stays open' }
  refused(() => s.films.savePlace(film.id, { ...add, colour: 'red' }), /unknown field/)
  refused(() => s.films.savePlace(film.id, { ...add, name: 'a\nb' }), /one line/)
  refused(() => s.films.savePlace(film.id, { ...add, description: 'x'.repeat(501) }), /at most 500/)
  refused(() => s.films.savePlace(film.id, { ...add, keep: '' }), /stay/)
  refused(() => s.films.savePlace(film.id, { ...add, prop: 'x'.repeat(301) }), /at most 300/)
  const lane = s.films.savePlace(film.id, add)
  s.films.movePlace(film.id, lane.id, 0)
  assert.deepEqual(s.films.get(film.id)!.places.map((p) => p.name), ['The lane', 'The garden', 'The kitchen'])
  assert.deepEqual(s.films.get(film.id)!.places.map((p) => p.position), [0, 1, 2])
  refused(() => s.films.movePlace(film.id, lane.id, 3), /position/)
  const edited = s.films.savePlace(film.id, { ...add, id: kitchen.id, name: 'The big kitchen' })
  assert.equal(edited.position, 2)
  for (let i = 3; i < MAX_PLACES; i++) s.films.savePlace(film.id, { ...add, name: `Place ${i}` })
  refused(() => s.films.savePlace(film.id, add), new RegExp(`${MAX_PLACES} places`))
  refused(() => s.films.deletePlace(film.id, garden.id), /shots/)
  assert.equal(s.films.deletePlace(film.id, lane.id), true)
  assert.deepEqual(s.films.get(film.id)!.places.map((p) => p.position), [0, 1, 2, 3, 4, 5, 6])
})

test('shots are checked: the place and the characters must be this film\'s, lengths and joins in range', () => {
  const s = setup()
  const { film, garden } = filmWithPlan(s)
  const other = filmWithPlan(s)
  const rex = { castId: s.rex.id, startPose: 'sitting by the door', endPose: 'standing at the door' }
  const ok = { placeId: garden.id, characters: [rex], action: 'sniffs the door', seconds: 5, joins: 'follows', closeUp: false }
  const closeUp = { ...ok, closeUp: true, seconds: 4, characters: [{ castId: s.rex.id, startPose: 'sitting by the door' }] }
  refused(() => s.films.saveShot(film.id, { ...ok, placeId: other.garden.id }), /place/)
  refused(() => s.films.saveShot(film.id, { ...ok, characters: [{ ...rex, castId: s.bess.id }] }), /cast/)
  refused(() => s.films.saveShot(film.id, { ...ok, castId: s.rex.id }), /unknown field: castId/)
  refused(() => s.films.saveShot(film.id, { ...ok, seconds: 9 }), /4 to 8/)
  refused(() => s.films.saveShot(film.id, { ...ok, seconds: 5.5 }), /4 to 8/)
  refused(() => s.films.saveShot(film.id, { ...closeUp, seconds: 6 }), /close-up.*4 or 5/)
  refused(() => s.films.saveShot(film.id, { ...closeUp, characters: [rex] }), /close-up.*end/)
  refused(() => s.films.saveShot(film.id, { ...ok, characters: [{ ...rex, endPose: '' }] }), /how Rex ends/)
  refused(() => s.films.saveShot(film.id, { ...ok, characters: [{ ...rex, startPose: ' ' }] }), /how Rex starts/)
  refused(() => s.films.saveShot(film.id, { ...ok, joins: 'wipe' }), /joins/)
  refused(() => s.films.saveShot(film.id, { ...ok, action: 'x'.repeat(601) }), /at most 600/)
  refused(() => s.films.saveShot(film.id, { ...ok, characters: [{ ...rex, startPose: 'x'.repeat(301) }] }), /at most 300/)
  refused(() => s.films.saveShot(film.id, { ...ok, characters: [{ ...rex, endPose: 'x'.repeat(301) }] }), /at most 300/)
  refused(() => s.films.saveShot(film.id, { ...ok, seed: -1 }), /seed/)
  refused(() => s.films.saveShot(film.id, { ...ok, id: other.shots[0]!.id }), /no longer/)
  const made = s.films.saveShot(film.id, closeUp)
  assert.deepEqual(made.characters, [{ castId: s.rex.id, startPose: 'sitting by the door', endPose: null }])
  assert.ok(made.seed >= 1)
  for (let i = s.films.get(film.id)!.shots.length; i < MAX_SHOTS; i++) s.films.saveShot(film.id, ok)
  refused(() => s.films.saveShot(film.id, ok), new RegExp(`${MAX_SHOTS} shots`))
})

test('a shot can show one to three different characters, each with its own start and end; a close-up shows one', () => {
  const s = setup()
  const film = s.films.create({ ...FILM, castIds: [s.rex.id, s.bess.id, s.tom.id] })
  const extra = s.cast.save({ name: 'Moss', wording: 'a grey cat', imageId: s.picture() })
  const garden = s.films.savePlace(film.id, { name: 'The garden', description: 'a small walled garden', keep: 'the red door stays shut' })
  const who = (castId: string, i = 0) => ({ castId, startPose: `standing at spot ${i}`, endPose: `sitting at spot ${i}` })
  const ok = { placeId: garden.id, characters: [who(s.rex.id, 1), who(s.bess.id, 2), who(s.tom.id, 3)], action: 'they settle on the grass', seconds: 6, joins: 'follows', closeUp: false }
  const three = s.films.saveShot(film.id, ok)
  assert.deepEqual(three.characters, ok.characters, 'kept in the order given: the first is added to the picture first')
  assert.deepEqual(s.films.get(film.id)!.shots[0]!.characters, ok.characters)
  refused(() => s.films.saveShot(film.id, { ...ok, characters: [] }), /at least one character/)
  refused(() => s.films.saveShot(film.id, { ...ok, characters: [...ok.characters, who(extra.id)] }), /at most 3 characters/)
  refused(() => s.films.saveShot(film.id, { ...ok, characters: [who(s.rex.id), who(s.rex.id, 2)] }), /Rex.*twice/)
  refused(() => s.films.saveShot(film.id, { ...ok, characters: [who(extra.id)] }), /cast/)
  refused(() => s.films.saveShot(film.id, { ...ok, characters: 'Rex' }), /characters/)
  refused(() => s.films.saveShot(film.id, { ...ok, characters: [{ ...who(s.rex.id), colour: 'red' }] }), /unknown field: colour/)
  refused(() => s.films.saveShot(film.id, { ...ok, characters: [null] }), /character/)
  refused(() => s.films.saveShot(film.id, { ...ok, closeUp: true, seconds: 4, characters: [{ castId: s.rex.id, startPose: 'a' }, { castId: s.tom.id, startPose: 'b' }] }), /close-up shows one character/)
  // A character a shot uses stays in the film's cast.
  refused(() => s.films.update(film.id, { ...FILM, castIds: [s.rex.id, s.bess.id] }), /A shot uses Tom/)
})

test('editing a shot bumps its revision and drops the pictures its change makes wrong', () => {
  const s = setup()
  const { film, garden, kitchen, shots } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  const shot = shots[2]!
  s.films.choose(film.id, candidate(s, film.id, 'shot', shot.id, 'start').pictureId)
  s.films.choose(film.id, candidate(s, film.id, 'shot', shot.id, 'end').pictureId)
  const chosen = s.films.get(film.id)!.shots[2]!
  assert.ok(chosen.startId && chosen.endId)
  const rex = chosen.characters[0]!
  const fields = { placeId: kitchen.id, characters: [rex], action: chosen.action, seconds: 6, joins: 'fade_long', closeUp: false }
  const same = s.films.saveShot(film.id, { ...fields, id: shot.id })
  assert.equal(same.revision, chosen.revision, 'saving it unchanged changes nothing')
  const actionOnly = s.films.saveShot(film.id, { ...fields, id: shot.id, action: 'runs to the door' })
  assert.equal(actionOnly.revision, chosen.revision + 1)
  assert.equal(actionOnly.startId, chosen.startId, 'a new action keeps the pictures')
  const newEnd = s.films.saveShot(film.id, { ...fields, id: shot.id, characters: [{ ...rex, endPose: 'lying by the door' }] })
  assert.equal(newEnd.startId, chosen.startId)
  assert.equal(newEnd.endId, null)
  const moved = s.films.saveShot(film.id, { ...fields, id: shot.id, placeId: garden.id })
  assert.equal(moved.startId, null, 'pictures of another place no longer fit')
})

test('a change to who is in a shot, or to any one character\'s pose, drops the pictures it makes wrong', () => {
  const s = setup()
  const film = s.films.create({ ...FILM, castIds: [s.rex.id, s.tom.id] })
  const garden = s.films.savePlace(film.id, { name: 'The garden', description: 'a small walled garden', keep: 'the red door stays shut' })
  const rex = { castId: s.rex.id, startPose: 'standing on the left', endPose: 'lying on the left' }
  const tom = { castId: s.tom.id, startPose: 'standing on the right', endPose: 'sitting on the right' }
  const fields = { placeId: garden.id, characters: [rex, tom], action: 'they settle', seconds: 6, joins: 'follows', closeUp: false }
  const shot = s.films.saveShot(film.id, fields)
  setStage(s.db, film.id, 'shots')
  const choose = () => {
    s.films.choose(film.id, candidate(s, film.id, 'shot', shot.id, 'start').pictureId)
    s.films.choose(film.id, candidate(s, film.id, 'shot', shot.id, 'end').pictureId)
    return s.films.get(film.id)!.shots[0]!
  }
  let chosen = choose()
  const tomEnds = s.films.saveShot(film.id, { ...fields, id: shot.id, characters: [rex, { ...tom, endPose: 'lying on the right' }] })
  assert.deepEqual([tomEnds.startId, tomEnds.endId], [chosen.startId, null], 'only the end picture shows the changed end')
  chosen = choose()
  const swapped = s.films.saveShot(film.id, { ...fields, id: shot.id, characters: [tom, rex] })
  assert.deepEqual([swapped.startId, swapped.endId], [null, null], 'a new order is a new chain of edits')
  chosen = choose()
  const alone = s.films.saveShot(film.id, { ...fields, id: shot.id, characters: [rex] })
  assert.deepEqual([alone.startId, alone.endId], [null, null])
  assert.ok(alone.revision > chosen.revision)
})

test('shots move up and down, and a deleted shot leaves the others in order', () => {
  const s = setup()
  const { film, shots } = filmWithPlan(s)
  s.films.moveShot(film.id, shots[2]!.id, 0)
  assert.deepEqual(s.films.get(film.id)!.shots.map((x) => x.id), [shots[2]!.id, shots[0]!.id, shots[1]!.id])
  assert.equal(s.films.deleteShot(film.id, shots[0]!.id), true)
  assert.deepEqual(s.films.get(film.id)!.shots.map((x) => [x.id, x.position]), [[shots[2]!.id, 0], [shots[1]!.id, 1]])
  assert.equal(s.films.deleteShot(film.id, shots[0]!.id), false)
})

test('a picture can only be added as a candidate for something of this film, in a role that fits', () => {
  const s = setup()
  const { film, garden, shots } = filmWithPlan(s)
  const other = filmWithPlan(s)
  const job = () => finishedPictureJob(s, film.id).jobId
  refused(() => s.films.addCandidate(film.id, { ownerKind: 'place', ownerId: other.garden.id, role: 'master', jobId: job(), seed: 1 }), /place/)
  refused(() => s.films.addCandidate(film.id, { ownerKind: 'place', ownerId: garden.id, role: 'start', jobId: job(), seed: 1 }), /role/)
  refused(() => s.films.addCandidate(film.id, { ownerKind: 'shot', ownerId: shots[0]!.id, role: 'master', jobId: job(), seed: 1 }), /role/)
  refused(() => s.films.addCandidate(film.id, { ownerKind: 'cast', ownerId: s.bess.id, role: 'face', jobId: job(), seed: 1 }), /cast/)
  refused(() => s.films.addCandidate(film.id, { ownerKind: 'place', ownerId: garden.id, role: 'master', jobId: finishedPictureJob(s, other.film.id).jobId, seed: 1 }), /job/)
  for (let i = 0; i < MAX_CANDIDATES; i++) s.films.addCandidate(film.id, { ownerKind: 'place', ownerId: garden.id, role: 'master', jobId: job(), seed: i })
  refused(() => s.films.addCandidate(film.id, { ownerKind: 'place', ownerId: garden.id, role: 'master', jobId: job(), seed: 1 }), new RegExp(`${MAX_CANDIDATES}`))
  assert.ok(s.films.addCandidate(film.id, { ownerKind: 'cast', ownerId: s.rex.id, role: 'turnaround', jobId: job(), seed: 1 }))
})

test('choosing a picture: only this film\'s finished candidates, and only once pictures are being made', () => {
  const s = setup()
  const { film, garden } = filmWithPlan(s)
  const other = filmWithPlan(s)
  const { pictureId, imageId } = candidate(s, film.id, 'place', garden.id, 'master')
  refused(() => s.films.choose(film.id, pictureId), /pictures/)
  setStage(s.db, film.id, 'places')
  setStage(s.db, other.film.id, 'places')
  refused(() => s.films.choose(other.film.id, pictureId), /no longer/)
  refused(() => s.films.choose(film.id, '../../x'), /no longer/)
  const waiting = finishedPictureJob(s, film.id, 'running')
  const notYet = s.films.addCandidate(film.id, { ownerKind: 'place', ownerId: garden.id, role: 'master', jobId: waiting.jobId, seed: 3 })
  refused(() => s.films.choose(film.id, notYet), /not finished/)
  s.films.choose(film.id, pictureId)
  assert.equal(s.films.get(film.id)!.places[0]!.masterId, imageId)
  assert.equal(s.films.get(film.id)!.pictures.find((p) => p.id === pictureId)!.imageId, imageId)
})

test('choosing a new master clears that place\'s later pictures, and only that place\'s', () => {
  const s = setup()
  const { film, garden, kitchen, shots } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  s.films.choose(film.id, candidate(s, film.id, 'place', garden.id, 'master').pictureId)
  s.films.choose(film.id, candidate(s, film.id, 'place', garden.id, 'empty').pictureId)
  for (const shot of shots) {
    s.films.choose(film.id, candidate(s, film.id, 'shot', shot.id, 'start').pictureId)
    s.films.choose(film.id, candidate(s, film.id, 'shot', shot.id, 'end').pictureId)
  }
  const before = s.films.get(film.id)!
  s.films.choose(film.id, candidate(s, film.id, 'place', garden.id, 'master').pictureId)
  const after = s.films.get(film.id)!
  assert.equal(after.places[0]!.emptyId, null)
  assert.deepEqual(after.shots.slice(0, 2).map((x) => [x.startId, x.endId]), [[null, null], [null, null]])
  assert.ok(after.shots[0]!.revision > before.shots[0]!.revision)
  assert.deepEqual(after.shots[2], before.shots[2], 'the kitchen shot keeps its pictures')
  assert.equal(after.places[1]!.id, kitchen.id)
})

test('a follows-on shot in the same place starts on the end picture chosen for the shot before it', () => {
  const s = setup()
  const { film, shots } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  const end = candidate(s, film.id, 'shot', shots[0]!.id, 'end')
  s.films.choose(film.id, end.pictureId)
  const after = s.films.get(film.id)!
  assert.equal(after.shots[1]!.startId, end.imageId, 'shot 2 follows on in the garden')
  assert.equal(after.shots[2]!.startId, null, 'shot 3 fades to the kitchen')
})

test('a shot follows on from the picture before only with the same characters in it', () => {
  const s = setup()
  const film = s.films.create({ ...FILM, castIds: [s.rex.id, s.tom.id] })
  const garden = s.films.savePlace(film.id, { name: 'The garden', description: 'a garden', keep: 'the door stays shut' })
  const who = (castId: string) => ({ castId, startPose: 'standing', endPose: 'sitting' })
  const shot = (characters: Array<ReturnType<typeof who>>) => s.films.saveShot(film.id, { placeId: garden.id, characters, action: 'they sit', seconds: 5, joins: 'follows', closeUp: false })
  const [both, sameTwo, onlyRex] = [shot([who(s.rex.id), who(s.tom.id)]), shot([who(s.tom.id), who(s.rex.id)]), shot([who(s.rex.id)])]
  setStage(s.db, film.id, 'shots')
  const first = candidate(s, film.id, 'shot', both.id, 'end')
  s.films.choose(film.id, first.pictureId)
  assert.equal(s.films.get(film.id)!.shots[1]!.startId, first.imageId, 'the same two, in any order')
  s.films.choose(film.id, candidate(s, film.id, 'shot', sameTwo.id, 'end').pictureId)
  assert.equal(s.films.get(film.id)!.shots[2]!.startId, null, 'Tom has left, so the picture before no longer fits')
  assert.equal(onlyRex.characters.length, 1)
})

test('choosing a character\'s turnaround or face drops the sheets it was on and remakes those shots', () => {
  const s = setup()
  const { film, garden, shots } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  s.db.prepare(`UPDATE film_places SET sheet_id = ? WHERE id = ?`).run(s.picture(), garden.id)
  const before = s.films.get(film.id)!
  s.films.choose(film.id, candidate(s, film.id, 'cast', s.rex.id, 'face').pictureId)
  const after = s.films.get(film.id)!
  assert.ok(after.cast[0]!.faceId)
  assert.equal(after.places[0]!.sheetId, null)
  assert.ok(after.shots.every((x, i) => x.revision > before.shots[i]!.revision))
  assert.equal(shots.length, 3)
})

test('a character\'s new face drops the sheets of places where it is in any shot, not only as the first character', () => {
  const s = setup()
  const film = s.films.create({ ...FILM, castIds: [s.rex.id, s.tom.id] })
  const garden = s.films.savePlace(film.id, { name: 'The garden', description: 'a garden', keep: 'the door stays shut' })
  const lane = s.films.savePlace(film.id, { name: 'The lane', description: 'a lane', keep: 'the gate stays open' })
  const who = (castId: string) => ({ castId, startPose: 'standing', endPose: 'sitting' })
  s.films.saveShot(film.id, { placeId: garden.id, characters: [who(s.rex.id), who(s.tom.id)], action: 'they sit', seconds: 5, joins: 'follows', closeUp: false })
  s.films.saveShot(film.id, { placeId: lane.id, characters: [who(s.rex.id)], action: 'he sits', seconds: 5, joins: 'fade_short', closeUp: false })
  setStage(s.db, film.id, 'shots')
  for (const place of [garden, lane]) s.db.prepare(`UPDATE film_places SET sheet_id = ? WHERE id = ?`).run(s.picture(), place.id)
  s.films.choose(film.id, candidate(s, film.id, 'cast', s.tom.id, 'face').pictureId)
  assert.deepEqual(s.films.get(film.id)!.places.map((p) => p.sheetId === null), [true, false])
})

test('each character\'s kind is one word, kept with the film\'s copy; for the pictures still to be made', () => {
  const s = setup()
  const { film, shots } = filmWithPlan(s)
  assert.equal(s.films.get(film.id)!.cast[0]!.kind, null)
  s.films.setKind(film.id, s.rex.id, ' Dog ')
  const after = s.films.get(film.id)!
  assert.equal(after.cast[0]!.kind, 'dog')
  // Only the pose edits use it, and a picture already made or chosen stays as it is; the shot's words don't use it.
  assert.deepEqual(after.shots.map((x) => x.revision), shots.map((x) => x.revision))
  refused(() => s.films.setKind(film.id, s.rex.id, 'border collie'), /one word/)
  refused(() => s.films.setKind(film.id, s.rex.id, 'd0g'), /one word/)
  refused(() => s.films.setKind(film.id, s.rex.id, 'x'.repeat(21)), /one word/)
  refused(() => s.films.setKind(film.id, s.rex.id, 7), /one word/)
  refused(() => s.films.setKind(film.id, s.bess.id, 'dog'), /cast/)
  s.films.setKind(film.id, s.rex.id, '')
  assert.equal(s.films.get(film.id)!.cast[0]!.kind, null, 'an empty box clears it')
  s.films.setKind(film.id, s.rex.id, 'dog')
  s.films.copyCastForPlan(film.id)
  assert.equal(s.films.get(film.id)!.cast[0]!.kind, 'dog', 'refreshing the cast at plan time keeps the kind')
  setStage(s.db, film.id, 'making')
  refused(() => s.films.setKind(film.id, s.rex.id, 'cat'), /Stop the film first/)
})

test('a chain of edits is one candidate: shown as being made until its last edit is done, never half made', () => {
  const s = setup()
  const { film, shots } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  const first = finishedPictureJob(s, film.id, 'done')
  const pictureId = s.films.addCandidate(film.id, { ownerKind: 'shot', ownerId: shots[0]!.id, role: 'start', jobId: first.jobId, seed: 5, steps: 3 })
  const shown = () => s.films.get(film.id)!.pictures.find((p) => p.id === pictureId)!
  assert.deepEqual([shown().status, shown().imageId, shown().step, shown().steps], ['cancelled', null, 1, 3], 'a chain that stopped after its first edit')
  refused(() => s.films.choose(film.id, pictureId), /not finished/)
  const second = finishedPictureJob(s, film.id, 'running')
  s.films.advanceCandidate(film.id, pictureId, second.jobId)
  assert.deepEqual([shown().status, shown().imageId, shown().step], ['running', null, 2])
  const third = finishedPictureJob(s, film.id, 'done')
  refused(() => s.films.advanceCandidate(film.id, pictureId, finishedPictureJob(s, filmWithPlan(s).film.id).jobId), /job/)
  s.films.advanceCandidate(film.id, pictureId, third.jobId)
  assert.deepEqual([shown().status, shown().imageId, shown().step], ['done', third.imageId, 3])
  refused(() => s.films.advanceCandidate(film.id, pictureId, finishedPictureJob(s, film.id).jobId), /last/)
  refused(() => s.films.addCandidate(film.id, { ownerKind: 'shot', ownerId: shots[0]!.id, role: 'start', jobId: first.jobId, seed: 5, steps: 4 }), /steps/)
  s.films.choose(film.id, pictureId)
  assert.equal(s.films.get(film.id)!.shots[0]!.startId, third.imageId)
})

test('Make film starts once: a second press, or a second film, is refused while one is being made', () => {
  const s = setup()
  const a = filmWithPlan(s)
  const b = filmWithPlan(s)
  for (const f of [a, b]) {
    setStage(s.db, f.film.id, 'shots')
    for (const shot of f.shots) {
      s.films.choose(f.film.id, candidate(s, f.film.id, 'shot', shot.id, 'start').pictureId)
      s.films.choose(f.film.id, candidate(s, f.film.id, 'shot', shot.id, 'end').pictureId)
    }
  }
  s.films.beginMaking(a.film.id)
  assert.equal(s.films.get(a.film.id)!.stage, 'making')
  refused(() => s.films.beginMaking(a.film.id), /already/)
  refused(() => s.films.beginMaking(b.film.id), /another film/)
})

test('Make film needs every shot\'s pictures chosen, and a plan with shots', () => {
  const s = setup()
  const { film, shots } = filmWithPlan(s)
  refused(() => s.films.beginMaking(film.id), /pictures/)
  setStage(s.db, film.id, 'shots')
  s.films.choose(film.id, candidate(s, film.id, 'shot', shots[0]!.id, 'start').pictureId)
  refused(() => s.films.beginMaking(film.id), /shot 1/)
  const empty = s.films.create({ ...FILM, castIds: [s.rex.id] })
  setStage(s.db, empty.id, 'shots')
  refused(() => s.films.beginMaking(empty.id), /no shots/)
})

test('while a film is being made, its edits, choices and delete are refused until it is stopped', async () => {
  const s = setup()
  const { film, garden, shots } = filmWithPlan(s)
  const pick = candidate(s, film.id, 'place', garden.id, 'master').pictureId
  setStage(s.db, film.id, 'making')
  const stopFirst = /Stop the film first/
  refused(() => s.films.update(film.id, { ...FILM, castIds: [s.rex.id] }), stopFirst)
  refused(() => s.films.savePlace(film.id, { id: garden.id, name: 'x', description: 'y', keep: 'z' }), stopFirst)
  refused(() => s.films.deletePlace(film.id, garden.id), stopFirst)
  refused(() => s.films.movePlace(film.id, garden.id, 1), stopFirst)
  refused(() => s.films.saveShot(film.id, { id: shots[0]!.id, placeId: garden.id, characters: [{ castId: s.rex.id, startPose: 'b', endPose: 'c' }], action: 'a', seconds: 5, joins: 'follows', closeUp: false }), stopFirst)
  refused(() => s.films.setKind(film.id, s.rex.id, 'dog'), stopFirst)
  refused(() => s.films.deleteShot(film.id, shots[0]!.id), stopFirst)
  refused(() => s.films.moveShot(film.id, shots[0]!.id, 1), stopFirst)
  refused(() => s.films.choose(film.id, pick), stopFirst)
  await assert.rejects(s.films.delete(film.id), (err: unknown) => err instanceof VideoRequestError && stopFirst.test(err.message))
  assert.ok(s.films.get(film.id))
})

test('deleting a film removes its own pictures and clips, but never the cast\'s picture or one a Video page job uses', async () => {
  const s = setup()
  const { film, garden, shots } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  const master = candidate(s, film.id, 'place', garden.id, 'master')
  s.films.choose(film.id, master.pictureId)
  const unchosen = candidate(s, film.id, 'place', garden.id, 'master')
  const start = candidate(s, film.id, 'shot', shots[0]!.id, 'start')
  s.films.choose(film.id, start.pictureId)
  // A Video page job made from the same stored picture (the person uploaded it there too).
  s.db.prepare(`INSERT INTO videos (id, recipe_id, params, status, created_at) VALUES (?, 'ltx25-i2v', ?, 'done', ?)`)
    .run(randomBytes(16).toString('hex'), JSON.stringify({ image: unchosen.imageId, prompt: 'x' }), Date.now())
  // A finished shot clip, and the joined film on the Video page.
  const clipId = randomBytes(16).toString('hex')
  s.db.prepare(`INSERT INTO videos (id, recipe_id, params, status, created_at, kind, film_id) VALUES (?, 'film-shot', '{}', 'done', ?, 'video', ?)`).run(clipId, Date.now(), film.id)
  writeFileSync(join(s.mediaDir, `${clipId}.mp4`), 'clip')
  const joinedId = randomBytes(16).toString('hex')
  s.db.prepare(`INSERT INTO videos (id, recipe_id, params, status, created_at) VALUES (?, 'storyboard-join', '{}', 'done', ?)`).run(joinedId, Date.now())
  writeFileSync(join(s.mediaDir, `${joinedId}.mp4`), 'film')
  s.db.prepare(`UPDATE films SET video_id = ? WHERE id = ?`).run(joinedId, film.id)
  const castCopy = s.films.get(film.id)!.cast[0]!.pictureId!

  assert.equal(await s.films.delete(film.id), true)
  assert.equal(s.jobs.hasImage(master.imageId), false)
  assert.equal(s.jobs.hasImage(start.imageId), false)
  assert.equal(s.jobs.hasImage(castCopy), false, 'the film\'s own copy of the cast picture goes')
  assert.equal(s.jobs.hasImage(s.rex.imageId!), true, 'the cast\'s picture stays')
  assert.equal(s.jobs.hasImage(unchosen.imageId), true, 'a Video page job still names it')
  assert.equal(existsSync(join(s.mediaDir, `${clipId}.mp4`)), false)
  assert.equal(existsSync(join(s.mediaDir, `${joinedId}.mp4`)), true, 'the joined film stays on the Video page')
  assert.equal(s.jobs.filePath(joinedId), join(s.mediaDir, `${joinedId}.mp4`))
  assert.equal(await s.films.delete(film.id), false)
})

test('deleting a film stops its picture jobs first, and refuses to touch files while one will not stop', async () => {
  const s = setup({ stopWaitMs: 100, stopPollMs: 10 })
  const { film, garden } = filmWithPlan(s)
  const stuck = finishedPictureJob(s, film.id, 'running')
  s.films.addCandidate(film.id, { ownerKind: 'place', ownerId: garden.id, role: 'master', jobId: stuck.jobId, seed: 1 })
  await assert.rejects(s.films.delete(film.id), (err: unknown) => err instanceof VideoRequestError && /still stopping/.test(err.message))
  assert.ok(s.films.get(film.id), 'nothing deleted')
  s.db.prepare(`UPDATE videos SET status = 'cancelled' WHERE id = ?`).run(stuck.jobId)
  assert.equal(await s.films.delete(film.id), true)
})

test('a picture is served only while a live film uses it; a clip only while its film is live', async () => {
  const s = setup()
  const { film, garden } = filmWithPlan(s)
  setStage(s.db, film.id, 'places')
  const master = candidate(s, film.id, 'place', garden.id, 'master')
  assert.equal(s.films.picturePath(master.imageId)?.path, s.jobs.findImage(master.imageId)!.path)
  assert.equal(s.films.picturePath(s.rex.imageId!), null, 'the cast\'s own picture is not a film picture')
  assert.equal(s.films.picturePath('../../x'), null)
  const clipId = randomBytes(16).toString('hex')
  s.db.prepare(`INSERT INTO videos (id, recipe_id, params, status, created_at, kind, film_id) VALUES (?, 'film-shot', '{}', 'done', ?, 'video', ?)`).run(clipId, Date.now(), film.id)
  writeFileSync(join(s.mediaDir, `${clipId}.mp4`), 'clip')
  assert.equal(s.films.clipPath(clipId), join(s.mediaDir, `${clipId}.mp4`))
  assert.equal(s.jobs.filePath(clipId), null, 'still out of the Video page\'s reach')
  await s.films.delete(film.id)
  assert.equal(s.films.picturePath(master.imageId), null)
  assert.equal(s.films.clipPath(clipId), null)
})

test('ffmpeg\'s temp files count toward the disk cap and are swept when Mission Control starts', () => {
  const s = setup()
  const before = s.jobs.diskUsage()
  const name = `tmp-${'a'.repeat(32)}`
  writeFileSync(join(s.mediaDir, `${name}.mp4`), Buffer.alloc(1000))
  writeFileSync(join(s.mediaDir, 'inputs', `${name}.png`), Buffer.alloc(500))
  writeFileSync(join(s.mediaDir, `${name}.filter`), 'x')
  writeFileSync(join(s.mediaDir, 'notes.txt'), 'not ours')
  assert.equal(s.jobs.diskUsage(), before + 1501)
  const restarted = new VideoJobs(s.db, s.mediaDir, () => ({ comfyUrl: 'http://127.0.0.1:1', freeAfterJob: false }), () => {})
  assert.equal(restarted.diskUsage(), before)
  assert.deepEqual(readdirSync(s.mediaDir).filter((n) => n.startsWith('tmp-')), [])
  assert.ok(existsSync(join(s.mediaDir, 'notes.txt')), 'only its own temp files go')
})

test('the video.film methods refuse with plain words, and get comes with signed links', async () => {
  const s = setup()
  registerVideoMethods(s.jobs, s.cast, () => 'http://127.0.0.1:1', s.films, null)
  // Delete goes through the director first, so a round still running for the film is stopped (review S5).
  const stopped: unknown[] = []
  registerFilmMakingMethods({ stop: async (id: unknown) => { stopped.push(id) } } as unknown as FilmDirector, s.films, {} as FilmHelper)
  const client = {} as ConnectedClient
  await assert.rejects(dispatch('video.film.create', { film: { ...FILM, castIds: [] } }, client), { code: 'INVALID_PARAMS' })
  const { film } = await dispatch('video.film.create', { film: { ...FILM, castIds: [s.rex.id] } }, client) as { film: { id: string } }
  const { place } = await dispatch('video.film.place.save', { filmId: film.id, place: { name: 'Garden', description: 'a garden', keep: 'the door stays shut' } }, client) as { place: { id: string } }
  await assert.rejects(dispatch('video.film.shot.save', { filmId: film.id, shot: { placeId: place.id } }, client), { code: 'INVALID_PARAMS' })
  await assert.rejects(dispatch('video.film.cast.kind', { filmId: film.id, castId: s.rex.id, kind: 'two words' }, client), { code: 'INVALID_PARAMS' })
  const kinded = await dispatch('video.film.cast.kind', { filmId: film.id, castId: s.rex.id, kind: 'dog' }, client) as { film: { cast: Array<{ kind: string }> } }
  assert.equal(kinded.film.cast[0]!.kind, 'dog')
  setStage(s.db, film.id, 'places')
  const master = candidate(s, film.id, 'place', place.id, 'master')
  await dispatch('video.film.pictures.choose', { filmId: film.id, pictureId: master.pictureId }, client)
  const got = await dispatch('video.film.get', { id: film.id }, client) as { film: { places: Array<{ masterId: string }> }; links: Record<string, string> }
  assert.equal(got.film.places[0]!.masterId, master.imageId)
  assert.match(got.links[master.imageId]!, new RegExp(`^/media/picture/${master.imageId}\\?e=\\d+&s=[0-9a-f]{64}$`))
  const listed = await dispatch('video.film.list', {}, client) as { films: Array<{ id: string; thumbLink: string | null }> }
  assert.equal(listed.films[0]!.id, film.id)
  assert.match(listed.films[0]!.thumbLink!, /^\/media\/picture\//)
  await assert.rejects(dispatch('video.film.get', { id: 'f'.repeat(32) }, client), { code: 'INVALID_PARAMS' })
  assert.deepEqual(await dispatch('video.film.delete', { id: film.id }, client), { deleted: true })
  assert.deepEqual(stopped, [film.id])
  const status = await dispatch('video.status', {}, client) as { ffmpeg: unknown }
  assert.equal(status.ffmpeg, null, 'video.status says when ffmpeg is missing')
  registerVideoMethods(s.jobs, s.cast, () => 'http://127.0.0.1:1', s.films, { ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe', version: '6.1.1-3ubuntu5' })
  const old = await dispatch('video.status', {}, client) as { ffmpeg: unknown }
  assert.deepEqual(old.ffmpeg, { path: '/usr/bin/ffmpeg', version: '6.1.1-3ubuntu5', old: true }, 'an old release is pointed out, not refused')
})

test('video.film.plan: the helper sees the film\'s own cast with its kinds, and its plan replaces an old one only when asked', async () => {
  const s = setup()
  const asked: unknown[] = []
  let answer: unknown = { confirm: '192.168.1.20' }
  const helper = { plan: async (film: unknown, opts: unknown) => { asked.push({ film, opts }); return answer } } as unknown as FilmHelper
  const director = {} as FilmDirector
  registerFilmMakingMethods(director, s.films, helper)
  const client = {} as ConnectedClient
  const film = s.films.create({ ...FILM, castIds: [s.rex.id, s.tom.id] })
  s.films.setKind(film.id, s.tom.id, 'man')

  assert.deepEqual(await dispatch('video.film.plan', { filmId: film.id }, client), { confirm: '192.168.1.20' }, 'a local-network server is asked about first')
  assert.deepEqual((asked[0] as { film: { cast: unknown } }).film.cast, [
    { name: 'Rex', wording: 'black and white border collie, white blaze', kind: null }, { name: 'Tom', wording: 'a man in his sixties with a flat tweed cap', kind: 'man' },
  ])
  answer = {
    warnings: ['a warning'],
    plan: {
      places: [{ name: 'The green', description: 'a village green', keep: 'the path stays dry' }],
      shots: [{ place: 0, characters: [{ name: 'Rex', startPose: 'on the left', endPose: 'lying on the left' }, { name: 'Tom', startPose: 'on the right', endPose: 'sitting on the right' }],
        action: 'they settle', seconds: 30, joins: 'follows', closeUp: false }],
      kinds: [{ name: 'Rex', kind: 'dog' }, { name: 'Tom', kind: 'woman' }],
    },
  }
  await assert.rejects(dispatch('video.film.plan', { filmId: film.id, allowAddress: '192.168.1.20' }, client), { code: 'INVALID_PARAMS' }, '30 seconds is too long for a shot')
  ;(answer as { plan: { shots: Array<{ seconds: number }> } }).plan.shots[0]!.seconds = 6
  const planned = await dispatch('video.film.plan', { filmId: film.id, allowAddress: '192.168.1.20' }, client) as { film: { shots: Array<{ characters: unknown[] }>; cast: Array<{ kind: string }> }; warnings: string[] }
  assert.equal((asked[2] as { opts: { allowAddress: string } }).opts.allowAddress, '192.168.1.20')
  assert.equal(planned.film.shots[0]!.characters.length, 2)
  assert.deepEqual(planned.film.cast.map((c) => c.kind), ['dog', 'man'], 'the person\'s own kind stays')
  assert.deepEqual(planned.warnings, ['a warning'])
  await assert.rejects(dispatch('video.film.plan', { filmId: film.id }, client), { code: 'INVALID_PARAMS', message: 'This film already has a plan. Replace it?' })
  await dispatch('video.film.plan', { filmId: film.id, replace: true }, client)
  assert.equal(s.films.get(film.id)!.shots.length, 1)
})

test('a picture made from older words, characters or master is out of date: refused when chosen, current again if the change is undone (review M1)', () => {
  const s = setup()
  const { film, garden, shots } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  s.films.choose(film.id, candidate(s, film.id, 'place', garden.id, 'master').pictureId)
  s.films.useMasterAsEmpty(film.id)
  const shot = shots[0]!
  const basis = () => slotBasis(s.films.get(film.id)!, 'shot', shot.id, 'start')
  const made = (b: string | null) => s.films.addCandidate(film.id, { ownerKind: 'shot', ownerId: shot.id, role: 'start', jobId: finishedPictureJob(s, film.id).jobId, seed: 1, basis: b ?? '' })
  const old = made(basis())
  const shown = () => s.films.get(film.id)!.pictures.find((p) => p.id === old)!
  assert.equal(shown().stale, false)
  const rex = shot.characters[0]!
  const fields = { id: shot.id, placeId: garden.id, characters: [rex], action: shot.action, seconds: shot.seconds, joins: shot.joins, closeUp: false }
  s.films.saveShot(film.id, { ...fields, characters: [{ ...rex, startPose: 'sitting by the gate' }] })
  assert.equal(shown().stale, true, 'the start pose changed')
  refused(() => s.films.choose(film.id, old), /made before/)
  refused(() => made('["old"]'), /changed/)
  s.films.saveShot(film.id, { ...fields, characters: [rex] })
  assert.equal(shown().stale, false, 'the same words again')
  s.films.saveShot(film.id, { ...fields, action: 'trots to the door' })
  assert.equal(shown().stale, false, 'a new action keeps the pictures')
  s.films.choose(film.id, candidate(s, film.id, 'place', garden.id, 'master').pictureId)
  assert.equal(shown().stale, true, 'a new master for the place')
  // A candidate with no basis (the store's own tests) is never out of date.
  assert.equal(s.films.get(film.id)!.pictures.filter((p) => p.ownerKind === 'place').every((p) => !p.stale), true)
})

test('a follows-on shot always starts on the end picture of the shot before (review S1)', () => {
  const s = setup()
  const { film, garden, shots } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  const end = candidate(s, film.id, 'shot', shots[0]!.id, 'end')
  s.films.choose(film.id, end.pictureId)
  const second = s.films.get(film.id)!.shots[1]!
  assert.equal(second.startId, end.imageId)
  const rex = second.characters[0]!
  const fields = { id: second.id, placeId: garden.id, characters: [rex], action: second.action, seconds: second.seconds, joins: 'follows', closeUp: false }
  s.films.saveShot(film.id, { ...fields, characters: [{ ...rex, startPose: 'a new start' }] })
  assert.equal(s.films.get(film.id)!.shots[1]!.startId, end.imageId, 'a new start pose still starts where shot 1 ends')
  // A shot that becomes follows-on drops its own start for the end picture before it.
  s.films.saveShot(film.id, { ...fields, joins: 'fade_short' })
  const own = candidate(s, film.id, 'shot', second.id, 'start')
  s.films.choose(film.id, own.pictureId)
  assert.equal(s.films.get(film.id)!.shots[1]!.startId, own.imageId)
  const before = s.films.get(film.id)!.shots[1]!.revision
  s.films.saveShot(film.id, { ...fields, joins: 'follows' })
  assert.equal(s.films.get(film.id)!.shots[1]!.startId, end.imageId)
  assert.ok(s.films.get(film.id)!.shots[1]!.revision > before)
})

test('moving shots keeps every follows-on shot on the end picture of the shot now before it', () => {
  const s = setup()
  const film = s.films.create({ ...FILM, castIds: [s.rex.id] })
  const garden = s.films.savePlace(film.id, { name: 'The garden', description: 'a garden', keep: 'the door stays shut' })
  const shot = () => s.films.saveShot(film.id, { placeId: garden.id, characters: [{ castId: s.rex.id, startPose: 'standing', endPose: 'sitting' }], action: 'sits', seconds: 5, joins: 'follows', closeUp: false })
  const [p, q, r] = [shot(), shot(), shot()]
  setStage(s.db, film.id, 'shots')
  const ends = [p, q, r].map((x) => { const c = candidate(s, film.id, 'shot', x.id, 'end'); s.films.choose(film.id, c.pictureId); return c.imageId })
  s.films.moveShot(film.id, r.id, 0)
  const moved = s.films.get(film.id)!.shots
  assert.deepEqual(moved.map((x) => x.id), [r.id, p.id, q.id])
  assert.deepEqual(moved.map((x) => x.startId), [null, ends[2], ends[0]], 'R gives back the start it borrowed from Q; P now starts on the end of R, Q on the end of P')
  s.films.deleteShot(film.id, p.id)
  assert.equal(s.films.get(film.id)!.shots[1]!.startId, ends[2], 'Q now follows R')
})

test('a new reference sheet for a place remakes the shots there; the sheet remembers what it was made from (review S2)', () => {
  const s = setup()
  const { film, garden, shots } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  s.films.setSheet(film.id, garden.id, s.picture(), 'basis one')
  const first = s.films.get(film.id)!
  assert.equal(first.places[0]!.sheetBasis, 'basis one')
  s.films.setSheet(film.id, garden.id, s.picture(), 'basis two')
  const second = s.films.get(film.id)!
  assert.equal(second.places[0]!.sheetBasis, 'basis two')
  assert.deepEqual(second.shots.map((x, i) => x.revision - first.shots[i]!.revision), [1, 1, 0], 'only the garden\'s shots')
  assert.equal(shots.length, 3)
})

test('a shot that stops following on gives back the start picture it borrowed (second review N-S1)', () => {
  const s = setup()
  const { film, garden, shots } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  const end = candidate(s, film.id, 'shot', shots[0]!.id, 'end')
  s.films.choose(film.id, end.pictureId)
  const second = s.films.get(film.id)!.shots[1]!
  assert.equal(second.startId, end.imageId)
  const fields = { id: second.id, placeId: garden.id, characters: second.characters, action: second.action, seconds: second.seconds, closeUp: false }
  s.films.saveShot(film.id, { ...fields, joins: 'fade_short' })
  assert.equal(s.films.get(film.id)!.shots[1]!.startId, null, 'it needs a start of its own now')
  // Its own chosen start stays when it no longer follows on.
  const own = candidate(s, film.id, 'shot', second.id, 'start')
  s.films.choose(film.id, own.pictureId)
  s.films.moveShot(film.id, second.id, 0)
  assert.equal(s.films.get(film.id)!.shots[0]!.startId, own.imageId)
})

test('out-of-date pictures don\'t count towards the twelve, so a slot never runs out (second review N-S2)', () => {
  const s = setup()
  const { film, garden, shots } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  s.films.choose(film.id, candidate(s, film.id, 'place', garden.id, 'master').pictureId)
  s.films.useMasterAsEmpty(film.id)
  const shot = shots[0]!
  const made = () => s.films.addCandidate(film.id, { ownerKind: 'shot', ownerId: shot.id, role: 'start', jobId: finishedPictureJob(s, film.id).jobId, seed: 1,
    basis: slotBasis(s.films.get(film.id)!, 'shot', shot.id, 'start')! })
  for (let i = 0; i < MAX_CANDIDATES; i++) made()
  refused(() => made(), /at most 12/)
  const rex = shot.characters[0]!
  s.films.saveShot(film.id, { id: shot.id, placeId: garden.id, characters: [{ ...rex, startPose: 'a new start' }], action: shot.action, seconds: shot.seconds, joins: shot.joins, closeUp: false })
  assert.ok(made(), 'the twelve old ones are out of date and no longer count')
  // A failed picture doesn't count either.
  const failed = finishedPictureJob(s, film.id, 'failed')
  s.films.addCandidate(film.id, { ownerKind: 'shot', ownerId: shot.id, role: 'start', jobId: failed.jobId, seed: 1, basis: slotBasis(s.films.get(film.id)!, 'shot', shot.id, 'start')! })
  for (let i = 0; i < MAX_CANDIDATES - 1; i++) made()
  refused(() => made(), /at most 12/)
})

test('a place\'s "what stays the same" words are part of what its pose pictures are made from (second review N-S3)', () => {
  const s = setup()
  const { film, garden, shots } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  const before = slotBasis(s.films.get(film.id)!, 'shot', shots[0]!.id, 'start')
  s.films.savePlace(film.id, { id: garden.id, name: 'The garden', description: 'a small walled garden', keep: 'the red door stays open' })
  assert.notEqual(slotBasis(s.films.get(film.id)!, 'shot', shots[0]!.id, 'start'), before)
})

test('a pose\'s pictures are made from its characters\' pictures too: a new picture puts them out of date (hand test T10)', () => {
  const s = setup()
  const { film, shots } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  const before = slotBasis(s.films.get(film.id)!, 'shot', shots[0]!.id, 'start')
  const castId = shots[0]!.characters[0]!.castId
  s.db.prepare(`UPDATE film_cast SET picture_id = ? WHERE film_id = ? AND cast_id = ?`).run('f'.repeat(32), film.id, castId)
  assert.notEqual(slotBasis(s.films.get(film.id)!, 'shot', shots[0]!.id, 'start'), before)
})

test('a deleted film takes its characters\' cut-out pictures with it, even one no job was made from (hand test T10)', async () => {
  const s = setup()
  const { film } = filmWithPlan(s)
  const castPicture = s.films.get(film.id)!.cast[0]!.pictureId!
  const cut = referenceIdFor(castPicture)
  const kept = new ImageInputs(join(s.mediaDir, 'inputs')).saveBuffer(rgbPng(64, 64, Buffer.alloc(64 * 64 * 3, 200)), cut)
  assert.ok(typeof kept !== 'string' && s.jobs.findImage(cut), 'the cut-out is kept where the film\'s pictures are')
  await s.films.delete(film.id)
  assert.equal(s.jobs.findImage(cut), null)
})

test('a sheet replaced or dropped takes its file with it, unless something else still uses it (second review nit 1)', () => {
  const s = setup()
  const { film, garden } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  const first = s.picture()
  s.films.setSheet(film.id, garden.id, first, 'one')
  const second = s.picture()
  s.films.setSheet(film.id, garden.id, second, 'two')
  assert.equal(s.jobs.hasImage(first), false)
  s.films.choose(film.id, candidate(s, film.id, 'cast', s.rex.id, 'face').pictureId)
  assert.equal(s.films.get(film.id)!.places[0]!.sheetId, null)
  assert.equal(s.jobs.hasImage(second), false)
})

test('a place\'s keep words changed after pictures are chosen: its shots\' pictures are made again; other words remake only the clips (third review N3-S1)', () => {
  const s = setup()
  const { film, garden, kitchen, shots } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  for (const shot of shots) {
    s.films.choose(film.id, candidate(s, film.id, 'shot', shot.id, 'start').pictureId)
    if (!shot.closeUp) s.films.choose(film.id, candidate(s, film.id, 'shot', shot.id, 'end').pictureId)
  }
  const before = s.films.get(film.id)!
  s.films.savePlace(film.id, { id: garden.id, name: 'The garden', description: 'a small walled garden', keep: 'the red door stays open' })
  const kept = s.films.get(film.id)!
  assert.deepEqual(kept.shots.slice(0, 2).map((x) => [x.startId, x.endId]), [[null, null], [null, null]], 'the garden\'s pictures were made with the old keep words')
  assert.deepEqual(kept.shots[2]!.startId, before.shots[2]!.startId, 'the kitchen keeps its pictures')
  assert.ok(kept.shots[0]!.revision > before.shots[0]!.revision)
  // The kitchen's description goes into its shots' words, not its pictures: the clips are remade, the pictures stay.
  s.films.savePlace(film.id, { id: kitchen.id, name: 'The kitchen', description: 'a farmhouse kitchen at night', keep: 'the table stays by the window', prop: 'a red ball' })
  const described = s.films.get(film.id)!
  assert.equal(described.shots[2]!.startId, before.shots[2]!.startId)
  assert.ok(described.shots[2]!.revision > kept.shots[2]!.revision)
  // Saving a place unchanged changes nothing.
  s.films.savePlace(film.id, { id: kitchen.id, name: 'The kitchen', description: 'a farmhouse kitchen at night', keep: 'the table stays by the window', prop: 'a red ball' })
  assert.equal(s.films.get(film.id)!.shots[2]!.revision, described.shots[2]!.revision)
})

test('deleting a film also removes a replaced sheet that only its old shot jobs named (third review nit)', async () => {
  const s = setup()
  const { film, garden } = filmWithPlan(s)
  setStage(s.db, film.id, 'shots')
  const old = s.picture()
  s.films.setSheet(film.id, garden.id, old, 'one')
  const clipId = randomBytes(16).toString('hex')
  s.db.prepare(`INSERT INTO videos (id, recipe_id, params, status, created_at, kind, film_id) VALUES (?, 'film-shot', ?, 'done', ?, 'video', ?)`)
    .run(clipId, JSON.stringify({ prompt: 'x', sheet: old, start: s.picture() }), Date.now(), film.id)
  s.films.setSheet(film.id, garden.id, s.picture(), 'two')
  assert.equal(s.jobs.hasImage(old), true, 'the old clip job still names it')
  await s.films.delete(film.id)
  assert.equal(s.jobs.hasImage(old), false)
  assert.equal(s.jobs.hasImage(s.rex.imageId!), true)
})

test('no AI tool can reach the film modules (harness fit, storyboard spec 16)', () => {
  const toolsDir = join(__dirname, '..', 'src', 'tools')
  const offenders = readdirSync(toolsDir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => /video\/(films|film-[a-z-]+)(\.js)?['"]/.test(readFileSync(join(toolsDir, name), 'utf8')))
  assert.deepEqual(offenders, [])
})
