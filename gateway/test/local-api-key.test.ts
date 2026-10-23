// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { LocalProvider, isLocalServerUrl } from '../src/providers/local.js'
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

test('a server that never answers the model list gives up with a clear error', async () => {
  const server = http.createServer(() => { /* never answers */ })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  try {
    const started = Date.now()
    const result = await listLocalModels(`http://127.0.0.1:${port}/v1`, undefined, 200)
    assert.ok(Date.now() - started < 2000)
    assert.deepEqual(result.models, [])
    assert.match(result.error ?? '', /no answer within 0.2 s/)
  } finally {
    server.closeAllConnections()
    server.close()
  }
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

test('isLocalServerUrl accepts what the local provider accepts and nothing else', () => {
  for (const ok of ['http://127.0.0.1:1234/v1', 'http://localhost:1234/v1', 'http://host.docker.internal:1234/v1', 'http://192.168.1.20:1234/v1', 'http://10.0.0.5/v1', 'http://172.20.0.2/v1']) {
    assert.equal(isLocalServerUrl(ok), true, ok)
  }
  for (const bad of ['https://example.com/v1', 'http://8.8.8.8/v1', 'http://172.32.0.1/v1', 'not a url', '']) {
    assert.equal(isLocalServerUrl(bad), false, bad)
  }
})

test('the key is never sent to an address the local provider would refuse', async () => {
  const sent: Array<{ url: string; auth: string | undefined }> = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    sent.push({ url: String(input), auth: init?.headers?.['Authorization'] })
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }) as typeof fetch
  try {
    await listLocalModels('https://attacker.example/v1', KEY)
    await refreshLocalContext('https://attacker.example/v1', KEY)
    await listLocalModels('http://127.0.0.1:1234/v1', KEY)
    assert.ok(sent.length >= 3)
    for (const call of sent.filter((s) => s.url.includes('attacker.example'))) assert.equal(call.auth, undefined, call.url)
    assert.equal(sent.find((s) => s.url.startsWith('http://127.0.0.1'))?.auth, `Bearer ${KEY}`)
  } finally {
    globalThis.fetch = realFetch
  }
})
