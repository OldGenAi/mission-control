// Run with: npm test
// The chat's context gauge: a model's loaded window is known on the first listing, not only after the 90 s refresh.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { listLocalModels } from '../src/methods/models.js'

test('a model loaded since the last refresh is listed with its real context window straight away', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'just-loaded-model' }] }))
    if (req.url === '/api/v0/models') return res.end(JSON.stringify({ data: [{ id: 'just-loaded-model', loaded_context_length: 65536 }] }))
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const listed = await listLocalModels(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)
    assert.equal(listed.models[0]?.contextLength, 65536, 'not left unknown, which the page shows as 32k')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
