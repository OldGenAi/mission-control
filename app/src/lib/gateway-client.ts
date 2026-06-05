// GatewayClient — WebSocket connection to the Mission Control gateway.
//
// Protocol:
//   1. Server sends: {type:"event", event:"connect.challenge", payload:{nonce}}
//   2. Client sends: {type:"req", id, method:"connect", params:{token, nonce}}
//   3. Server sends: {type:"res", id, ok:true, payload:{type:"hello-ok", features:{...}}}
//   4. Bidirectional req/res + push events from here on.
//
// Module-level singleton — React StrictMode safe.

const WS_URL  = (import.meta.env.VITE_MC_GATEWAY_URL  as string | undefined) ?? 'ws://127.0.0.1:4747'
const TOKEN   = (import.meta.env.VITE_MC_TOKEN         as string | undefined) ?? ''

// ---------- types -------------------------------------------------

export interface HelloOk {
  type: 'hello-ok'
  features: { methods: string[]; events: string[] }
}

export interface GatewayEvent {
  type: 'event'
  event: string
  payload?: Record<string, unknown>
  seq?: number
}

type EventListener = (event: GatewayEvent) => void

interface PendingRequest {
  method: string
  resolve: (payload: unknown) => void
  reject: (err: Error) => void
}

// ---------- client ------------------------------------------------

class GatewayClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingRequest>()
  private listeners = new Set<EventListener>()
  private hello: HelloOk | null = null
  private connectPromise: Promise<HelloOk> | null = null
  private connectResolve: ((h: HelloOk) => void) | null = null
  private connectReject: ((e: Error) => void) | null = null

  async connect(): Promise<HelloOk> {
    if (this.hello) return this.hello
    if (this.connectPromise) return this.connectPromise

    this.connectPromise = new Promise<HelloOk>((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
    })

    const ws = new WebSocket(WS_URL)
    this.ws = ws

    ws.addEventListener('message', (e: MessageEvent) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(e.data as string) as Record<string, unknown> }
      catch { return }

      // Challenge → send connect req
      if (msg['type'] === 'event' && msg['event'] === 'connect.challenge') {
        const nonce = (msg['payload'] as Record<string, unknown> | undefined)?.['nonce'] ?? ''
        const id = crypto.randomUUID()
        this.pending.set(id, {
          method: 'connect',
          resolve: (payload) => {
            this.hello = payload as HelloOk
            this.connectResolve?.(this.hello)
          },
          reject: (err) => this.connectReject?.(err),
        })
        ws.send(JSON.stringify({ type: 'req', id, method: 'connect', params: { token: TOKEN, nonce } }))
        return
      }

      // Response → resolve / reject pending
      if (msg['type'] === 'res') {
        const pend = this.pending.get(msg['id'] as string)
        if (!pend) return
        this.pending.delete(msg['id'] as string)
        if (msg['ok']) pend.resolve(msg['payload'])
        else pend.reject(new Error(((msg['error'] as Record<string, unknown> | undefined)?.['message'] as string | undefined) ?? 'gateway error'))
        return
      }

      // Push event → broadcast to subscribers
      if (msg['type'] === 'event') {
        const ev = msg as unknown as GatewayEvent
        for (const l of this.listeners) {
          try { l(ev) } catch (err) { console.error('[gateway] listener error:', err) }
        }
      }
    })

    ws.addEventListener('close', (e: CloseEvent) => {
      const err = new Error(`gateway closed (${e.code})`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.connectReject?.(err)
      this.ws = null
      this.hello = null
      this.connectPromise = null
    })

    ws.addEventListener('error', () => {
      const err = new Error('gateway connection error')
      this.connectReject?.(err)
    })

    return this.connectPromise
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.connect()
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('gateway not connected')
    const id = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: (p) => resolve(p as T), reject })
      ws.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const gateway = new GatewayClient()
