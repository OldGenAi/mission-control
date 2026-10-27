// Shares the graphics card between the local model server (LM Studio) and videos, on its own.
//
// A video only takes the card from the local model when the card can't hold both (the video queue asks here
// when free memory is short). Then chats and pipelines are held at the gate, the local calls already running
// finish, the loaded models are noted and unloaded. They stay unloaded while videos are made, and come back
// with the same settings only when they are needed: the Chat page is opened, or a local call arrives once the
// videos are done. Only models taken away here are ever loaded; nothing loaded at the start means nothing is
// loaded afterwards. The note is kept on disk, so a restart of Mission Control still puts them back.
//
// Security-sensitive. Do not modify without Claude review.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'

/** The load settings LM Studio reports for a loaded model and accepts back when loading one, by type. */
export const LOAD_SETTINGS = {
  context_length: 'number',
  eval_batch_size: 'number',
  num_experts: 'number',
  flash_attention: 'boolean',
  offload_kv_cache_to_gpu: 'boolean',
} as const

export type LoadConfig = { -readonly [K in keyof typeof LOAD_SETTINGS]?: (typeof LOAD_SETTINGS)[K] extends 'number' ? number : boolean }

export interface LoadedModel {
  model: string        // the model's key, used to load it again
  instanceId: string   // the loaded copy, used to unload it
  config: LoadConfig
}

/** The model server's controls (lmstudio-control.ts). listLoaded answers null when it can't tell: not LM Studio, or refused. */
export interface ModelServer {
  listLoaded(): Promise<LoadedModel[] | null>
  unload(instanceId: string): Promise<boolean>
  load(model: LoadedModel): Promise<boolean>
}

/** What the Chat page is told: models held for videos, being loaded back, or that could not be loaded back. */
export type CardShareEvent = { state: 'free' } | { state: 'held' | 'restoring' | 'restore-failed'; models: string[] }

export interface CardShareOptions {
  server: () => ModelServer | null
  freeVideoMemory: () => Promise<void>   // asks ComfyUI for its memory back before a model is loaded again
  notePath: string
  emit: (event: CardShareEvent) => void
  pollMs?: number
  drainTimeoutMs?: number
}

// How long a video waits for the local calls already running before it gives up.
const DRAIN_TIMEOUT_MS = 10 * 60 * 1000
const POLL_MS = 250
const MAX_NOTE_BYTES = 64 * 1024
const MAX_ID_LENGTH = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

/** The known load settings in a value, each of the right type; anything else is dropped. */
export function pickLoadConfig(value: unknown): LoadConfig {
  const config: Record<string, unknown> = {}
  if (!isRecord(value)) return config
  for (const [name, kind] of Object.entries(LOAD_SETTINGS)) {
    const setting = value[name]
    if (kind === 'number' ? typeof setting === 'number' && Number.isInteger(setting) && setting > 0 : typeof setting === 'boolean') config[name] = setting
  }
  return config as LoadConfig
}

/** A well-formed model entry, or null. */
export function toLoadedModel(value: unknown): LoadedModel | null {
  if (!isRecord(value) || !isId(value['model']) || !isId(value['instanceId'])) return null
  return { model: value['model'], instanceId: value['instanceId'], config: pickLoadConfig(value['config']) }
}

// The note of models taken away; a missing or damaged note means none.
function readNote(path: string): LoadedModel[] {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_NOTE_BYTES) return []
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isRecord(parsed) || !Array.isArray(parsed['models'])) return []
    return parsed['models'].map(toLoadedModel).filter((m): m is LoadedModel => m !== null)
  } catch {
    return []
  }
}

export class CardShare {
  private inFlight = 0              // local calls let through and not yet finished
  private draining = false          // a video is waiting for those calls; new ones wait too
  private videoBusy = false         // a video is running or queued
  private taken: LoadedModel[]      // models unloaded for videos and not yet loaded back
  private failed: string[] = []     // models that could not be loaded back, until the next video
  private restoring: Promise<void> | null = null
  private readonly wakers = new Set<() => void>()
  private readonly pollMs: number
  private readonly drainTimeoutMs: number

  constructor(private readonly opts: CardShareOptions) {
    this.pollMs = opts.pollMs ?? POLL_MS
    this.drainTimeoutMs = opts.drainTimeoutMs ?? DRAIN_TIMEOUT_MS
    this.taken = readNote(opts.notePath)
  }

  state(): CardShareEvent {
    const models = this.taken.map((m) => m.model)
    if (this.restoring) return { state: 'restoring', models }
    if (this.taken.length > 0) return { state: 'held', models }
    if (this.failed.length > 0) return { state: 'restore-failed', models: [...this.failed] }
    return { state: 'free' }
  }

  /**
   * Lets a local-model call through, once the card is not held for videos (putting back what videos took
   * first). Resolves with the function the call runs when it ends; rejects if the call is stopped while waiting.
   */
  async enter(signal?: AbortSignal): Promise<() => void> {
    for (;;) {
      if (signal?.aborted) throw new Error('stopped')
      if (this.draining || (this.taken.length > 0 && this.videoBusy)) {
        await this.sleep(signal)
        continue
      }
      if (this.restoring || this.taken.length > 0) {
        await this.restore()
        continue
      }
      this.inFlight++
      let ended = false
      return () => {
        if (ended) return
        ended = true
        this.inFlight--
        this.wake()
      }
    }
  }

  /** The video queue says whether a video is running or waiting. */
  setVideoBusy(busy: boolean): void {
    if (this.videoBusy === busy) return
    this.videoBusy = busy
    if (!busy) this.wake()
  }

  /**
   * Unloads the local server's models so a video fits, after the local calls already running finish. 'nothing'
   * when there was nothing to unload (or the server can't say), or the video was stopped while waiting.
   */
  async makeRoom(stopped: () => boolean, onStage: (stage: string) => void): Promise<'unloaded' | 'nothing' | { error: string }> {
    if (this.restoring) await this.restoring
    const server = this.opts.server()
    if (!server) return 'nothing'
    const before = await server.listLoaded()
    if (!before || before.length === 0) return 'nothing'

    this.draining = true
    try {
      const giveUpAt = Date.now() + this.drainTimeoutMs
      if (this.inFlight > 0) onStage('Waiting for a chat to finish')
      while (this.inFlight > 0) {
        if (stopped()) return 'nothing'
        if (Date.now() >= giveUpAt) {
          return { error: `A chat or pipeline was still using the local model after ${Math.round(this.drainTimeoutMs / 60_000)} minutes, so the video was not started. Try again when it has finished.` }
        }
        await this.sleep()
      }
      if (stopped()) return 'nothing'

      // Asked again: what is loaded may have changed while those calls finished.
      const loaded = (await server.listLoaded()) ?? []
      let unloaded = false
      for (const m of loaded) {
        if (this.taken.some((t) => t.instanceId === m.instanceId)) continue
        if (await server.unload(m.instanceId)) {
          this.taken.push(m)
          this.saveNote()
          unloaded = true
        }
      }
      if (unloaded) {
        this.failed = []
        this.opts.emit(this.state())
      }
      return unloaded ? 'unloaded' : 'nothing'
    } finally {
      this.draining = false
      this.wake()
    }
  }

  /** The Chat page was opened: put back what videos took, unless a video still needs the card. */
  restoreNow(): void {
    if ((this.taken.length > 0 || this.restoring) && !this.videoBusy && !this.draining) void this.restore()
  }

  private restore(): Promise<void> {
    this.restoring ??= this.loadBack().finally(() => {
      this.restoring = null
      this.wake()
      this.opts.emit(this.state())
    })
    return this.restoring
  }

  private async loadBack(): Promise<void> {
    const models = [...this.taken]
    this.opts.emit({ state: 'restoring', models: models.map((m) => m.model) })
    try { await this.opts.freeVideoMemory() } catch { /* ComfyUI not running: its memory is free anyway */ }
    const server = this.opts.server()
    const failed: string[] = []
    for (const m of models) {
      let loaded = false
      try { loaded = server !== null && await server.load(m) } catch { loaded = false }
      if (!loaded) failed.push(m.model)
    }
    // Cleared either way: a model that would not load is named to the person instead of being tried on every call.
    this.taken = this.taken.filter((m) => !models.includes(m))
    this.failed = failed
    this.saveNote()
    if (failed.length > 0) console.warn(`[card-share] could not load back after the video: ${failed.join(', ')}`)
  }

  private saveNote(): void {
    try {
      const tmp = `${this.opts.notePath}.tmp`
      writeFileSync(tmp, JSON.stringify({ models: this.taken }), { mode: 0o600 })
      renameSync(tmp, this.opts.notePath)
    } catch (err) {
      console.warn('[card-share] could not save the note of unloaded models:', err instanceof Error ? err.message : String(err))
    }
  }

  // Waits until something changes (a call ends, the videos finish, a restore ends), or a short while.
  private sleep(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer)
        this.wakers.delete(done)
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => {
        clearTimeout(timer)
        this.wakers.delete(done)
        reject(new Error('stopped'))
      }
      const timer = setTimeout(done, this.pollMs)
      this.wakers.add(done)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private wake(): void {
    for (const waker of [...this.wakers]) waker()
  }
}
