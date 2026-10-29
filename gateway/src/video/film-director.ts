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
import { FfmpegError, type FfmpegTools, type JoinClip, type JoinPlan, type joinFilm, type makeSheet } from './ffmpeg.js'
import {
  closeUpPrompt, facePrompt, firstMasterPrompt, laterMasterPrompt, posePrompt, shotPrompt, turnaroundPrompt, type FilmLook,
} from './film-wording.js'
import { STOP_FIRST, type Film, type FilmShot, type FilmStage, type FilmStore, type OwnerKind } from './films.js'
import { VideoRequestError, type VideoEvent, type VideoStatus } from './jobs.js'
import type { Recipe } from './recipes.js'

const FPS = 24
const CANDIDATES = 2
const MAX_SEED = 2 ** 40
const SHEET_TIMEOUT_MS = 30_000
const JOIN_TIMEOUT_MS = 10 * 60_000
const FADE_FRAMES: Record<string, 0 | 12 | 24> = { follows: 0, fade_short: 12, fade_long: 24 }
const RESTARTED = 'Mission Control restarted while this was being made. Press Make film to carry on.'

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
  savePicture(buf: Buffer): string
  addJoinedFilm(id: string, bytes: number): void
  removeFilmClip(id: string, filmId: string): void
  removeUnkept(id: string): void
  diskUsage(): number
  readonly diskLimit: number
  interruptAndFree(): Promise<void>
}

export interface DirectorOptions {
  films: FilmStore
  queue: DirectorQueue
  mediaDir: string
  emit: (event: FilmEvent) => void
  /** The shot recipe is null until hand test T1 settles which nodes it uses. */
  recipes: { fast: Recipe; fine: Recipe; shot: Recipe | null }
  ffmpeg: { tools: () => FfmpegTools | null; join: typeof joinFilm; sheet: typeof makeSheet }
}

export type PictureRequest = { round: 'places' | 'shots' } | { ownerId: unknown; role: string }

// One picture to make: its recipe and prompt, the pictures it edits, and the slot it is a candidate for.
interface PictureTask {
  recipe: Recipe
  prompt: string
  image1: string
  image2?: string
  slot: { ownerKind: OwnerKind; ownerId: string; role: string }
}

interface Run {
  filmId: string
  kind: 'pictures' | 'make'
  tasks: PictureTask[]
  stopped: boolean
  abort: AbortController
  jobId: string | null
  done: Promise<void>
}

type Outcome = { status: VideoStatus; error: string | null }

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

  /** At start: a film that was being made is stopped with plain words, and ComfyUI is cleared of what it was doing. */
  async start(): Promise<void> {
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
    const film = this.o.films.get(filmId)
    if (!film) throw new VideoRequestError('That film no longer exists.')
    if (film.stage === 'making') throw new VideoRequestError(STOP_FIRST)
    const running = this.runs.get(film.id)
    if (running?.kind === 'make') throw new VideoRequestError(STOP_FIRST)
    const queued = running?.tasks ?? []
    let tasks: PictureTask[]
    if ('round' in request && request.round === 'places') tasks = this.placesRound(film, queued)
    else if ('round' in request && request.round === 'shots') tasks = this.shotsRound(film, queued)
    else if ('role' in request) tasks = this.makeMore(film, request.ownerId, request.role)
    else throw new VideoRequestError('Say which pictures to make.')
    if (tasks.length === 0) throw new VideoRequestError('Everything here has pictures to choose from. Choose one, or press Make more.')

    const next: FilmStage | null = 'round' in request && (film.stage === 'plan' || (film.stage === 'places' && request.round === 'shots')) ? request.round : null
    if (next) this.stage(film.id, next)
    if (running && !running.stopped) {
      running.tasks.push(...tasks)
      return
    }
    this.schedule({ filmId: film.id, kind: 'pictures', tasks, stopped: false, abort: new AbortController(), jobId: null, done: Promise.resolve() })
  }

  /** Make film: checks it can be made, moves it to `making` (once), and makes every shot without a current clip. */
  make(filmId: unknown): void {
    const film = this.o.films.get(filmId)
    if (!film) throw new VideoRequestError('That film no longer exists.')
    if (!this.o.recipes.shot) throw new VideoRequestError('The shot recipe isn\'t ready yet (it waits for a hand test), so films can\'t be made yet.')
    if (!this.o.ffmpeg.tools()) throw new VideoRequestError('Making a film needs ffmpeg, which isn\'t installed. Install it (see Making videos in the README), then restart Mission Control.')
    if (this.runs.has(film.id)) throw new VideoRequestError('Pictures for this film are still being made. Wait for them, or stop them first.')
    for (const shot of film.shots) {
      const member = film.cast.find((c) => c.castId === shot.castId)!
      if (!member.pictureId || !member.turnaroundId || !member.faceId) throw new VideoRequestError(`Choose ${member.name}'s turnaround and face pictures first.`)
      const place = film.places.find((p) => p.id === shot.placeId)!
      if (!place.masterId) throw new VideoRequestError(`Choose a master picture for ${place.name} first.`)
    }
    this.o.films.beginMaking(film.id)
    this.o.emit({ filmId: film.id, stage: 'making' })
    this.schedule({ filmId: film.id, kind: 'make', tasks: [], stopped: false, abort: new AbortController(), jobId: null, done: Promise.resolve() })
  }

  /** Redo: one shot made again (with a new seed if asked), then the film joined again. Only that shot is remade. */
  redo(filmId: unknown, shotId: unknown, newSeed: boolean): void {
    if (this.runs.has(String(filmId))) throw new VideoRequestError(STOP_FIRST)
    this.o.films.prepareRedo(filmId, shotId, newSeed)
    this.make(filmId)
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
      await run.done
    }
    if (this.o.films.get(film.id)?.stage === 'making') this.stage(film.id, 'stopped')
  }

  private schedule(run: Run): void {
    this.runs.set(run.filmId, run)
    const work = run.kind === 'make' ? () => this.makeFilm(run) : () => this.makePictureTasks(run)
    run.done = this.chain = this.chain
      .then(() => (run.stopped ? undefined : work()))
      .catch((err) => console.error('[film] a run failed unexpectedly:', err))
      .finally(() => {
        if (this.runs.get(run.filmId) === run) this.runs.delete(run.filmId)
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
      const seed = randomInt(1, MAX_SEED)
      const params = { prompt: task.prompt, image1: task.image1, ...(task.image2 ? { image2: task.image2 } : {}), seed }
      let outcome: Outcome
      try {
        // No picture check until a local model can see pictures (spec 7.2): the candidate says "off".
        ({ outcome } = await this.runJob(run, task.recipe, params, {
          submitted: (jobId) => this.o.films.addCandidate(run.filmId, { ...task.slot, jobId, seed, checkState: 'off' }),
        }))
      } catch (err) {
        // The queue refused (full, or the disk cap): the round stops with its words on the page.
        if (!(err instanceof VideoRequestError)) throw err
        const film = this.o.films.get(run.filmId)
        if (film) this.stage(film.id, film.stage, err.message)
        return
      }
      // A failed picture shows as failed among its slot's candidates; a cancelled one stops the round.
      if (outcome.status === 'cancelled') return
    }
  }

  private placesRound(film: Film, queued: PictureTask[]): PictureTask[] {
    if (film.places.length === 0 || film.shots.length === 0) throw new VideoRequestError('Plan the film first: add its places and shots.')
    const has = this.hasCandidates(film, queued)
    const tasks: PictureTask[] = []
    for (const member of film.cast) {
      if (!member.pictureId) throw new VideoRequestError(`${member.name} needs a picture first. Add one in the cast.`)
      const wording = { name: member.name, wording: member.wording }
      if (!member.turnaroundId && !has(member.castId, 'turnaround')) tasks.push(...this.twice(this.o.recipes.fine, turnaroundPrompt(wording), member.pictureId, undefined, { ownerKind: 'cast', ownerId: member.castId, role: 'turnaround' }))
      if (!member.faceId && !has(member.castId, 'face')) tasks.push(...this.twice(this.o.recipes.fine, facePrompt(wording), member.pictureId, undefined, { ownerKind: 'cast', ownerId: member.castId, role: 'face' }))
    }
    const [first, ...later] = film.places
    if (!first!.masterId && !has(first!.id, 'master')) tasks.push(...this.masters(film, first!))
    // Later places are edits of the first chosen master, so the light and style carry over.
    if (first!.masterId) for (const place of later) if (!place.masterId && !has(place.id, 'master')) tasks.push(...this.masters(film, place))
    return tasks
  }

  private shotsRound(film: Film, queued: PictureTask[]): PictureTask[] {
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
      const followsOn = !shot.closeUp && shot.joins === 'follows' && before?.placeId === shot.placeId
      if (!shot.startId && !followsOn && !has(shot.id, 'start')) tasks.push(...this.pose(ready, shot, 'start'))
      if (!shot.closeUp && !shot.endId && !has(shot.id, 'end')) tasks.push(...this.pose(ready, shot, 'end'))
    })
    return tasks
  }

  private makeMore(film: Film, ownerId: unknown, role: string): PictureTask[] {
    // What the id names decides its kind; the role must then fit it.
    const kind: OwnerKind | undefined = film.places.some((p) => p.id === ownerId) ? 'place'
      : film.shots.some((s) => s.id === ownerId) ? 'shot' : film.cast.some((c) => c.castId === ownerId) ? 'cast' : undefined
    if (!kind) throw new VideoRequestError('That is no longer in this film.')
    if (role === 'empty') throw new VideoRequestError('That role doesn\'t fit what the picture is for.')
    const owner = this.o.films.checkSlot(film.id, kind, ownerId, role, CANDIDATES)
    if (kind === 'cast') {
      const member = film.cast.find((c) => c.castId === owner)!
      if (!member.pictureId) throw new VideoRequestError(`${member.name} needs a picture first. Add one in the cast.`)
      const wording = { name: member.name, wording: member.wording }
      return this.twice(this.o.recipes.fine, role === 'face' ? facePrompt(wording) : turnaroundPrompt(wording), member.pictureId, undefined, { ownerKind: 'cast', ownerId: owner, role })
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
    return this.pose(this.o.films.get(film.id)!, shot, role as 'start' | 'end')
  }

  // True when a slot already has candidates that are made, being made or about to be.
  private hasCandidates(film: Film, queued: PictureTask[]): (ownerId: string, role: string) => boolean {
    return (ownerId, role) =>
      film.pictures.some((p) => p.ownerId === ownerId && p.role === role && p.status !== 'failed' && p.status !== 'cancelled') ||
      queued.some((t) => t.slot.ownerId === ownerId && t.slot.role === role)
  }

  private masters(film: Film, place: Film['places'][number]): PictureTask[] {
    const first = film.places[0]!
    const slot = { ownerKind: 'place' as const, ownerId: place.id, role: 'master' }
    if (place.id === first.id) return this.twice(this.o.recipes.fast, firstMasterPrompt(place, film.look as FilmLook), film.cast[0]!.pictureId!, undefined, slot)
    return this.twice(this.o.recipes.fast, laterMasterPrompt(place), first.masterId!, undefined, slot)
  }

  // A start or end pose: one character added into the place on its own, or a close-up's start (the fine editor).
  private pose(film: Film, shot: FilmShot, role: 'start' | 'end'): PictureTask[] {
    const place = film.places.find((p) => p.id === shot.placeId)!
    const member = film.cast.find((c) => c.castId === shot.castId)!
    const wording = { name: member.name, wording: member.wording }
    const slot = { ownerKind: 'shot' as const, ownerId: shot.id, role }
    if (shot.closeUp) return this.twice(this.o.recipes.fine, closeUpPrompt(wording, shot.startPose), place.emptyId!, member.pictureId!, slot)
    const words = role === 'start' ? shot.startPose : shot.endPose!
    return this.twice(this.o.recipes.fast, posePrompt(wording, words, place), place.emptyId!, member.pictureId!, slot)
  }

  private twice(recipe: Recipe, prompt: string, image1: string, image2: string | undefined, slot: PictureTask['slot']): PictureTask[] {
    return Array.from({ length: CANDIDATES }, () => ({ recipe, prompt, image1, ...(image2 ? { image2 } : {}), slot }))
  }

  private checkDisk(): void {
    if (this.o.queue.diskUsage() >= this.o.queue.diskLimit) {
      throw new VideoRequestError(`Your videos and pictures use the full ${this.o.queue.diskLimit / 1024 ** 3} GB. Delete some you no longer need, then press Make film to carry on.`)
    }
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
        const member = film.cast.find((c) => c.castId === current.castId)!
        this.o.emit({ filmId: film.id, stage: 'making', shotId: current.id })
        const prompt = shotPrompt(place, { name: member.name, wording: member.wording },
          { action: current.action, startPose: current.startPose, endPose: current.endPose ?? '', closeUp: current.closeUp }, film.look as FilmLook)
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
      const { bytes } = await this.o.ffmpeg.join(tools, this.o.mediaDir, joinPlan(film), outId, { timeoutMs: JOIN_TIMEOUT_MS, signal: run.abort.signal })
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

  // One reference sheet per place (ffmpeg, seconds each): the place, the character's turnaround and face, and the
  // first shot there with the character in it. Made only when missing.
  private async makeSheets(run: Run, tools: FfmpegTools): Promise<void> {
    const film = this.o.films.get(run.filmId)
    if (!film) return
    for (const place of film.places) {
      const shot = film.shots.find((s) => s.placeId === place.id)
      if (!shot || place.sheetId || run.stopped) continue
      const member = film.cast.find((c) => c.castId === shot.castId)!
      this.checkDisk()
      const sheet = await this.o.ffmpeg.sheet(tools, join(this.o.mediaDir, 'inputs'), {
        place: place.emptyId ?? place.masterId!, turnaround: member.turnaroundId!, face: member.faceId!, placeWithCast: shot.startId!,
      }, { timeoutMs: SHEET_TIMEOUT_MS, signal: run.abort.signal })
      this.o.films.setSheet(film.id, place.id, this.o.queue.savePicture(sheet))
    }
  }
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
