// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { LocalProvider } from '../src/providers/local.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { listLocalModels, localAuthHeaders } from '../src/methods/models.js'
import { refreshLocalContext } from '../src/providers/pricing.js'
import type { SettingsSnapshot } from '../src/store/settings.js'

const KEY = 'lm-studio-secret-key-123'

// A local model server that wants "Authorization: Bearer <KEY>", like LM Studio with Require Authentication on.
async function withLockedServer(run: (baseUrl: string, seen: string[]) => Promise<void>): Promise<void> {
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? ''
    seen.push(`${req.url} ${auth}`)
    if (auth !== `Bearer ${KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid api key' }))
      return
    }
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'qwen-test', loaded_context_length: 8192 }] }))
      return
    }
    if (req.url?.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('no key means no Authorization header from the model list', () => {
  assert.deepEqual(localAuthHeaders(undefined), {})
  assert.deepEqual(localAuthHeaders(''), {})
  assert.deepEqual(localAuthHeaders(KEY), { Authorization: `Bearer ${KEY}` })
})

test('the model list sends the key, and a locked server without it says how to fix it', async () => {
  await withLockedServer(async (baseUrl) => {
    const ok = await listLocalModels(baseUrl, KEY)
    assert.equal(ok.error, undefined)
    assert.deepEqual(ok.models.map((m) => m.id), ['qwen-test'])

    const locked = await listLocalModels(baseUrl, undefined)
    assert.deepEqual(locked.models, [])
    assert.match(locked.error ?? '', /HTTP 401/)
    assert.match(locked.error ?? '', /API key/)
    assert.match(locked.error ?? '', /Settings/)
  })
})

test('chat sends the key to the local server', async () => {
  await withLockedServer(async (baseUrl) => {
    const provider = new LocalProvider({ baseUrl, apiKey: KEY })
    const chunks = []
    for await (const chunk of provider.complete({
      model: 'qwen-test', messages: [{ role: 'user', content: 'hi' }], correlationId: 'test',
    } as never)) chunks.push(chunk)
    assert.ok(chunks.some((c) => c.type === 'text_delta'))
    const done = chunks.find((c) => c.type === 'done') as { error?: string } | undefined
    assert.equal(done?.error, undefined)
  })
})

test('chat without the key fails cleanly as a done chunk with the server error', async () => {
  await withLockedServer(async (baseUrl) => {
    const provider = new LocalProvider({ baseUrl })
    const chunks = []
    for await (const chunk of provider.complete({
      model: 'qwen-test', messages: [{ role: 'user', content: 'hi' }], correlationId: 'test',
    } as never)) chunks.push(chunk)
    const done = chunks.find((c) => c.type === 'done') as { error?: string } | undefined
    assert.match(done?.error ?? '', /401/)
  })
})

test('the context-window refresh sends the key too', async () => {
  await withLockedServer(async (baseUrl, seen) => {
    await refreshLocalContext(baseUrl, KEY)
    assert.ok(seen.some((line) => line === `/api/v0/models Bearer ${KEY}`))
  })
})

test('the registry builds the local provider from the saved key', () => {
  const settings = { localProviderUrl: 'http://127.0.0.1:1234/v1', providerKeys: { openrouter: '', anthropic: '', local: KEY } } as unknown as SettingsSnapshot
  const registry = new ProviderRegistry(settings)
  assert.ok(registry.get('local') instanceof LocalProvider)
})
