// The Storyboard's director: runs a film's picture rounds and Make film on its own (storyboard spec 9 and 15). It
// hands the queue one job at a time, waits for it, and moves on, so the Video page keeps working alongside and the
// graphics card only ever has one of its jobs.
//
// Security-sensitive. Do not modify without Claude review.
//
// - Its state lives in the film tables, never only in memory: after a restart a film being made is marked stopped
//   (with ComfyUI interrupted and its memory freed first), and Make film carries on from the first shot without a
//   current clip.
// - Stop, and any cancel of its job from outside, stops the run; Stop also aborts a running ffmpeg.
// - A clip is kept only if its shot hasn't changed since it was queued (the shot's revision); the disk cap is checked
//   again before every sheet and join, not only when a job is queued.
// - Every prompt comes from film-wording.ts, every recipe from film-recipes.ts; the page names neither.

import { randomBytes, randomInt } from 'node:crypto'
import { join } from 'node:path'
import { FfmpegError, type FfmpegTools, type JoinClip, type JoinPlan, type joinFilm, type makeSheet, type stopLeftoverFfmpeg } from './ffmpeg.js'
import {
  addingOrder, closeUpPrompt, facePrompt, firstMasterPrompt, laterMasterPrompt, posePrompts, shotPrompt, turnaroundPrompt, type FilmLook,
} from './film-wording.js'
import { PICTURE_STAGES, STOP_FIRST, followsOn, slotBasis, type Film, type FilmCastMember, type FilmShot, type FilmStage, type FilmStore, type OwnerKind } from './films.js'
import { VideoRequestError, type VideoEvent, type VideoStatus } from './jobs.js'
import { plainPng } from './png-strip.js'
import type { Recipe } from './recipes.js'

const FPS = 24
const CANDIDATES = 2
const MAX_SEED = 2 ** 40
const SHEET_TIMEOUT_MS = 30_000
const JOIN_TIMEOUT_MS = 10 * 60_000
const FADE_FRAMES: Record<string, 0 | 12 | 24> = { follows: 0, fade_short: 12, fade_long: 24 }
const SHEET_SIZE = { width: 1280, height: 704 }
// The size the picture edits work at (FluxKontextImageScale keeps this 16:9-ish shape), for the first place's blank.
const BLANK_SIZE = { width: 1392, height: 752 }
// Room a sheet or a join needs on the drive, with plenty to spare: a joined film is at most 1 GB.
const MIN_FREE_BYTES = 2 * 1024 ** 3
const RESTARTED = 'Mission Control restarted while this was being made. Press Make film to carry on.'
// One install line per system; ffmpeg.org publishes only source code, so the Windows build is a third party's.
const NO_FFMPEG = 'Making a film needs ffmpeg, which isn\'t installed. Install it (Ubuntu: sudo apt install ffmpeg; Mac: brew install ffmpeg; ' +
  'Windows: winget install Gyan.FFmpeg, a third-party build), then restart Mission Control.'

/** What the page hears about a film as it is made, built on the queue's own events. */
export interface FilmEvent {
  filmId: string
  stage: FilmStage
  shotId?: string
  step?: number
  steps?: number
  preview?: { mime: string; data: string }
  problem?: string
}

/** The video queue, as the director uses it (VideoJobs). */
export interface DirectorQueue {
  submitFilm(recipe: Recipe, params: unknown, filmId: string): string
  cancelFilmJob(id: string, filmId: string): boolean
  statusOf(id: string): { status: VideoStatus; error: string | null } | null
  /** A finished picture job's stored picture, for the next edit of a chain. */
  pictureOf(jobId: string): string | null
  savePicture(buf: Buffer, size: { width: number; height: number }): string
  addJoinedFilm(id: string, bytes: number): void
  removeFilmClip(id: string, filmId: string): void
  removeUnkept(id: string): void
  diskUsage(): number
  readonly diskLimit: number
  freeBytes(): number
  interruptAndFree(): Promise<void>
}

export interface DirectorOptions {
  films: FilmStore
  queue: DirectorQueue
  mediaDir: string
  emit: (event: FilmEvent) => void
  /** The shot recipe can be left out (a test, or a Mission Control without it): Make film then says so. */
  recipes: { fast: Recipe; fine: Recipe; shot: Recipe | null }
  ffmpeg: { tools: () => FfmpegTools | null; join: typeof joinFilm; sheet: typeof makeSheet; stopLeftover: typeof stopLeftoverFfmpeg }
  /** A character's picture cut down to the character on its own, for picture 2 of the pose edits (reference-cut.ts). */
  references: (pictureId: string) => Promise<{ id: string } | 'busy' | 'empty' | 'missing'>
}

export type PictureRequest = { round: 'places' | 'shots' } | { ownerId: unknown; role: string }

// One picture to make: its recipe, the picture it starts from, and the slot it is a candidate for. A pose of several
// characters is several steps, each an edit of the picture the step before made, adding one character (picture 2).
interface PictureTask {
  recipe: Recipe
  image1: string
  steps: Array<{ prompt: string; image2?: string }>
  slot: { ownerKind: OwnerKind; ownerId: string; role: string }
  // What the slot's pictures are made from when the task was planned (films.ts slotBasis); after an edit it is dropped.
  basis: string
}

interface Run {
  filmId: string
  kind: 'pictures' | 'make'
  tasks: PictureTask[]
  stopped: boolean
  // False while the run waits behind another film's: Stop then ends it at once.
  started: boolean
  abort: AbortController
  jobId: string | null
  // Settles when this run has ended or was stopped before it started.
  done: Promise<void>
  settle: () => void
}

type Outcome = { status: VideoStatus; error: string | null }

// What the cutter says about a character's picture, and what a round asks for a character's picture 2.
type CutOut = Awaited<ReturnType<DirectorOptions['references']>>
type Alone = (member: FilmCastMember) => string

const TERMINAL: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled'])

export class FilmDirector {
  private readonly runs = new Map<string, Run>()
  // Runs go one after another, across films: never two of the director's jobs waiting at once.
  private chain: Promise<void> = Promise.resolve()
  private readonly waiters = new Map<string, (outcome: Outcome) => void>()
  // The director's own jobs, so their progress reaches the page as film events.
  private readonly owned = new Map<string, { filmId: string; shotId?: string }>()

  constructor(private readonly o: DirectorOptions) {}

  /** True while any film has pictures being made or is being made. */
  get busy(): boolean {
    return this.runs.size > 0
  }

  /**
   * At start: an ffmpeg left running by a crash is stopped, a film that was being made is stopped with plain words,
   * and ComfyUI is cleared of what it was doing.
   */
  async start(): Promise<void> {
    this.o.ffmpeg.stopLeftover(this.pidFile, this.o.ffmpeg.tools())
    const making = this.o.films.list().filter((f) => f.stage === 'making')
    for (const film of making) this.stage(film.id, 'stopped', RESTARTED)
    if (making.length === 0) return
    try {
      await this.o.queue.interruptAndFree()
    } catch (err) {
      console.error('[film] could not clear ComfyUI after a restart:', err)
    }
  }

  /** The queue's events: a finished job wakes the run waiting on it; progress goes to the page as a film event. */
  onVideoEvent(event: VideoEvent): void {
    const mine = this.owned.get(event.id)
    if (!mine) return
    if (TERMINAL.has(event.status)) {
      this.owned.delete(event.id)
      this.waiters.get(event.id)?.({ status: event.status, error: event.error ?? null })
      this.waiters.delete(event.id)
      return
    }
    const film = this.o.films.get(mine.filmId)
    if (!film) return
    this.o.emit({
      filmId: mine.filmId, stage: film.stage, ...(mine.shotId ? { shotId: mine.shotId } : {}),
      ...(event.step !== undefined ? { step: event.step, steps: event.steps } : {}), ...(event.preview ? { preview: event.preview } : {}),
    })
  }

  /** Resolves once nothing is being made (for tests and for a clean shutdown). */
  async idle(): Promise<void> {
    let chain: Promise<void>
    do {
      chain = this.chain
      await chain
    } while (chain !== this.chain)
  }

  /**
   * Queues a picture round, or two more pictures for one slot (Make more). Each slot gets candidates only once per
   * round; the user chooses. Refusals come back with plain words before anything is queued.
   */
  async makePictures(filmId: unknown, request: PictureRequest): Promise<void> {
    // Planned once without the characters' cut-outs, so every refusal comes first and only the pictures the tasks
    // need are cut (a moment each, once per picture); then planned again on the film as it is after the wait.
    const wanted = new Map<string, string>()
    const first = this.plan(filmId, request, (member) => {
      if (!member.pictureId) throw new VideoRequestError(`${member.name} needs a picture first. Add one in the cast.`)
      wanted.set(member.pictureId, member.name)
      return member.pictureId
    })
    const cuts = await this.cutOut(first.film, wanted)
    const { film, running, tasks } = this.plan(filmId, request, (member) => {
      const cut = member.pictureId ? cuts.get(member.pictureId) : undefined
      if (!cut) throw new VideoRequestError('This film changed while its pictures were being got ready. Press the button again.')
      return cut
    })

    const next: FilmStage | null = 'round' in request && (film.stage === 'plan' || (film.stage === 'places' && request.round === 'shots')) ? request.round : null
    if (next) this.stage(film.id, next)
    if (running && !running.stopped) {
      running.tasks.push(...tasks)
      return
    }
    this.schedule(film.id, 'pictures', tasks)
  }

  // A picture request's tasks, or its refusal in plain words. `alone` gives a character's picture 2.
  private plan(filmId: unknown, request: PictureRequest, alone: Alone): { film: Film; running: Run | undefined; tasks: PictureTask[] } {
    const film = this.o.films.get(filmId)
    if (!film) throw new VideoRequestError('That film no longer exists.')
    if (film.stage === 'making') throw new VideoRequestError(STOP_FIRST)
    const running = this.runs.get(film.id)
    if (running?.kind === 'make') throw new VideoRequestError(STOP_FIRST)
    const queued = running?.tasks ?? []
    let tasks: PictureTask[]
    if ('round' in request && request.round === 'places') tasks = this.placesRound(film, queued)
    else if ('round' in request && request.round === 'shots') tasks = this.shotsRound(film, queued, alone)
    else if ('role' in request) tasks = this.makeMore(film, request.ownerId, request.role, queued, alone)
    else throw new VideoRequestError('Say which pictures to make.')
    if (tasks.length === 0) throw new VideoRequestError('Everything here has pictures to choose from. Choose one, or press Make more.')
    return { film, running, tasks }
  }

  /** Make film: checks it can be made, moves it to `making` (once), and makes every shot without a current clip. */
  make(filmId: unknown): void {
    const film = this.readyToMake(filmId)
    this.o.films.beginMaking(film.id)
    this.o.emit({ filmId: film.id, stage: 'making' })
    this.schedule(film.id, 'make', [])
  }

  /** Redo: one shot made again (with a new seed if asked), then the film joined again. Only that shot is remade. */
  redo(filmId: unknown, shotId: unknown, newSeed: boolean): void {
    // Every refusal first, so a Redo that can't start changes nothing (not even the seed).
    const film = this.readyToMake(filmId)
    if (this.o.films.list().some((f) => f.stage === 'making' && f.id !== film.id)) {
      throw new VideoRequestError('Only one film is made at a time, and another film is being made. Wait for it to finish, or stop it first.')
    }
    this.o.films.prepareRedo(film.id, shotId, newSeed)
    this.make(film.id)
  }

  // Make film's checks, before anything changes.
  private readyToMake(filmId: unknown): Film {
    const film = this.o.films.get(filmId)
    if (!film) throw new VideoRequestError('That film no longer exists.')
    if (!this.o.recipes.shot) throw new VideoRequestError('This Mission Control has no shot recipe, so films can\'t be made.')
    if (!this.o.ffmpeg.tools()) throw new VideoRequestError(NO_FFMPEG)
    if (this.runs.has(film.id)) throw new VideoRequestError('Pictures for this film are still being made. Wait for them, or stop them first.')
    for (const shot of film.shots) {
      for (const member of castOf(film, shot)) {
        if (!member.pictureId || !member.turnaroundId || !member.faceId) throw new VideoRequestError(`Choose ${member.name}'s turnaround and face pictures first.`)
      }
      const place = film.places.find((p) => p.id === shot.placeId)!
      if (!place.masterId) throw new VideoRequestError(`Choose a master picture for ${place.name} first.`)
    }
    return film
  }

  /** Stops a film's pictures or its making: its running job is cancelled and ended before this returns. */
  async stop(filmId: unknown): Promise<void> {
    const film = this.o.films.get(filmId)
    if (!film) return
    const run = this.runs.get(film.id)
    if (run) {
      run.stopped = true
      run.tasks.length = 0
      run.abort.abort()
      if (run.jobId) this.o.queue.cancelFilmJob(run.jobId, film.id)
      // A run still waiting behind another film's has nothing to end: it will be skipped.
      if (!run.started) {
        this.runs.delete(film.id)
        run.settle()
      }
      await run.done
    }
    if (this.o.films.get(film.id)?.stage === 'making') this.stage(film.id, 'stopped')
  }

  private schedule(filmId: string, kind: Run['kind'], tasks: PictureTask[]): void {
    let settle!: () => void
    const done = new Promise<void>((resolve) => { settle = resolve })
    const run: Run = { filmId, kind, tasks, stopped: false, started: false, abort: new AbortController(), jobId: null, done, settle }
    this.runs.set(filmId, run)
    const work = kind === 'make' ? () => this.makeFilm(run) : () => this.makePictureTasks(run)
    this.chain = this.chain
      .then(async () => {
        if (run.stopped) return
        run.started = true
        await work()
      })
      .catch((err) => console.error('[film] a run failed unexpectedly:', err))
      .finally(() => {
        if (this.runs.get(filmId) === run) this.runs.delete(filmId)
        settle()
      })
  }

  private stage(filmId: string, stage: FilmStage, problem: string | null = null): void {
    this.o.films.setStage(filmId, stage, problem)
    this.o.emit({ filmId, stage, ...(problem ? { problem } : {}) })
  }

  // Submits a job and waits until the queue says it has ended. Cancelled from outside counts as Stop.
  private async runJob(run: Run, recipe: Recipe, params: Record<string, unknown>, opts: { shotId?: string; submitted?: (jobId: string) => void } = {}): Promise<{ jobId: string; outcome: Outcome }> {
    const jobId = this.o.queue.submitFilm(recipe, params, run.filmId)
    run.jobId = jobId
    this.owned.set(jobId, { filmId: run.filmId, ...(opts.shotId ? { shotId: opts.shotId } : {}) })
    opts.submitted?.(jobId)
    const outcome = await new Promise<Outcome>((resolve) => {
      const now = this.o.queue.statusOf(jobId)
      if (now && TERMINAL.has(now.status)) return resolve(now)
      this.waiters.set(jobId, resolve)
    })
    run.jobId = null
    return { jobId, outcome }
  }

  private async makePictureTasks(run: Run): Promise<void> {
    while (!run.stopped) {
      const task = run.tasks.shift()
      if (!task || !this.o.films.get(run.filmId)) return
      // One seed for every step of a chain, as in hand test T6.
      const seed = randomInt(1, MAX_SEED)
      let image1 = task.image1
      let candidate: string | null = null
      for (const step of task.steps) {
        // Nothing goes to the card for a slot that is gone, full, or changed since the task was planned (an edit
        // mid-round): a chain cut short this way shows as stopped, and is out of date anyway.
        if (!this.stillWanted(run.filmId, task, candidate === null)) break
        const params = { prompt: step.prompt, image1, ...(step.image2 ? { image2: step.image2 } : {}), seed }
        let outcome: Outcome
        let jobId: string
        try {
          // The first step's job makes the candidate (no picture check until a local model can see pictures, spec
          // 7.2: it says "off"); each later step's job becomes the candidate's, so it is finished only at the last.
          ({ jobId, outcome } = await this.runJob(run, task.recipe, params, {
            submitted: (id) => {
              try {
                if (candidate) this.o.films.advanceCandidate(run.filmId, candidate, id)
                else candidate = this.o.films.addCandidate(run.filmId, { ...task.slot, jobId: id, seed, steps: task.steps.length, basis: task.basis, checkState: 'off' })
              } catch (err) {
                // A job with nowhere to go doesn't run.
                this.o.queue.cancelFilmJob(id, run.filmId)
                throw err
              }
            },
          }))
        } catch (err) {
          // The queue refused (full, or the disk cap): the round stops with its words on the page.
          if (!(err instanceof VideoRequestError)) throw err
          const film = this.o.films.get(run.filmId)
          if (film) this.stage(film.id, film.stage, err.message)
          return
        }
        // A cancelled step stops the round; a failed one shows as failed among its slot's candidates, and the round
        // goes on to the next picture.
        if (outcome.status === 'cancelled' || run.stopped) return
        if (outcome.status !== 'done') break
        const made = this.o.queue.pictureOf(jobId)
        if (!made) break
        image1 = made
      }
    }
  }

  // True while a task's slot still takes a new picture (or its chain's next edit) made from what the task was planned on.
  private stillWanted(filmId: string, task: PictureTask, first: boolean): boolean {
    try {
      this.o.films.checkSlot(filmId, task.slot.ownerKind, task.slot.ownerId, task.slot.role, first ? 1 : 0, task.basis)
      return true
    } catch (err) {
      if (err instanceof VideoRequestError) return false
      throw err
    }
  }

  private placesRound(film: Film, queued: PictureTask[]): PictureTask[] {
    if (film.places.length === 0 || film.shots.length === 0) throw new VideoRequestError('Plan the film first: add its places and shots.')
    const has = this.hasCandidates(film, queued)
    const tasks: PictureTask[] = []
    for (const member of film.cast) {
      if (!member.pictureId) throw new VideoRequestError(`${member.name} needs a picture first. Add one in the cast.`)
      const wording = { name: member.name, wording: member.wording }
      if (!member.turnaroundId && !has(member.castId, 'turnaround')) tasks.push(...this.twice(film, this.o.recipes.fine, member.pictureId, [{ prompt: turnaroundPrompt(wording) }], { ownerKind: 'cast', ownerId: member.castId, role: 'turnaround' }))
      if (!member.faceId && !has(member.castId, 'face')) tasks.push(...this.twice(film, this.o.recipes.fine, member.pictureId, [{ prompt: facePrompt(wording) }], { ownerKind: 'cast', ownerId: member.castId, role: 'face' }))
    }
    const [first, ...later] = film.places
    if (!first!.masterId && !has(first!.id, 'master')) tasks.push(...this.masters(film, first!))
    // Later places are edits of the first chosen master, so the light and style carry over.
    if (first!.masterId) for (const place of later) if (!place.masterId && !has(place.id, 'master')) tasks.push(...this.masters(film, place))
    return tasks
  }

  // Each of these pictures (by id, with whose it is) cut down to the character on its own. Refuses, naming whose, a
  // picture the character can't be cut from (hand test T10: picture 2 the size of the scene got pasted in as well as drawn).
  private async cutOut(film: Film, pictures: Map<string, string>): Promise<Map<string, string>> {
    const cuts = new Map<string, string>()
    for (const [pictureId, name] of pictures) {
      let cut: CutOut
      try {
        cut = await this.o.references(pictureId)
      } catch (err) {
        console.error('[film] could not cut out a character:', err)
        throw new VideoRequestError(`Mission Control could not get ${name}'s picture ready${err instanceof FfmpegError ? `: ${err.message}` : '.'}`)
      }
      const plain = `In the cast, give ${name} a picture of ${name} alone on a plain background.`
      if (cut === 'busy') throw new VideoRequestError(`${name}'s picture has a busy background, and the picture editor then draws ${name} twice. ${plain}`)
      if (cut === 'empty') throw new VideoRequestError(`Mission Control can't find ${name} in ${name}'s picture. ${plain}`)
      if (cut === 'missing') throw new VideoRequestError(`${name}'s picture is missing. Add it again in the cast.`)
      cuts.set(pictureId, cut.id)
    }
    if (!this.o.films.get(film.id)) throw new VideoRequestError('That film no longer exists.')
    return cuts
  }

  private shotsRound(film: Film, queued: PictureTask[], alone: Alone): PictureTask[] {
    if (film.shots.length === 0) throw new VideoRequestError('Plan the film first: add its places and shots.')
    // A chosen master means round one has been made and chosen from.
    for (const shot of film.shots) {
      const place = film.places.find((p) => p.id === shot.placeId)!
      if (!place.masterId) throw new VideoRequestError(`Choose a master picture for ${place.name} first.`)
    }
    this.o.films.useMasterAsEmpty(film.id)
    const ready = this.o.films.get(film.id)!
    const has = this.hasCandidates(ready, queued)
    const tasks: PictureTask[] = []
    ready.shots.forEach((shot, i) => {
      const before = ready.shots[i - 1]
      if (!shot.startId && !followsOn(before, shot) && !has(shot.id, 'start')) tasks.push(...this.pose(ready, shot, 'start', alone))
      if (!shot.closeUp && !shot.endId && !has(shot.id, 'end')) tasks.push(...this.pose(ready, shot, 'end', alone))
    })
    return tasks
  }

  private makeMore(film: Film, ownerId: unknown, role: string, queued: PictureTask[], alone: Alone): PictureTask[] {
    if (!PICTURE_STAGES.has(film.stage)) throw new VideoRequestError('Make more is for pictures already made: start with round one.')
    // What the id names decides its kind; the role must then fit it.
    const kind: OwnerKind | undefined = film.places.some((p) => p.id === ownerId) ? 'place'
      : film.shots.some((s) => s.id === ownerId) ? 'shot' : film.cast.some((c) => c.castId === ownerId) ? 'cast' : undefined
    if (!kind) throw new VideoRequestError('That is no longer in this film.')
    if (role === 'empty') throw new VideoRequestError('That role doesn\'t fit what the picture is for.')
    // The cap counts the pictures still waiting in this film's round too.
    const waiting = queued.filter((t) => t.slot.ownerId === ownerId && t.slot.role === role).length
    const owner = this.o.films.checkSlot(film.id, kind, ownerId, role, CANDIDATES + waiting)
    if (kind === 'cast') {
      const member = film.cast.find((c) => c.castId === owner)!
      if (!member.pictureId) throw new VideoRequestError(`${member.name} needs a picture first. Add one in the cast.`)
      const wording = { name: member.name, wording: member.wording }
      return this.twice(film, this.o.recipes.fine, member.pictureId, [{ prompt: role === 'face' ? facePrompt(wording) : turnaroundPrompt(wording) }], { ownerKind: 'cast', ownerId: owner, role })
    }
    if (kind === 'place') {
      const place = film.places.find((p) => p.id === owner)!
      if (place !== film.places[0] && !film.places[0]!.masterId) throw new VideoRequestError(`Choose a master picture for ${film.places[0]!.name} first.`)
      return this.masters(film, place)
    }
    const shot = film.shots.find((s) => s.id === owner)!
    if (role === 'end' && shot.closeUp) throw new VideoRequestError('A close-up has no end picture.')
    const place = film.places.find((p) => p.id === shot.placeId)!
    if (!place.emptyId && !place.masterId) throw new VideoRequestError(`Choose a master picture for ${place.name} first.`)
    this.o.films.useMasterAsEmpty(film.id)
    return this.pose(this.o.films.get(film.id)!, shot, role as 'start' | 'end', alone)
  }

  // True when a slot already has candidates that are made, being made or about to be.
  private hasCandidates(film: Film, queued: PictureTask[]): (ownerId: string, role: string) => boolean {
    return (ownerId, role) =>
      film.pictures.some((p) => p.ownerId === ownerId && p.role === role && !p.stale && p.status !== 'failed' && p.status !== 'cancelled') ||
      queued.some((t) => t.slot.ownerId === ownerId && t.slot.role === role)
  }

  private masters(film: Film, place: Film['places'][number]): PictureTask[] {
    const first = film.places[0]!
    const slot = { ownerKind: 'place' as const, ownerId: place.id, role: 'master' }
    // The first place is drawn from a plain blank picture: drawn from a character's picture, the character could stay
    // in it (hand test T9, a master of Tom's picture kept Tom).
    if (place.id === first.id) {
      const blank = this.o.queue.savePicture(plainPng(BLANK_SIZE.width, BLANK_SIZE.height, 200), BLANK_SIZE)
      return this.twice(film, this.o.recipes.fast, blank, [{ prompt: firstMasterPrompt(place, film.look as FilmLook) }], slot)
    }
    return this.twice(film, this.o.recipes.fast, first.masterId!, [{ prompt: laterMasterPrompt(place) }], slot)
  }

  // A start or end pose: the characters added into the place on its own one at a time, in the shot's order, each
  // with its own pose words and picture (hand test T6); or a close-up's start (the fine editor, one character).
  private pose(film: Film, shot: FilmShot, role: 'start' | 'end', alone: Alone): PictureTask[] {
    const place = film.places.find((p) => p.id === shot.placeId)!
    const members = castOf(film, shot)
    const slot = { ownerKind: 'shot' as const, ownerId: shot.id, role }
    // Picture 2 is each character on their own (makePictures, cutOut).
    if (shot.closeUp) {
      const [member] = members as [FilmCastMember]
      return this.twice(film, this.o.recipes.fine, place.emptyId!, [{ prompt: closeUpPrompt(member, shot.characters[0]!.startPose), image2: alone(member) }], slot)
    }
    const characters = addingOrder(members.map((member, i) => {
      if (!member.kind) throw new VideoRequestError(`Say what ${member.name} is in one word (like dog or man) in the film's cast first.`)
      const character = shot.characters[i]!
      return { member, cast: { name: member.name, wording: member.wording, kind: member.kind }, pose: role === 'start' ? character.startPose : character.endPose! }
    }))
    const prompts = posePrompts(characters, place, film.look as FilmLook)
    return this.twice(film, this.o.recipes.fast, place.emptyId!, prompts.map((prompt, i) => ({ prompt, image2: alone(characters[i]!.member) })), slot)
  }

  private twice(film: Film, recipe: Recipe, image1: string, steps: PictureTask['steps'], slot: PictureTask['slot']): PictureTask[] {
    const basis = slotBasis(film, slot.ownerKind, slot.ownerId, slot.role)!
    return Array.from({ length: CANDIDATES }, () => ({ recipe, image1, steps, slot, basis }))
  }

  // The 50 GB cap and the drive's own free space, before every sheet and join.
  private checkDisk(): void {
    if (this.o.queue.diskUsage() >= this.o.queue.diskLimit) {
      throw new VideoRequestError(`Your videos and pictures use the full ${this.o.queue.diskLimit / 1024 ** 3} GB. Delete some you no longer need, then press Make film to carry on.`)
    }
    const free = this.o.queue.freeBytes()
    if (free < MIN_FREE_BYTES) {
      throw new VideoRequestError(`The drive Mission Control keeps videos on is nearly full (${(free / 1024 ** 3).toFixed(1)} GB free). Free some space, then press Make film to carry on.`)
    }
  }

  // Names the running ffmpeg, so a restart after a crash can stop a leftover one.
  private get pidFile(): string {
    return join(this.o.mediaDir, 'ffmpeg.pid')
  }

  private async makeFilm(run: Run): Promise<void> {
    const shotRecipe = this.o.recipes.shot!
    const tools = this.o.ffmpeg.tools()!
    try {
      await this.makeSheets(run, tools)
      let film = this.o.films.get(run.filmId)
      for (const [i, shot] of (film?.shots ?? []).entries()) {
        if (run.stopped) return
        film = this.o.films.get(run.filmId)
        if (!film) return
        const current = film.shots.find((s) => s.id === shot.id)!
        if (current.clipId && current.clipRev === current.revision) continue
        const place = film.places.find((p) => p.id === current.placeId)!
        this.o.emit({ filmId: film.id, stage: 'making', shotId: current.id })
        const members = castOf(film, current)
        const characters = current.characters.map((c, j) => ({ cast: members[j]!, startPose: c.startPose, endPose: c.endPose ?? '' }))
        const prompt = shotPrompt(place, sheetCast(film, place.id), { action: current.action, closeUp: current.closeUp, characters }, film.look as FilmLook)
        const params = {
          prompt, sheet: place.sheetId!, start: current.startId!, ...(current.closeUp ? {} : { end: current.endId! }),
          frames: current.seconds * FPS + 1, seed: current.seed,
        }
        const { jobId, outcome } = await this.runJob(run, shotRecipe, params, { shotId: current.id })
        if (outcome.status === 'cancelled' || run.stopped) {
          run.stopped = true
          return
        }
        if (outcome.status === 'failed') {
          this.stage(film.id, 'stopped', `Shot ${i + 1} could not be made: ${outcome.error ?? 'the queue gave no reason.'}`)
          return
        }
        if (!this.o.films.recordClip(film.id, current.id, current.revision, jobId, current.seed)) {
          this.o.queue.removeFilmClip(jobId, film.id)
        } else if (current.clipId && current.clipId !== jobId) {
          this.o.queue.removeFilmClip(current.clipId, film.id)
        }
      }
      if (run.stopped) return
      film = this.o.films.get(run.filmId)
      if (!film) return
      this.checkDisk()
      const outId = randomBytes(16).toString('hex')
      const { bytes } = await this.o.ffmpeg.join(tools, this.o.mediaDir, joinPlan(film), outId, { timeoutMs: JOIN_TIMEOUT_MS, signal: run.abort.signal, pidFile: this.pidFile })
      if (run.stopped) return
      this.o.queue.addJoinedFilm(outId, bytes)
      const replaced = this.o.films.setJoined(film.id, outId)
      this.o.emit({ filmId: film.id, stage: 'done' })
      if (replaced) this.o.queue.removeUnkept(replaced)
    } catch (err) {
      if (run.stopped) return
      if (err instanceof VideoRequestError || err instanceof FfmpegError) return this.stage(run.filmId, 'stopped', err.message)
      console.error('[film] making a film failed unexpectedly:', err)
      this.stage(run.filmId, 'stopped', 'Something went wrong in Mission Control while making this film.')
    } finally {
      if (run.stopped && this.o.films.get(run.filmId)?.stage === 'making') this.stage(run.filmId, 'stopped')
    }
  }

  // One reference sheet per place (ffmpeg, seconds each): the place, one character's turnaround and face (the first
  // character of the place's sheet shot), and that shot's start picture with its characters in it. Made when missing,
  // and again when what it was made from has changed (a new first shot, other characters, a new start picture).
  // Hand test T8 found a sheet of one character guides a shot of three as well.
  private async makeSheets(run: Run, tools: FfmpegTools): Promise<void> {
    const film = this.o.films.get(run.filmId)
    if (!film) return
    for (const place of film.places) {
      const shot = sheetShot(film, place.id)
      if (!shot || run.stopped) continue
      const member = castOf(film, shot)[0]!
      const pictures = { place: place.emptyId ?? place.masterId!, turnaround: member.turnaroundId!, face: member.faceId!, placeWithCast: shot.startId! }
      const basis = JSON.stringify([pictures.place, member.castId, pictures.turnaround, pictures.face, pictures.placeWithCast])
      if (place.sheetId && place.sheetBasis === basis) continue
      this.checkDisk()
      const sheet = await this.o.ffmpeg.sheet(tools, join(this.o.mediaDir, 'inputs'), pictures, { timeoutMs: SHEET_TIMEOUT_MS, signal: run.abort.signal, pidFile: this.pidFile })
      this.o.films.setSheet(film.id, place.id, this.o.queue.savePicture(sheet, SHEET_SIZE), basis)
    }
  }
}

// The film's own copy of each character in a shot, in the shot's order.
function castOf(film: Film, shot: FilmShot): FilmCastMember[] {
  return shot.characters.map((c) => film.cast.find((m) => m.castId === c.castId)!)
}

// The shot a place's sheet is made from: its first shot there that isn't a close-up (a close-up's start is a face, not
// the place with the cast in it), or its first shot when all are close-ups.
function sheetShot(film: Film, placeId: string): FilmShot | undefined {
  const here = film.shots.filter((s) => s.placeId === placeId)
  return here.find((s) => !s.closeUp) ?? here[0]
}

// Who a place's reference sheet shows: the first character of its sheet shot, and everyone in that shot.
function sheetCast(film: Film, placeId: string): { cast: FilmCastMember; with: FilmCastMember[] } {
  const members = castOf(film, sheetShot(film, placeId)!)
  return { cast: members[0]!, with: members }
}

/**
 * The film's join, in whole frames: each shot whole, a straight cut where it follows on (dropping the first frame when
 * it starts on the picture the shot before ended on), a short or long crossfade where time passes.
 */
export function joinPlan(film: Film): JoinPlan {
  const clips: JoinClip[] = film.shots.map((shot, i) => {
    const before = film.shots[i - 1]
    const frames = shot.seconds * FPS + 1
    const fade = before ? FADE_FRAMES[shot.joins]! : 0
    const sharedPicture = !!before && fade === 0 && shot.placeId === before.placeId && shot.startId !== null && shot.startId === before.endId
    return { videoId: shot.clipId!, inFrame: sharedPicture ? 1 : 0, outFrame: frames, transition: fade === 0 ? 'cut' : 'crossfade', transitionFrames: fade }
  })
  return { sound: film.sound, fadeOutFrames: 24, clips }
}
