// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { LocalProvider } from '../src/providers/local.js'
import type { StreamChunk } from '../src/providers/types.js'

// A local server (like LM Studio) that says nothing for `silentMs` while it "writes a tool call", then sends the whole call at once.
async function withSlowServer(silentMs: number, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    setTimeout(() => {
      const call = { index: 0, id: 'call1', type: 'function', function: { name: 'artifact_write', arguments: '{"type":"report","title":"R","content":"long report"}' } }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 40 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    }, silentMs)
    res.on('close', () => { /* the client hung up */ })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

async function collect(provider: LocalProvider): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of provider.complete({ model: 'm', messages: [{ role: 'user', content: 'write the report' }], correlationId: 'stall-test' } as never)) out.push(chunk)
  return out
}

test('a long silent stretch while the model writes a tool call is tolerated when it is within the allowed time', async () => {
  await withSlowServer(600, async (baseUrl) => {
    const chunks = await collect(new LocalProvider({ baseUrl, stallMs: 5_000 }))
    const call = chunks.find((c) => c.type === 'tool_call')
    assert.ok(call, 'the tool call arrives')
    const done = chunks.find((c) => c.type === 'done') as { error?: string } | undefined
    assert.equal(done?.error, undefined)
  })
})

test('a stream silent for longer than the allowed time ends with a clear error, never as an empty successful reply', async () => {
  await withSlowServer(2_000, async (baseUrl) => {
    const chunks = await collect(new LocalProvider({ baseUrl, stallMs: 300 }))
    assert.ok(!chunks.some((c) => c.type === 'tool_call'))
    assert.ok(!chunks.some((c) => c.type === 'text_delta'))
    const done = chunks.find((c) => c.type === 'done') as { error?: string } | undefined
    assert.ok(done, 'a done chunk')
    assert.match(done?.error ?? '', /did not send a token within 0\.3s/)
  })
})
