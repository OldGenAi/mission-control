// Run with: npm test
// Local-model calls pass through the card sharing's gate (src/providers/card-share.ts) before reaching the server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { LocalProvider } from '../src/providers/local.js'
import type { StreamChunk } from '../src/providers/types.js'

async function withServer(run: (baseUrl: string, requests: () => number) => Promise<void>): Promise<void> {
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, () => requests)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// A gate that holds every call until open() is called, and counts releases.
function heldGate() {
  let open!: () => void
  const opened = new Promise<void>((r) => { open = r })
  let released = 0
  return {
    gate: {
      enter: async (signal?: AbortSignal) => {
        await new Promise<void>((resolve, reject) => {
          void opened.then(resolve)
          signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
        })
        return () => { released++ }
      },
    },
    open: () => open(),
    released: () => released,
  }
}

test('a local call waits at the gate, then runs, and lets go of the gate when it ends', async () => {
  await withServer(async (baseUrl, requests) => {
    const held = heldGate()
    const provider = new LocalProvider({ baseUrl, gate: held.gate })
    const chunks: StreamChunk[] = []
    const run = (async () => { for await (const c of provider.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }], correlationId: 't' })) chunks.push(c) })()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(requests(), 0, 'nothing reaches the server while the gate is shut')
    held.open()
    await run
    assert.equal(requests(), 1)
    assert.ok(chunks.some((c) => c.type === 'text_delta'))
    assert.equal(held.released(), 1)
  })
})

test('a gate that fails for any other reason gives an error, not an empty reply', async () => {
  await withServer(async (baseUrl, requests) => {
    const provider = new LocalProvider({ baseUrl, gate: { enter: async () => { throw new Error('broken') } } })
    const chunks: StreamChunk[] = []
    for await (const c of provider.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }], correlationId: 't' })) chunks.push(c)
    assert.equal(requests(), 0)
    assert.match((chunks.at(-1) as { error?: string }).error ?? '', /broken/)
  })
})

test('a local call stopped while it waits ends quietly and never reaches the server', async () => {
  await withServer(async (baseUrl, requests) => {
    const held = heldGate()
    const provider = new LocalProvider({ baseUrl, gate: held.gate })
    const stop = new AbortController()
    const chunks: StreamChunk[] = []
    const run = (async () => { for await (const c of provider.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }], correlationId: 't', signal: stop.signal })) chunks.push(c) })()
    await new Promise((r) => setTimeout(r, 20))
    stop.abort()
    await run
    assert.equal(requests(), 0)
    assert.deepEqual(chunks, [{ type: 'done', usage: { inputTokens: 0, outputTokens: 0 } }], 'a clean stop, not an error')
    assert.equal(held.released(), 0, 'nothing to let go of')
  })
})
