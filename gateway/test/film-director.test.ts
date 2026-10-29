// Run with: npm test
// The Storyboard's director (storyboard spec 9 and 15), against a fake queue, a fake ffmpeg and a fake ComfyUI:
// pictures and shots go to the graphics card one job at a time, a film survives a restart and carries on, Stop stops
// everything, a failed shot stops the film there, and Redo remakes one shot and joins the film again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { openDatabase } from '../src/store/db.js'
import { VideoCast } from '../src/video/cast.js'
import { VideoJobs, type VideoEvent } from '../src/video/jobs.js'
import { FilmStore, type FilmMedia } from '../src/video/films.js'
import { FilmDirector, type DirectorQueue, type FilmEvent } from '../src/video/film-director.js'
import { FILM_EDIT_FAST, FILM_EDIT_FINE } from '../src/video/film-recipes.js'
import type { JoinPlan, SheetPictures } from '../src/video/ffmpeg.js'
import type { Recipe } from '../src/video/recipes.js'

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const PNG = (() => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1280, 0); ihdr.writeUInt32BE(704, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', Buffer.from('pixels')), pngChunk('IEND', Buffer.alloc(0))])
})()

// The shot recipe waits for hand test T1; any recipe with its inputs stands in for it.
const SHOT: Recipe = { ...FILM_EDIT_FAST, id: 'film-shot', output: 'video', params: {
  prompt: { kind: 'text', maxLength: 4000, required: true }, sheet: { kind: 'image', required: true }, start: { kind: 'image', required: true },
  end: { kind: 'image' }, frames: { kind: 'int', min: 97, max: 193, default: 97 }, seed: { kind: 'int', min: 0, max: 2 ** 48 },
} }

interface Job { id: string; recipeId: string; params: Record<string, unknown>; filmId: string; status: string }

function setup(opts: { shot?: Recipe | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-director-'))
  const db = openDatabase(join(dir, 'test.sqlite'))
  const mediaDir = join(dir, 'media')
  const jobs = new VideoJobs(db, mediaDir, () => ({ comfyUrl: 'http://127.0.0.1:1', freeAfterJob: false }), () => {})
  const cast = new VideoCast(db, (id) => jobs.hasImage(id))
  // The film store stops a film's jobs through the same (fake) queue the director gives them to.
  const media: FilmMedia = {
    findImage: (id) => jobs.findImage(id), copyImage: (id) => jobs.copyImage(id), removeImage: (id) => jobs.removeImage(id),
    pictureOf: (id) => jobs.pictureOf(id), deleteFilmRows: (id) => jobs.deleteFilmRows(id), filmFilePath: (id, filmId) => jobs.filmFilePath(id, filmId),
    cancelFilmJob: (id, filmId) => queue.cancelFilmJob(id, filmId),
  }
  const films = new FilmStore(db, media)
  const picture = () => jobs.savePicture(PNG)
  const submitted: Job[] = []
  const events: FilmEvent[] = []
  const joins: JoinPlan[] = []
  const sheets: SheetPictures[] = []
  const calls = { interruptAndFree: 0, maxActive: 0 }
  let diskUsage: number | null = null
  let director: FilmDirector
  const active = () => submitted.filter((j) => j.status === 'queued' || j.status === 'running').length

  const queue: DirectorQueue = {
    submitFilm(recipe, params, filmId) {
      const id = randomBytes(16).toString('hex')
      db.prepare(`INSERT INTO videos (id, recipe_id, params, status, created_at, kind, film_id) VALUES (?, ?, ?, 'queued', ?, ?, ?)`)
        .run(id, recipe.id, JSON.stringify(params), Date.now(), recipe.output, filmId)
      submitted.push({ id, recipeId: recipe.id, params: params as Record<string, unknown>, filmId, status: 'queued' })
      calls.maxActive = Math.max(calls.maxActive, active())
      return id
    },
    cancelFilmJob(id, filmId) {
      const job = submitted.find((j) => j.id === id && j.filmId === filmId)
      if (!job || (job.status !== 'queued' && job.status !== 'running')) return false
      setImmediate(() => finish(job, 'cancelled'))
      return true
    },
    statusOf: (id) => jobs.statusOf(id),
    savePicture: (buf) => jobs.savePicture(buf),
    addJoinedFilm: (id, bytes) => jobs.addJoinedFilm(id, bytes),
    removeFilmClip: (id, filmId) => jobs.removeFilmClip(id, filmId),
    removeUnkept: (id) => jobs.removeUnkept(id),
    diskUsage: () => diskUsage ?? jobs.diskUsage(),
    diskLimit: jobs.diskLimit,
    interruptAndFree: async () => { calls.interruptAndFree++ },
  }

  function finish(job: Job, status: 'done' | 'failed' | 'cancelled', error: string | null = null): void {
    job.status = status
    let imageId: string | null = null
    if (status === 'done' && job.recipeId === 'film-shot') writeFileSync(join(mediaDir, `${job.id}.mp4`), 'clip')
    else if (status === 'done') imageId = picture()
    db.prepare(`UPDATE videos SET status = ?, error = ?, image_id = ? WHERE id = ?`).run(status, error, imageId, job.id)
    director.onVideoEvent({ id: job.id, status, ...(error ? { error } : {}) } as VideoEvent)
  }

  const make = (shot: Recipe | null) => new FilmDirector({
    films, queue, mediaDir, emit: (e) => events.push(e),
    recipes: { fast: FILM_EDIT_FAST, fine: FILM_EDIT_FINE, shot },
    ffmpeg: {
      tools: () => ({ ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe', version: '8.0.1' }),
      join: async (_tools, dirOut, plan, outId) => { joins.push(plan); writeFileSync(join(dirOut, `${outId}.mp4`), 'film'); return { frames: 1, bytes: 4 } },
      sheet: async (_tools, _inputs, pictures) => { sheets.push(pictures); return PNG },
    },
  })
  director = make(opts.shot === undefined ? SHOT : opts.shot)

  // Waits until the director has a job waiting, then finishes it.
  async function next(status: 'done' | 'failed' = 'done', error: string | null = null): Promise<Job> {
    for (let i = 0; i < 500; i++) {
      const job = submitted.find((j) => j.status === 'queued')
      if (job) {
        await new Promise((r) => setImmediate(r))
        finish(job, status, error)
        return job
      }
      await new Promise((r) => setTimeout(r, 2))
    }
    throw new Error('the director queued nothing')
  }

  // Finishes every job the director queues until it has nothing more to do.
  async function finishAll(): Promise<Job[]> {
    const done: Job[] = []
    while (true) {
      const job = submitted.find((j) => j.status === 'queued')
      if (job) {
        await new Promise((r) => setImmediate(r))
        finish(job, 'done')
        done.push(job)
        continue
      }
      if (!director.busy) return done
      await new Promise((r) => setTimeout(r, 2))
    }
  }

  const rex = cast.save({ name: 'Rex', wording: 'black and white border collie', imageId: jobs.uploadImage(PNG.toString('base64')).id })
  return { db, mediaDir, jobs, cast, films, picture, submitted, events, joins, sheets, calls, rex, next, finishAll, active,
    get director() { return director }, restart: () => { director = make(opts.shot === undefined ? SHOT : opts.shot); return director },
    setDiskUsage: (bytes: number | null) => { diskUsage = bytes } }
}

type Setup = ReturnType<typeof setup>

function planned(s: Setup) {
  const film = s.films.create({ title: 'The red door', story: 'Rex goes through the red door.', seconds: 30, look: 'realistic', sound: true, castIds: [s.rex.id] })
  const garden = s.films.savePlace(film.id, { name: 'The garden', description: 'a small walled garden', keep: 'the red door stays shut' })
  const kitchen = s.films.savePlace(film.id, { name: 'The kitchen', description: 'a farmhouse kitchen', keep: 'the table stays by the window' })
  const shot = (placeId: string, joins: string, extra: Record<string, unknown> = {}) => s.films.saveShot(film.id, {
    placeId, castId: s.rex.id, action: 'walks to the door', startPose: 'standing by the wall', endPose: 'standing at the door', seconds: 6, joins, closeUp: false, ...extra,
  })
  const shots = [shot(garden.id, 'fade_short'), shot(garden.id, 'follows'), shot(kitchen.id, 'fade_long', { closeUp: true, seconds: 4, endPose: '' })]
  return { film, garden, kitchen, shots }
}

const pick = (s: Setup, filmId: string, ownerId: string, role: string) => {
  const candidate = s.films.get(filmId)!.pictures.find((p) => p.ownerId === ownerId && p.role === role && p.imageId)
  assert.ok(candidate, `a finished ${role} candidate for ${ownerId}`)
  s.films.choose(filmId, candidate.id)
}

// The whole user path up to Make film: both picture rounds, every slot chosen.
async function readyToMake(s: Setup) {
  const p = planned(s)
  await s.director.makePictures(p.film.id, { round: 'places' })
  await s.finishAll()
  pick(s, p.film.id, s.rex.id, 'turnaround')
  pick(s, p.film.id, s.rex.id, 'face')
  pick(s, p.film.id, p.garden.id, 'master')
  await s.director.makePictures(p.film.id, { round: 'places' })
  await s.finishAll()
  pick(s, p.film.id, p.kitchen.id, 'master')
  await s.director.makePictures(p.film.id, { round: 'shots' })
  await s.finishAll()
  pick(s, p.film.id, p.shots[0]!.id, 'start')
  pick(s, p.film.id, p.shots[0]!.id, 'end')
  pick(s, p.film.id, p.shots[1]!.id, 'end')
  pick(s, p.film.id, p.shots[2]!.id, 'start')
  return p
}

test('round one: the character\'s turnaround and face, then two masters for the first place, one job at a time', async () => {
  const s = setup()
  const { film, garden, kitchen } = planned(s)
  await s.director.makePictures(film.id, { round: 'places' })
  const jobs = await s.finishAll()
  assert.deepEqual(jobs.map((j) => j.recipeId), ['film-edit-fine', 'film-edit-fine', 'film-edit-fine', 'film-edit-fine', 'film-edit-fast', 'film-edit-fast'])
  assert.equal(s.calls.maxActive, 1, 'never two jobs waiting at once')
  const castPicture = s.films.get(film.id)!.cast[0]!.pictureId
  assert.ok(jobs.every((j) => j.params['image1'] === castPicture))
  assert.match(String(jobs[0]!.params['prompt']), /three times side by side/)
  assert.match(String(jobs[4]!.params['prompt']), /^Show a new place: a small walled garden/)
  const pictures = s.films.get(film.id)!.pictures
  assert.deepEqual(pictures.map((p) => [p.role, p.ownerId]), [
    ['turnaround', s.rex.id], ['turnaround', s.rex.id], ['face', s.rex.id], ['face', s.rex.id], ['master', garden.id], ['master', garden.id],
  ])
  assert.equal(s.films.get(film.id)!.stage, 'places')
  assert.ok(pictures.every((p) => p.imageId && p.checkState === 'off'), 'no picture check until it can see (spec 7.2)')

  pick(s, film.id, garden.id, 'master')
  await s.director.makePictures(film.id, { round: 'places' })
  const later = await s.finishAll()
  assert.deepEqual(later.map((j) => j.recipeId), ['film-edit-fast', 'film-edit-fast'], 'only the later place\'s masters; nothing made twice')
  assert.equal(later[0]!.params['image1'], s.films.get(film.id)!.places[0]!.masterId, 'later places are edits of the first master')
  assert.match(String(later[0]!.params['prompt']), /in the same world.*a farmhouse kitchen/)
  assert.ok(s.films.get(film.id)!.pictures.filter((p) => p.ownerId === kitchen.id).length === 2)
})

test('round two: start and end poses into each place, a follows-on shot only its end, a close-up two fine starts', async () => {
  const s = setup()
  const { film, garden, kitchen, shots } = planned(s)
  await assert.rejects(s.director.makePictures(film.id, { round: 'shots' }), /master/)
  await s.director.makePictures(film.id, { round: 'places' })
  await s.finishAll()
  pick(s, film.id, garden.id, 'master')
  await s.director.makePictures(film.id, { round: 'places' })
  await s.finishAll()
  pick(s, film.id, kitchen.id, 'master')
  await s.director.makePictures(film.id, { round: 'shots' })
  const jobs = await s.finishAll()
  const roles = s.films.get(film.id)!.pictures.filter((p) => p.ownerKind === 'shot').map((p) => [shots.findIndex((x) => x.id === p.ownerId) + 1, p.role])
  assert.deepEqual(roles, [[1, 'start'], [1, 'start'], [1, 'end'], [1, 'end'], [2, 'end'], [2, 'end'], [3, 'start'], [3, 'start']])
  assert.deepEqual(jobs.map((j) => j.recipeId), ['film-edit-fast', 'film-edit-fast', 'film-edit-fast', 'film-edit-fast', 'film-edit-fast', 'film-edit-fast', 'film-edit-fine', 'film-edit-fine'])
  const place = s.films.get(film.id)!.places
  assert.equal(jobs[0]!.params['image1'], place[0]!.emptyId, 'poses are added into the place on its own')
  assert.equal(jobs[0]!.params['image2'], s.films.get(film.id)!.cast[0]!.pictureId, 'picture 2 shows what Rex looks like')
  assert.match(String(jobs[0]!.params['prompt']), /there is exactly one Rex in the whole picture/)
  assert.match(String(jobs[6]!.params['prompt']), /^A close-up at Rex's eye level/)
  assert.equal(jobs[6]!.params['image1'], place[1]!.emptyId)
  assert.equal(s.films.get(film.id)!.stage, 'shots')
})

test('Make more adds two pictures to one slot, at most twelve', async () => {
  const s = setup()
  const { film, garden } = planned(s)
  await s.director.makePictures(film.id, { round: 'places' })
  await s.finishAll()
  await s.director.makePictures(film.id, { ownerId: garden.id, role: 'master' })
  assert.equal((await s.finishAll()).length, 2)
  for (let i = 0; i < 4; i++) { await s.director.makePictures(film.id, { ownerId: garden.id, role: 'master' }); await s.finishAll() }
  await assert.rejects(s.director.makePictures(film.id, { ownerId: garden.id, role: 'master' }), /12/)
  await assert.rejects(s.director.makePictures(film.id, { ownerId: garden.id, role: 'start' }), /role/)
})

test('Make film: a sheet per place, each shot in order with its pictures, then one join with the right cuts and fades', async () => {
  const s = setup()
  const p = await readyToMake(s)
  s.director.make(p.film.id)
  assert.equal(s.films.get(p.film.id)!.stage, 'making')
  const shotJobs = await s.finishAll()
  const film = s.films.get(p.film.id)!
  assert.equal(film.stage, 'done')
  assert.deepEqual(shotJobs.map((j) => j.recipeId), ['film-shot', 'film-shot', 'film-shot'])
  assert.equal(s.sheets.length, 2, 'one sheet per place')
  assert.equal(s.sheets[0]!.placeWithCast, film.shots[0]!.startId)
  assert.deepEqual(shotJobs.map((j) => [j.params['sheet'], j.params['start'], j.params['end'], j.params['frames'], j.params['seed']]), [
    [film.places[0]!.sheetId, film.shots[0]!.startId, film.shots[0]!.endId, 145, film.shots[0]!.seed],
    [film.places[0]!.sheetId, film.shots[1]!.startId, film.shots[1]!.endId, 145, film.shots[1]!.seed],
    [film.places[1]!.sheetId, film.shots[2]!.startId, undefined, 97, film.shots[2]!.seed],
  ])
  assert.match(String(shotJobs[0]!.params['prompt']), /### Reference Sheet Description .* ### Target Description A cinematic, photorealistic/)
  assert.deepEqual(film.shots.map((x) => [x.clipId, x.clipRev]), shotJobs.map((j, i) => [j.id, film.shots[i]!.revision]))
  assert.equal(s.joins.length, 1)
  assert.deepEqual(s.joins[0], {
    sound: true, fadeOutFrames: 24, clips: [
      { videoId: shotJobs[0]!.id, inFrame: 0, outFrame: 145, transition: 'cut', transitionFrames: 0 },
      { videoId: shotJobs[1]!.id, inFrame: 1, outFrame: 145, transition: 'cut', transitionFrames: 0 },
      { videoId: shotJobs[2]!.id, inFrame: 0, outFrame: 97, transition: 'crossfade', transitionFrames: 24 },
    ],
  })
  const joined = s.jobs.list().find((v) => v.id === film.videoId)!
  assert.deepEqual([joined.recipeId, joined.params, joined.status], ['storyboard-join', {}, 'done'], 'the film is a normal Video page video, with no story words')
  assert.ok(s.jobs.filePath(film.videoId!))
  assert.ok(s.events.some((e) => e.filmId === p.film.id && e.stage === 'making' && e.shotId === film.shots[0]!.id))
  assert.equal(s.calls.maxActive, 1)
})

test('Make film is refused without ffmpeg-ready pictures: the character\'s sheet panels and every place\'s master', async () => {
  const s = setup()
  const p = await readyToMake(s)
  s.db.prepare(`UPDATE film_cast SET face_id = NULL WHERE film_id = ?`).run(p.film.id)
  assert.throws(() => s.director.make(p.film.id), /face/)
  assert.equal(s.films.get(p.film.id)!.stage, 'shots', 'nothing started')
})

test('without the shot recipe (hand test T1 still to come) Make film says so', async () => {
  const s = setup({ shot: null })
  const p = await readyToMake(s)
  assert.throws(() => s.director.make(p.film.id), /isn't ready/)
})

test('a failed shot stops the film at that shot with the queue\'s own words, and nothing is joined', async () => {
  const s = setup()
  const p = await readyToMake(s)
  s.director.make(p.film.id)
  await s.next()
  await s.next('failed', 'ComfyUI stopped with an error in KSampler: out of memory')
  await s.director.idle()
  const film = s.films.get(p.film.id)!
  assert.equal(film.stage, 'stopped')
  assert.equal(film.problem, 'Shot 2 could not be made: ComfyUI stopped with an error in KSampler: out of memory')
  assert.equal(s.joins.length, 0)
  assert.ok(film.shots[0]!.clipId && !film.shots[1]!.clipId)
})

test('Stop cancels the running job, nothing more is queued, and the film carries on from there next time', async () => {
  const s = setup()
  const p = await readyToMake(s)
  s.director.make(p.film.id)
  await s.next()
  while (s.active() === 0) await new Promise((r) => setTimeout(r, 2))
  await s.director.stop(p.film.id)
  assert.equal(s.films.get(p.film.id)!.stage, 'stopped')
  assert.equal(s.films.get(p.film.id)!.problem, null)
  assert.equal(s.submitted.at(-1)!.status, 'cancelled')
  const count = s.submitted.length
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(s.submitted.length, count)
  s.director.make(p.film.id)
  const rest = await s.finishAll()
  assert.equal(rest.length, 2, 'shot 1 is kept; shots 2 and 3 are made')
  assert.equal(s.films.get(p.film.id)!.stage, 'done')
})

test('after a restart a film being made is stopped with plain words, ComfyUI is cleared, and Make film carries on', async () => {
  const s = setup()
  const p = await readyToMake(s)
  s.director.make(p.film.id)
  await s.next()
  while (s.active() === 0) await new Promise((r) => setTimeout(r, 2))
  // Mission Control stops here, with shot 1 made: the queue fails its running job, and a new director starts.
  s.db.prepare(`UPDATE videos SET status = 'failed' WHERE status IN ('queued', 'running')`).run()
  for (const job of s.submitted) if (job.status === 'queued') job.status = 'failed'
  const director = s.restart()
  await director.start()
  const film = s.films.get(p.film.id)!
  assert.equal(film.stage, 'stopped')
  assert.equal(film.problem, 'Mission Control restarted while this was being made. Press Make film to carry on.')
  assert.equal(s.calls.interruptAndFree, 1)
  director.make(p.film.id)
  assert.equal((await s.finishAll()).length, 2)
})

test('Redo remakes only that shot, with a new seed if asked, joins again and tidies the old clip and film', async () => {
  const s = setup()
  const p = await readyToMake(s)
  s.director.make(p.film.id)
  await s.finishAll()
  const before = s.films.get(p.film.id)!
  s.director.redo(p.film.id, before.shots[1]!.id, true)
  const redone = await s.finishAll()
  const after = s.films.get(p.film.id)!
  assert.equal(redone.length, 1)
  assert.equal(redone[0]!.params['start'], before.shots[1]!.startId)
  assert.notEqual(after.shots[1]!.seed, before.shots[1]!.seed)
  assert.equal(redone[0]!.params['seed'], after.shots[1]!.seed)
  assert.equal(s.joins.length, 2)
  assert.equal(existsSync(join(s.mediaDir, `${before.shots[1]!.clipId}.mp4`)), false, 'the old clip goes once the new one is in')
  assert.equal(after.shots[0]!.clipId, before.shots[0]!.clipId)
  assert.notEqual(after.videoId, before.videoId)
  assert.equal(s.jobs.filePath(before.videoId!), null, 'the previous film goes when the new one is ready')

  s.jobs.keep(after.videoId!, true)
  s.director.redo(p.film.id, after.shots[0]!.id, false)
  await s.finishAll()
  assert.ok(s.jobs.filePath(after.videoId!), 'a starred film stays')
})

test('a clip finished for an older revision of its shot is thrown away', () => {
  const s = setup()
  const { film, shots } = planned(s)
  assert.equal(s.films.recordClip(film.id, shots[0]!.id, shots[0]!.revision + 1, 'a'.repeat(32), 5), false)
  assert.equal(s.films.recordClip(film.id, shots[0]!.id, shots[0]!.revision, 'a'.repeat(32), 5), true)
})

test('the disk cap is checked before the join, not only when a job is queued', async () => {
  const s = setup()
  const p = await readyToMake(s)
  s.director.make(p.film.id)
  await s.next()
  await s.next()
  s.setDiskUsage(s.jobs.diskLimit)
  await s.next()
  await s.director.idle()
  assert.equal(s.joins.length, 0)
  assert.match(s.films.get(p.film.id)!.problem!, /GB/)
})

test('two films\' pictures still go to the card one job at a time', async () => {
  const s = setup()
  const a = planned(s)
  const b = planned(s)
  await s.director.makePictures(a.film.id, { round: 'places' })
  await s.director.makePictures(b.film.id, { round: 'places' })
  assert.equal((await s.finishAll()).length, 12)
  assert.equal(s.calls.maxActive, 1)
})

test('deleting a film while its pictures are being made stops the round', async () => {
  const s = setup()
  const { film } = planned(s)
  await s.director.makePictures(film.id, { round: 'places' })
  await s.next()
  while (s.active() === 0) await new Promise((r) => setTimeout(r, 2))
  assert.equal(await s.films.delete(film.id), true)
  await s.director.idle()
  assert.equal(s.submitted.length, 2, 'nothing queued after the delete')
})
