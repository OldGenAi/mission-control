// Talks to a ComfyUI running on this computer: queue a recipe's graph, follow its progress
// and previews, fetch the finished file.
//
// Security-sensitive. Do not modify without Claude review.
//
// - Loopback addresses only, and redirects are refused, so a job can never be sent elsewhere.
// - ComfyUI has no sign-in and anything on this computer can use its port, so every reply is
//   treated as untrusted: shapes are checked, sizes capped, file names re-checked.
// - Nothing secret (keys, the gateway token) is ever sent to it.

import WebSocket from 'ws'
import { parseComfyBinary, type ComfyPreview } from './comfy-binary.js'
import type { ComfyGraph } from './recipes.js'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_JSON_BYTES = 4 * 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
// What ComfyUI's /view accepts as a name: no separators, no "..", nothing hidden.
const SAFE_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.\- ]{0,200}$/
const SAFE_SUBFOLDER = /^(?:[A-Za-z0-9_\-]{1,100}(?:\/[A-Za-z0-9_\-]{1,100}){0,4})?$/

export interface ComfyStats {
  version: string
  /** ComfyUI's own start-up flags, to check how it was started. */
  argv: string[]
  device: { name: string; vramTotal: number; vramFree: number } | null
}

export interface ComfyOutputFile { filename: string; subfolder: string; type: 'output' }

export type ComfyMessage =
  | { type: 'progress'; promptId: string; value: number; max: number; node: string | null }
  | { type: 'executing'; promptId: string; node: string | null }
  | { type: 'started'; promptId: string }
  | { type: 'success'; promptId: string }
  | { type: 'error'; promptId: string; message: string; nodeType: string | null }
  | { type: 'interrupted'; promptId: string }
  | { type: 'preview'; preview: ComfyPreview }

/** The base URL, or an error message when it is not a plain loopback http(s) address. */
export function checkComfyUrl(raw: unknown): { url: URL } | { error: string } {
  if (typeof raw !== 'string' || raw.length > 200) return { error: 'The ComfyUI address must be text.' }
  let url: URL
  try { url = new URL(raw) } catch { return { error: 'The ComfyUI address is not a valid web address.' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'The ComfyUI address must start with http:// or https://.' }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return { error: 'ComfyUI must run on this computer (127.0.0.1 or localhost).' }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    return { error: 'The ComfyUI address must be just the address and port, like http://127.0.0.1:8188.' }
  }
  return { url }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 500 ? value : null
}

/** Turns one JSON message from ComfyUI's WebSocket into what Mission Control uses, or null. */
export function parseComfyJson(text: string): ComfyMessage | null {
  let msg: unknown
  try { msg = JSON.parse(text) } catch { return null }
  if (!isRecord(msg) || !isRecord(msg.data)) return null
  const data = msg.data
  const promptId = str(data.prompt_id)
  if (!promptId) return null
  switch (msg.type) {
    case 'progress': {
      const { value, max } = data
      if (typeof value !== 'number' || typeof max !== 'number' || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null
      return { type: 'progress', promptId, value: Math.max(0, Math.min(value, max)), max, node: str(data.node) }
    }
    case 'executing':
      return { type: 'executing', promptId, node: data.node === null ? null : str(data.node) }
    case 'execution_start':
      return { type: 'started', promptId }
    case 'execution_success':
      return { type: 'success', promptId }
    case 'execution_error':
      return { type: 'error', promptId, message: (str(data.exception_message) ?? 'ComfyUI reported an error.').slice(0, 300), nodeType: str(data.node_type) }
    case 'execution_interrupted':
      return { type: 'interrupted', promptId }
    default:
      return null
  }
}

export class ComfyClient {
  constructor(readonly base: URL) {}

  private async request(path: string, init: RequestInit = {}, maxBytes = MAX_JSON_BYTES): Promise<{ status: number; body: Buffer }> {
    const res = await fetch(new URL(path, this.base), {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > maxBytes) throw new Error('ComfyUI sent more data than expected.')
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length > maxBytes) throw new Error('ComfyUI sent more data than expected.')
    return { status: res.status, body }
  }

  private async json(path: string, init?: RequestInit): Promise<{ status: number; value: unknown }> {
    const { status, body } = await this.request(path, init)
    try { return { status, value: JSON.parse(body.toString('utf-8')) } } catch { return { status, value: null } }
  }

  private post(path: string, payload: unknown): Promise<{ status: number; value: unknown }> {
    return this.json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  }

  /** Version, start-up flags and graphics memory, or null when this doesn't look like ComfyUI. */
  async stats(): Promise<ComfyStats | null> {
    const { status, value } = await this.json('/system_stats')
    if (status !== 200 || !isRecord(value) || !isRecord(value.system)) return null
    const version = str(value.system.comfyui_version)
    if (!version) return null
    const argv = Array.isArray(value.system.argv) ? value.system.argv.filter((a): a is string => typeof a === 'string').slice(0, 100) : []
    const first = Array.isArray(value.devices) ? value.devices[0] : undefined
    const device = isRecord(first) && typeof first.vram_total === 'number' && typeof first.vram_free === 'number'
      ? { name: str(first.name) ?? 'unknown', vramTotal: first.vram_total, vramFree: first.vram_free }
      : null
    return { version, argv, device }
  }

  /** The node classes and model files from the list that this ComfyUI does not have. */
  async missing(nodes: readonly string[], models: ReadonlyArray<{ folder: string; file: string }>): Promise<string[]> {
    const gaps: string[] = []
    for (const node of nodes) {
      const { status, value } = await this.json(`/object_info/${encodeURIComponent(node)}`)
      if (status !== 200 || !isRecord(value) || !isRecord(value[node])) gaps.push(`node ${node}`)
    }
    const folders = new Map<string, string[]>()
    for (const { folder, file } of models) {
      if (!folders.has(folder)) {
        const { status, value } = await this.json(`/models/${encodeURIComponent(folder)}`)
        folders.set(folder, status === 200 && Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
      }
      if (!folders.get(folder)!.includes(file)) gaps.push(`model ${folder}/${file}`)
    }
    return gaps
  }

  /** Queues a graph; returns ComfyUI's prompt id. */
  async submit(graph: ComfyGraph, clientId: string): Promise<string> {
    const { status, value } = await this.post('/prompt', { prompt: graph, client_id: clientId })
    if (status === 200 && isRecord(value)) {
      const id = str(value.prompt_id)
      if (id && /^[A-Za-z0-9-]{1,64}$/.test(id)) return id
    }
    const reason = isRecord(value) && isRecord(value.error) ? str(value.error.message) : null
    throw new Error(`ComfyUI refused the job${reason ? `: ${reason.slice(0, 200)}` : '.'}`)
  }

  // Both requests are best effort: the job is already marked stopped on our side, and a
  // ComfyUI that has gone away has nothing left to stop. The failure is still logged.
  private async tryPost(path: string, payload: unknown): Promise<void> {
    try {
      await this.post(path, payload)
    } catch (err) {
      console.warn(`[video] ComfyUI did not answer ${path}:`, err instanceof Error ? err.message : err)
    }
  }

  /** Stops a queued job (removes it) or a running one (interrupts it). */
  async cancel(promptId: string): Promise<void> {
    await this.tryPost(`/api/jobs/${encodeURIComponent(promptId)}/cancel`, {})
    await this.tryPost('/interrupt', { prompt_id: promptId })
  }

  /** The video files a finished job saved. */
  async outputs(promptId: string): Promise<ComfyOutputFile[]> {
    const { status, value } = await this.json(`/history/${encodeURIComponent(promptId)}`)
    const entry = status === 200 && isRecord(value) ? value[promptId] : undefined
    if (!isRecord(entry) || !isRecord(entry.outputs)) return []
    const files: ComfyOutputFile[] = []
    for (const nodeOutput of Object.values(entry.outputs)) {
      if (!isRecord(nodeOutput)) continue
      for (const key of ['images', 'videos', 'gifs']) {
        const items = nodeOutput[key]
        if (!Array.isArray(items)) continue
        for (const item of items) {
          if (!isRecord(item) || item.type !== 'output') continue
          const filename = str(item.filename)
          const subfolder = typeof item.subfolder === 'string' ? item.subfolder : ''
          if (!filename || !SAFE_FILE.test(filename) || filename.includes('..') || !SAFE_SUBFOLDER.test(subfolder)) continue
          // Mission Control keeps and strips MP4 only.
          if (!/\.mp4$/i.test(filename)) continue
          files.push({ filename, subfolder, type: 'output' })
        }
      }
    }
    return files
  }

  /** Downloads one output file, refusing anything over maxBytes. */
  async download(file: ComfyOutputFile, maxBytes: number): Promise<Buffer> {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type })
    const { status, body } = await this.request(`/view?${query}`, {}, maxBytes)
    if (status !== 200) throw new Error('ComfyUI did not send the finished video.')
    return body
  }

  /** Asks ComfyUI to give its graphics memory back. */
  async free(): Promise<void> {
    await this.tryPost('/free', { unload_models: true, free_memory: true })
  }

  /** Opens ComfyUI's live event stream for this client id. */
  listen(clientId: string, onMessage: (msg: ComfyMessage) => void, onClose: () => void): WebSocket {
    const wsUrl = new URL(`/ws?clientId=${encodeURIComponent(clientId)}`, this.base)
    wsUrl.protocol = this.base.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(wsUrl, { maxPayload: 8 * 1024 * 1024, followRedirects: false, handshakeTimeout: REQUEST_TIMEOUT_MS })
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
        const preview = parseComfyBinary(bytes)
        if (preview) onMessage({ type: 'preview', preview })
        return
      }
      const parsed = parseComfyJson(data.toString())
      if (parsed) onMessage(parsed)
    })
    socket.on('close', onClose)
    socket.on('error', () => socket.terminate())
    return socket
  }
}
