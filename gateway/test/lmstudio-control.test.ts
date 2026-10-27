// Run with: npm test
// Listing, unloading and loading models through LM Studio's own API (src/providers/lmstudio-control.ts),
// against a stand-in LM Studio with Require Authentication on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { lmStudioServer } from '../src/providers/lmstudio-control.js'

const KEY = 'lm-studio-secret-key-123'

const MODELS = {
  models: [
    {
      type: 'llm', key: 'qwen/qwen3.5-9b', size_bytes: 6.5e9,
      loaded_instances: [{ id: 'qwen/qwen3.5-9b', config: { context_length: 32768, flash_attention: true, eval_batch_size: 512, offload_kv_cache_to_gpu: true, parallel: 4, something_new: 'x' } }],
    },
    { type: 'llm', key: 'google/gemma-4-26b-a4b', size_bytes: 18e9, loaded_instances: [] },
    { type: 'embedding', key: 'nomic-embed', size_bytes: 1e8, loaded_instances: [{ id: 'nomic-embed', config: { context_length: 2048 } }] },
    { type: 'llm', key: 'bad-instance', loaded_instances: [{ id: 42 }, 'nonsense', { id: 'x'.repeat(400), config: {} }] },
  ],
}

async function withLmStudio(run: (baseUrl: string, seen: Array<{ method: string; url: string; auth: string; body: unknown }>) => Promise<void>, opts: { status?: number } = {}): Promise<void> {
  const seen: Array<{ method: string; url: string; auth: string; body: unknown }> = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const auth = req.headers.authorization ?? ''
      seen.push({ method: req.method!, url: req.url!, auth, body: raw ? JSON.parse(raw) : undefined })
      const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (auth !== `Bearer ${KEY}`) return json({ error: 'invalid api key' }, 401)
      if (opts.status) return json({ error: 'nope' }, opts.status)
      if (req.url === '/api/v1/models' && req.method === 'GET') return json(MODELS)
      if (req.url === '/api/v1/models/unload' && req.method === 'POST') return json({ instance_id: (JSON.parse(raw) as { instance_id: string }).instance_id })
      if (req.url === '/api/v1/models/load' && req.method === 'POST') return json({ type: 'llm', instance_id: 'qwen/qwen3.5-9b', status: 'loaded', load_time_seconds: 1 })
      res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('lists only loaded chat models, with the load settings LM Studio can be given back', async () => {
  await withLmStudio(async (baseUrl, seen) => {
    const loaded = await lmStudioServer(baseUrl, KEY)!.listLoaded()
    assert.deepEqual(loaded, [{
      model: 'qwen/qwen3.5-9b',
      instanceId: 'qwen/qwen3.5-9b',
      config: { context_length: 32768, flash_attention: true, eval_batch_size: 512, offload_kv_cache_to_gpu: true },
    }])
    assert.equal(seen[0]!.auth, `Bearer ${KEY}`, 'the saved key is sent')
  })
})

test('unload and load send exactly the instance and settings, and say whether they worked', async () => {
  await withLmStudio(async (baseUrl, seen) => {
    const server = lmStudioServer(baseUrl, KEY)!
    assert.equal(await server.unload('qwen/qwen3.5-9b'), true)
    assert.equal(await server.load({ model: 'qwen/qwen3.5-9b', instanceId: 'qwen/qwen3.5-9b', config: { context_length: 32768, flash_attention: true } }), true)
    assert.deepEqual(seen[0]!.body, { instance_id: 'qwen/qwen3.5-9b' })
    assert.deepEqual(seen[1]!.body, { model: 'qwen/qwen3.5-9b', context_length: 32768, flash_attention: true })
  })
})

test('a refused key or an error reads as "can not help", never as an empty list to act on', async () => {
  await withLmStudio(async (baseUrl) => {
    const wrongKey = lmStudioServer(baseUrl, 'wrong')!
    assert.equal(await wrongKey.listLoaded(), null)
    assert.equal(await wrongKey.unload('qwen/qwen3.5-9b'), false)
    assert.equal(await wrongKey.load({ model: 'qwen/qwen3.5-9b', instanceId: 'q', config: {} }), false)
  })
  await withLmStudio(async (baseUrl) => {
    assert.equal(await lmStudioServer(baseUrl, KEY)!.listLoaded(), null)
  }, { status: 500 })
})

test('nothing answering reads as "can not help"', async () => {
  const server = lmStudioServer('http://127.0.0.1:9/v1', KEY)!
  assert.equal(await server.listLoaded(), null)
  assert.equal(await server.unload('x'), false)
})

test('only an address the local provider would use is ever contacted', () => {
  assert.equal(lmStudioServer('http://example.com:1234/v1', KEY), null)
  assert.equal(lmStudioServer('not a url', KEY), null)
  assert.notEqual(lmStudioServer('http://127.0.0.1:1234/v1', KEY), null)
})
