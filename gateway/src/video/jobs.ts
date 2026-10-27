// The video job queue: one job on the graphics card at a time, live progress and previews
// pushed to the page, finished files cleaned of metadata and kept in the data folder.
//
// Security-sensitive. Do not modify without Claude review.

import { randomBytes, randomInt } from 'crypto'
import { mkdirSync, writeFileSync, existsSync, statSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import type Database from 'better-sqlite3'
import type WebSocket from 'ws'
import { ComfyClient, checkComfyUrl, listensBeyondThisComputer, type ComfyMessage } from './comfyui.js'
import { ImageInputs, type ImageInfo } from './image-input.js'
import { stripMp4Metadata } from './mp4-strip.js'
import { validateParams } from './params.js'
import { findRecipe, nodeClasses, type ComfyGraph, type Recipe } from './recipes.js'
import type { ParamValues } from './recipe-types.js'

const JOB_TIMEOUT_MS = 30 * 60 * 1000
const MAX_VIDEO_BYTES = 512 * 1024 * 1024
const MAX_QUEUED = 10
const MAX_MEDIA_BYTES = 50 * 1024 ** 3
const PREVIEW_MIN_INTERVAL_MS = 250
const POLL_MS = 3000
// ComfyUI hands graphics memory back a few seconds after /free, so a job that starts soon after another (within
// RECENT_FREE_MS) waits up to MEMORY_WAIT_MS for it before refusing. Otherwise a full card is refused at once.
const MEMORY_WAIT_MS = 20_000
const MEMORY_POLL_MS = 1000
const RECENT_FREE_MS = 30_000

export type VideoStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface VideoEvent {
  id: string
  status: VideoStatus
  step?: number
  steps?: number
  stage?: string
  preview?: { mime: string; data: string }
  error?: string
}

export interface VideoRow {
  id: string
  recipeId: string
  params: Record<string, unknown>
  status: VideoStatus
  error: string | null
  fileBytes: number | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  kept: boolean
}

export interface VideoSettings { comfyUrl: string; freeAfterJob: boolean }

export { listensBeyondThisComputer }

/** A user-facing refusal (bad parameters, queue full); anything else is a bug. */
export class VideoRequestError extends Error {}

// Readable names for the stages a recipe goes through, by ComfyUI node class.
const STAGES: Record<string, string> = {
  UNETLoader: 'Loading the model',
  CLIPLoader: 'Loading the text encoder',
  CLIPTextEncode: 'Reading the prompt',
  SamplerCustomAdvanced: 'Generating',
  KSampler: 'Generating',
  VAEDecode: 'Decoding frames',
  LTXVLatentUpsampler: 'Upscaling',
  VAEDecodeTiled: 'Decoding frames',
  LTXVAudioVAEDecode: 'Decoding sound',
  CreateVideo: 'Assembling the video',
  SaveVideo: 'Saving',
}

interface Running {
  id: string
  client: ComfyClient
  graph: ComfyGraph
  promptId: string | null
  socket: WebSocket | null
  lastPreviewAt: number
  cancelled: boolean
  settle: (outcome: Outcome) => void
}

type Outcome = 'success' | 'cancelled' | { error: string }

export class VideoJobs {
  private readonly queue: string[] = []
  private running: Running | null = null
  // A job that has left the queue but is still in its checks (ComfyUI, pictures, nodes), so not yet running.
  // Counting it as busy stops a second press of Make video from starting alongside it; it can be stopped there too.
  private starting: { id: string; cancelled: boolean } | null = null
  private freedAt = -Infinity   // performance.now() when the last job asked ComfyUI for its memory back
  private readonly images: ImageInputs

  constructor(
    private readonly db: Database.Database,
    private readonly mediaDir: string,
    private readonly settings: () => VideoSettings,
    private readonly emit: (event: VideoEvent) => void,
    private readonly timing = { memoryWaitMs: MEMORY_WAIT_MS, memoryPollMs: MEMORY_POLL_MS, recentFreeMs: RECENT_FREE_MS },
  ) {
    mkdirSync(mediaDir, { recursive: true, mode: 0o700 })
    this.images = new ImageInputs(join(mediaDir, 'inputs'))
    // A job can't survive a restart (ComfyUI may still finish it, but nothing is listening).
    db.prepare(`UPDATE videos SET status = 'failed', error = 'Mission Control restarted while this was running.', finished_at = ?
                WHERE status IN ('queued', 'running')`).run(Date.now())
  }

  filePath(id: string): string | null {
    if (!/^[0-9a-f]{32}$/.test(id)) return null
    const row = this.db.prepare(`SELECT status FROM videos WHERE id = ? AND deleted_at IS NULL`).get(id) as { status: string } | undefined
    if (row?.status !== 'done') return null
    const path = join(this.mediaDir, `${id}.mp4`)
    return existsSync(path) ? path : null
  }

  list(limit = 50): VideoRow[] {
    const rows = this.db.prepare(`SELECT id, recipe_id AS recipeId, params, status, error, file_bytes AS fileBytes,
      created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt, kept
      FROM videos WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 200)) as Array<Omit<VideoRow, 'params' | 'kept'> & { params: string; kept: number }>
    return rows.map((r) => ({ ...r, params: JSON.parse(r.params) as Record<string, unknown>, kept: r.kept !== 0 }))
  }

  /** Stars a video so clearUnkept leaves it alone, or takes the star off. */
  keep(id: string, kept: boolean): boolean {
    if (!/^[0-9a-f]{32}$/.test(id)) return false
    return this.db.prepare(`UPDATE videos SET kept = ? WHERE id = ? AND deleted_at IS NULL`).run(kept ? 1 : 0, id).changes > 0
  }

  /**
   * Deletes the named videos that aren't starred (never one still queued or running). Only the
   * ones the page showed are named, so a video the person never saw is never cleared. Returns how many went.
   */
  clearUnkept(ids: string[]): number {
    const row = this.db.prepare(`SELECT kept FROM videos WHERE id = ? AND deleted_at IS NULL`)
    return ids.filter((id) => /^[0-9a-f]{32}$/.test(id) && (row.get(id) as { kept: number } | undefined)?.kept === 0 && this.delete(id)).length
  }

  /** The most the media folder may hold, for the page's storage bar. */
  get diskLimit(): number {
    return MAX_MEDIA_BYTES
  }

  /** Bytes used by finished videos and uploaded pictures in the media folder. */
  diskUsage(): number {
    let total = this.images.diskUsage()
    for (const name of readdirSync(this.mediaDir)) {
      if (/^[0-9a-f]{32}\.mp4$/.test(name)) total += statSync(join(this.mediaDir, name)).size
    }
    return total
  }

  /** Keeps a picture for image-to-video, after checking it. */
  uploadImage(base64: unknown): ImageInfo & { id: string } {
    if (this.diskUsage() >= MAX_MEDIA_BYTES) {
      throw new VideoRequestError(`Your videos and pictures use the full ${MAX_MEDIA_BYTES / 1024 ** 3} GB. Delete some you no longer need, then try again.`)
    }
    const saved = this.images.save(base64)
    if (typeof saved === 'string') throw new VideoRequestError(`That picture can't be used: ${saved}.`)
    return saved
  }

  // Copies each picture the job uses into ComfyUI and swaps its id for the name ComfyUI gave it.
  // Returns why it couldn't, or the values ready for the recipe.
  private async placeImages(client: ComfyClient, recipe: Recipe, values: ParamValues): Promise<ParamValues | string> {
    const placed = { ...values }
    for (const [name, spec] of Object.entries(recipe.params)) {
      if (spec.kind !== 'image' || values[name] === undefined) continue
      const stored = this.images.find(values[name])
      if (!stored) return 'The picture for this video is no longer there. Upload it again.'
      try {
        placed[name] = await client.uploadImage(readFileSync(stored.path), stored.fileName, stored.mime)
      } catch (err) {
        return err instanceof Error ? err.message : 'ComfyUI did not accept the picture.'
      }
    }
    return placed
  }

  submit(recipeId: unknown, params: unknown): string {
    const recipe = findRecipe(recipeId)
    if (!recipe) throw new VideoRequestError('There is no recipe with that name.')
    const checked = validateParams(recipe.params, params)
    if (!checked.ok) throw new VideoRequestError(checked.errors.join('; '))
    for (const [name, spec] of Object.entries(recipe.params)) {
      if (spec.kind === 'image' && checked.values[name] !== undefined && !this.images.find(checked.values[name])) {
        throw new VideoRequestError('That picture is not uploaded (or has been removed). Choose it again.')
      }
    }
    const used = this.diskUsage()
    if (used >= MAX_MEDIA_BYTES) {
      throw new VideoRequestError(`Your videos use ${(used / 1024 ** 3).toFixed(1)} GB, the limit is ${MAX_MEDIA_BYTES / 1024 ** 3} GB. Delete some you no longer need, then try again.`)
    }
    if (this.queue.length >= MAX_QUEUED) throw new VideoRequestError(`The queue is full (${MAX_QUEUED} videos waiting). Try again when some are done.`)

    // Seed 0 means "pick one": the real seed is stored so the same video can be made again.
    if (checked.values['seed'] === 0) checked.values['seed'] = randomInt(1, 2 ** 40)
    const id = randomBytes(16).toString('hex')
    this.db.prepare(`INSERT INTO videos (id, recipe_id, params, status, created_at) VALUES (?, ?, ?, 'queued', ?)`)
      .run(id, recipe.id, JSON.stringify(checked.values), Date.now())
    this.queue.push(id)
    this.emit({ id, status: 'queued' })
    void this.pump()
    return id
  }

  cancel(id: string): boolean {
    const queuedAt = this.queue.indexOf(id)
    if (queuedAt >= 0) {
      this.queue.splice(queuedAt, 1)
      this.finish(id, 'cancelled', null)
      return true
    }
    if (this.starting?.id === id) {
      this.starting.cancelled = true   // run() stops at its next step, before the job is sent to ComfyUI
      this.emit({ id, status: 'running', stage: 'Stopping' })
      return true
    }
    if (this.running?.id === id) {
      this.running.cancelled = true
      if (this.running.promptId) void this.running.client.cancel(this.running.promptId)
      this.running.settle('cancelled')
      return true
    }
    return false
  }

  // The row is kept (soft delete, like artifacts) but the file goes: videos are large, and
  // the disk cap counts every file in the media folder.
  delete(id: string): boolean {
    if (!/^[0-9a-f]{32}$/.test(id)) return false
    // Judged by the stored status, not by `running`: a finished job stays the running one for a
    // moment while the graphics memory is handed back, and its video can already be deleted.
    const deleted = this.db.prepare(`UPDATE videos SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL AND status NOT IN ('queued', 'running')`)
      .run(Date.now(), id).changes > 0
    if (deleted) rmSync(join(this.mediaDir, `${id}.mp4`), { force: true })
    return deleted
  }

  private finish(id: string, status: VideoStatus, error: string | null, fileBytes: number | null = null): void {
    this.db.prepare(`UPDATE videos SET status = ?, error = ?, file_bytes = ?, finished_at = ? WHERE id = ?`)
      .run(status, error, fileBytes, Date.now(), id)
    this.emit({ id, status, ...(error ? { error } : {}) })
  }

  private async pump(): Promise<void> {
    if (this.running || this.starting) return
    const id = this.queue.shift()
    if (!id) return
    const start = { id, cancelled: false }
    this.starting = start
    try {
      await this.run(id, start)
    } catch (err) {
      // A job stopped during its checks ends as stopped, even if ComfyUI dropped out under it.
      if (start.cancelled) return this.finish(id, 'cancelled', null)
      console.error('[video] job failed unexpectedly:', err)
      this.finish(id, 'failed', 'Something went wrong in Mission Control while making this video.')
    } finally {
      this.starting = null
      this.running = null
      void this.pump()
    }
  }

  private async run(id: string, start: { cancelled: boolean }): Promise<void> {
    const row = this.db.prepare(`SELECT recipe_id AS recipeId, params FROM videos WHERE id = ?`).get(id) as { recipeId: string; params: string }
    const recipe = findRecipe(row.recipeId)
    if (!recipe) return this.finish(id, 'failed', 'This recipe no longer exists.')
    const { comfyUrl, freeAfterJob } = this.settings()
    const checkedUrl = checkComfyUrl(comfyUrl)
    if ('error' in checkedUrl) return this.finish(id, 'failed', checkedUrl.error)
    const client = new ComfyClient(checkedUrl.url)

    this.db.prepare(`UPDATE videos SET status = 'running', started_at = ? WHERE id = ?`).run(Date.now(), id)
    this.emit({ id, status: 'running', stage: 'Checking ComfyUI' })

    // Stopped during the checks: Stop was pressed while this was still starting (see cancel).
    const stopped = () => start.cancelled

    const problem = await this.preflight(id, start, client, recipe, comfyUrl)
    if (stopped()) return this.finish(id, 'cancelled', null)
    if (problem) return this.finish(id, 'failed', problem)

    const values = await this.placeImages(client, recipe, JSON.parse(row.params) as ParamValues)
    if (stopped()) return this.finish(id, 'cancelled', null)
    if (typeof values === 'string') return this.finish(id, 'failed', values)
    const graph = recipe.build(values, `mission-control/${id}`)
    const missing = await client.missing(nodeClasses(graph), recipe.models)
    if (stopped()) return this.finish(id, 'cancelled', null)
    if (missing.length > 0) {
      return this.finish(id, 'failed', `ComfyUI is missing what this recipe needs: ${missing.join(', ')}.`)
    }

    const outcome = await new Promise<Outcome>((resolve) => {
      let settled = false
      const job: Running = {
        id, client, graph, promptId: null, socket: null, lastPreviewAt: 0, cancelled: false,
        settle: (o) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(o)
        },
      }
      const timer = setTimeout(() => {
        if (job.promptId) void client.cancel(job.promptId)
        job.settle({ error: 'The video took longer than 30 minutes, so it was stopped.' })
      }, JOB_TIMEOUT_MS)
      this.running = job
      this.starting = null
      void this.start(job)
    })

    const job = this.running!
    job.socket?.close()
    try {
      if (outcome === 'cancelled' || job.cancelled) return this.finish(id, 'cancelled', null)
      if (typeof outcome === 'object') return this.finish(id, 'failed', outcome.error)
      this.emit({ id, status: 'running', stage: 'Fetching the video' })
      await this.collect(job)
    } finally {
      if (freeAfterJob) {
        await client.free()
        this.freedAt = performance.now()
      }
    }
  }

  // Refuses to run when ComfyUI is not there, is open to the network, or the card is too full. Straight after another
  // job, a card that is too full is asked again for a short while first, as that job's memory may still be on its way back.
  private async preflight(id: string, start: { cancelled: boolean }, client: ComfyClient, recipe: { minFreeVramGb: number }, comfyUrl: string): Promise<string | null> {
    const justFreed = performance.now() - this.freedAt < this.timing.recentFreeMs
    const giveUpAt = justFreed ? performance.now() + this.timing.memoryWaitMs : 0
    let announced = false
    while (true) {
      let stats
      try { stats = await client.stats() } catch { stats = null }
      if (!stats) return `ComfyUI isn't answering at ${comfyUrl}. Start it, or fix the address in Settings, then try again.`
      if (listensBeyondThisComputer(stats.argv)) {
        return 'ComfyUI is open to your network (it was started with --listen). Restart it without --listen so only this computer can use it.'
      }
      const freeGb = stats.device ? stats.device.vramFree / 1024 ** 3 : Infinity
      if (freeGb >= recipe.minFreeVramGb) {
        if (announced) this.emit({ id, status: 'running', stage: 'Getting the video ready' })
        return null
      }
      if (performance.now() >= giveUpAt) {
        return `Not enough free graphics memory: ${freeGb.toFixed(1)} GB free, this recipe needs about ${recipe.minFreeVramGb} GB. Unload other models (for example in LM Studio) and try again.`
      }
      if (!announced) this.emit({ id, status: 'running', stage: 'Waiting for graphics memory' })
      announced = true
      await new Promise((resolve) => setTimeout(resolve, this.timing.memoryPollMs))
      if (start.cancelled) return null   // run() finishes a stopped job; checked before asking ComfyUI again
    }
  }

  private async start(job: Running): Promise<void> {
    const done = job.settle
    const socket = job.client.listen(job.id, (msg) => this.onMessage(job, msg), () => {
      // The live stream dropped: keep checking the job's history until it finishes.
      if (job.promptId) void this.pollUntilDone(job)
    })
    job.socket = socket
    await new Promise<void>((resolve) => {
      socket.once('open', () => resolve())
      socket.once('close', () => resolve())
    })
    if (job.cancelled) return done('cancelled')
    try {
      job.promptId = await job.client.submit(job.graph, job.id)
      // Stopped while the job was being handed over: make sure ComfyUI drops it too.
      if (job.cancelled) return void job.client.cancel(job.promptId)
    } catch (err) {
      return done({ error: err instanceof Error ? err.message : 'ComfyUI refused the job.' })
    }
    if (socket.readyState !== socket.OPEN) void this.pollUntilDone(job)
  }

  private onMessage(job: Running, msg: ComfyMessage): void {
    const done = job.settle
    if (msg.type === 'preview') {
      // Previews carry no job id; there is only ever one job running, and it must have started.
      const now = Date.now()
      if (!job.promptId || now - job.lastPreviewAt < PREVIEW_MIN_INTERVAL_MS) return
      job.lastPreviewAt = now
      this.emit({ id: job.id, status: 'running', preview: { mime: msg.preview.mime, data: Buffer.from(msg.preview.image).toString('base64') } })
      return
    }
    if (msg.promptId !== job.promptId) return
    switch (msg.type) {
      case 'progress': {
        const stage = msg.node ? STAGES[job.graph[msg.node]?.class_type ?? ''] : undefined
        this.emit({ id: job.id, status: 'running', step: msg.value, steps: msg.max, ...(stage ? { stage } : {}) })
        break
      }
      case 'executing':
        if (msg.node === null) done('success')
        else {
          const stage = STAGES[job.graph[msg.node]?.class_type ?? '']
          if (stage) this.emit({ id: job.id, status: 'running', stage })
        }
        break
      case 'success': done('success'); break
      case 'interrupted': done('cancelled'); break
      case 'error': done({ error: `ComfyUI stopped with an error${msg.nodeType ? ` in ${msg.nodeType}` : ''}: ${msg.message}` }); break
    }
  }

  private async pollUntilDone(job: Running): Promise<void> {
    while (this.running === job && job.promptId) {
      await new Promise((r) => setTimeout(r, POLL_MS))
      try {
        if ((await job.client.outputs(job.promptId)).length > 0) return job.settle('success')
      } catch {
        // ComfyUI busy or restarting: keep trying until the job timeout.
      }
    }
  }

  private async collect(job: Running): Promise<void> {
    const files = await job.client.outputs(job.promptId!)
    if (files.length === 0) return this.finish(job.id, 'failed', 'ComfyUI finished but saved no video.')
    const raw = await job.client.download(files[0]!, MAX_VIDEO_BYTES)
    const clean = stripMp4Metadata(raw)
    if (!clean) return this.finish(job.id, 'failed', 'ComfyUI sent back something that is not an MP4 video.')
    writeFileSync(join(this.mediaDir, `${job.id}.mp4`), clean.data, { mode: 0o600 })
    this.finish(job.id, 'done', null, clean.data.length)
  }
}
