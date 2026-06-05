#!/usr/bin/env node
/**
 * endurance.mjs — controlled concurrency ramp for pipeline runtime.
 *
 * Reads gateway token from ~/.missioncontrol/config.json, opens an authenticated
 * WS to ws://127.0.0.1:4747, fires N concurrent `pipelines.run` calls of the
 * `summarise_url` pipeline against https://example.com, then polls each run's
 * status until terminal. Prints a per-wave table: runId | status | duration ms |
 * tokens | error.
 *
 * Usage:
 *   node scripts/endurance.mjs                  # waves 1,2,3,4 (default)
 *   node scripts/endurance.mjs 2 4 6            # custom wave sizes
 */

import WebSocket from 'ws'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const TOKEN = JSON.parse(readFileSync(join(homedir(), '.missioncontrol', 'config.json'), 'utf-8')).token
const URL_ = 'ws://127.0.0.1:4747'
const PIPELINE = 'summarise_url'
const TARGET_URL = 'https://example.com'
const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS  = 10 * 60_000   // 10 min ceiling per run

const waves = process.argv.slice(2).map(Number).filter(n => n > 0)
const PLAN = waves.length ? waves : [1, 2, 3, 4]

// ---------------------------------------------------------------------------
// Minimal JSON-RPC WS client with auth handshake
// ---------------------------------------------------------------------------

class GatewayClient {
  constructor() {
    this.ws = null
    this.nextId = 1
    this.pending = new Map() // id -> {resolve, reject}
    this.events = []         // captured push events
    this.connected = false
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(URL_, { headers: { Origin: 'http://127.0.0.1' } })
      this.ws = ws

      const onChallenge = (nonce) => {
        // Send connect handshake
        this.call('connect', { token: TOKEN, nonce })
          .then(() => { this.connected = true; resolve() })
          .catch(reject)
      }

      ws.on('open', () => { /* wait for challenge event */ })
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'event') {
          if (msg.event === 'connect.challenge') onChallenge(msg.payload.nonce)
          else this.events.push({ t: Date.now(), event: msg.event, payload: msg.payload })
        } else if (msg.type === 'res') {
          const p = this.pending.get(msg.id)
          if (p) {
            this.pending.delete(msg.id)
            if (msg.ok) p.resolve(msg.payload)
            else p.reject(new Error(msg.error?.message || 'rpc error'))
          }
        }
      })
      ws.on('error', reject)
      ws.on('close', () => { this.connected = false })
    })
  }

  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = String(this.nextId++)
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`rpc timeout: ${method}`))
        }
      }, 60_000)
    })
  }

  close() { try { this.ws?.close() } catch {} }
}

// ---------------------------------------------------------------------------
// Wave runner
// ---------------------------------------------------------------------------

async function runWave(client, n) {
  console.log(`\n=== Wave: ${n} concurrent run${n > 1 ? 's' : ''} ===`)
  const t0 = Date.now()

  // Fire all N pipelines.run calls in parallel
  const starts = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const startedAt = Date.now()
      try {
        const res = await client.call('pipelines.run', {
          name: PIPELINE,
          context: { task: TARGET_URL, label: `wave${n}-#${i + 1}` },
        })
        return { idx: i + 1, runId: res.runId, startedAt, error: null }
      } catch (e) {
        return { idx: i + 1, runId: null, startedAt, error: e.message }
      }
    })
  )

  for (const s of starts) {
    if (s.error) console.log(`  start #${s.idx}: ERROR ${s.error}`)
    else         console.log(`  start #${s.idx}: ${s.runId}`)
  }

  // Poll each run to terminal
  const results = await Promise.all(starts.map(async (s) => {
    if (s.error || !s.runId) return { ...s, status: 'start-failed', durationMs: 0 }
    const deadline = s.startedAt + POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
      try {
        const st = await client.call('pipelines.status', { runId: s.runId })
        const run = st.run
        if (!run) continue
        if (['completed', 'failed', 'aborted'].includes(run.status)) {
          return {
            ...s,
            status:     run.status,
            durationMs: Date.now() - s.startedAt,
            tokens:     run.tokensUsed ?? 0,
            costUsd:    run.costUsdUsed ?? 0,
            error:      run.error ?? null,
          }
        }
      } catch (e) {
        // transient — keep polling
      }
    }
    return { ...s, status: 'poll-timeout', durationMs: Date.now() - s.startedAt }
  }))

  const waveMs = Date.now() - t0
  console.log(`  --- wave finished in ${(waveMs / 1000).toFixed(1)}s ---`)
  console.log('  results:')
  for (const r of results) {
    const dur = (r.durationMs / 1000).toFixed(1) + 's'
    const tok = r.tokens != null ? r.tokens : '-'
    const err = r.error ? ` err="${String(r.error).slice(0, 80)}"` : ''
    console.log(`    #${r.idx}  ${r.status.padEnd(13)} ${dur.padStart(7)}  tokens=${tok}${err}`)
  }

  const ok    = results.filter(r => r.status === 'completed').length
  const fail  = results.filter(r => r.status !== 'completed').length
  console.log(`  summary: ${ok}/${n} ok, ${fail} not-ok`)
  return { n, waveMs, results, ok, fail }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`endurance ramp — pipeline=${PIPELINE}  url=${TARGET_URL}  plan=[${PLAN.join(', ')}]`)
  const client = new GatewayClient()
  await client.connect()
  console.log('connected & authed')

  const summary = []
  for (const n of PLAN) {
    const result = await runWave(client, n)
    summary.push(result)
    // Stop early if a wave had failures — surfaces the ceiling cleanly
    if (result.fail > 0 && n < PLAN[PLAN.length - 1]) {
      console.log(`\n!! wave ${n} had ${result.fail} failure(s); stopping ramp.`)
      break
    }
    // Brief inter-wave cool-down so we measure each wave from cold-ish state
    if (PLAN.indexOf(n) < PLAN.length - 1) {
      console.log('  ...cooling 10s before next wave...')
      await new Promise(r => setTimeout(r, 10_000))
    }
  }

  console.log('\n=== FINAL ===')
  for (const w of summary) {
    console.log(`  wave ${w.n}: ${w.ok}/${w.n} ok  total=${(w.waveMs/1000).toFixed(1)}s`)
  }

  // Surface push events received during the test (proactive-notify visibility)
  const notifyEvents = client.events.filter(e =>
    ['chat.final', 'pipeline.tick', 'sessions.changed'].includes(e.event)
  )
  console.log(`\nclient saw ${client.events.length} push events total (${notifyEvents.length} relevant).`)

  client.close()
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
