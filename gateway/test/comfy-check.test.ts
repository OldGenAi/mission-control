// Run with: npm test
// mc doctor's ComfyUI check against a fake /system_stats.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { comfyChecks } from '../src/cli/comfy-check.js'

async function fakeStats(argv: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ system: { comfyui_version: '0.38.0', argv }, devices: [{ name: 'Fake GPU', vram_total: 16, vram_free: 15 }] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(() => r())) }
}

test('a well-started ComfyUI is ok', async () => {
  const comfy = await fakeStats(['main.py', '--disable-metadata'])
  try {
    const checks = await comfyChecks(comfy.url)
    assert.equal(checks.length, 1)
    assert.equal(checks[0]?.status, 'ok')
    assert.match(checks[0]?.detail ?? '', /0\.38\.0.*Fake GPU/)
  } finally { await comfy.close() }
})

test('--listen is a warning and missing --disable-metadata is a note', async () => {
  const comfy = await fakeStats(['main.py', '--listen'])
  try {
    const checks = await comfyChecks(comfy.url)
    assert.deepEqual(checks.map((c) => c.status), ['ok', 'warn', 'info'])
    assert.match(checks[1]?.detail ?? '', /--listen/)
    assert.match(checks[2]?.fix ?? '', /--disable-metadata/)
  } finally { await comfy.close() }
})

test('not running is information, and a non-loopback address is refused without being contacted', async () => {
  const down = await comfyChecks('http://127.0.0.1:1')
  assert.equal(down[0]?.status, 'info')
  assert.match(down[0]?.detail ?? '', /only needed for the Video page/)
  const remote = await comfyChecks('http://192.168.1.50:8188')
  assert.equal(remote[0]?.status, 'warn')
})
