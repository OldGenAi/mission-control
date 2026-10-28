// Run with: npm test
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// auth.ts creates ~/.missioncontrol/config.json on import, so give it a throwaway home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ui-test-'))
process.env['HOME'] = home
process.env['USERPROFILE'] = home

// Installed copies keep the built UI inside the hidden ~/.missioncontrol folder, so the test does too.
const uiDir = path.join(home, '.missioncontrol', 'app', 'ui')
fs.mkdirSync(path.join(uiDir, 'assets'), { recursive: true })
fs.writeFileSync(path.join(uiDir, 'index.html'), 'app shell')
fs.writeFileSync(path.join(uiDir, 'assets', 'app.js'), 'app code')
fs.writeFileSync(path.join(uiDir, '.env'), 'secret')
fs.writeFileSync(path.join(home, 'outside.txt'), 'outside the UI folder')

let server: Server
let base: string

before(async () => {
  const { buildHttpApp } = await import('../src/http-app.js')
  server = buildHttpApp(uiDir).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => new Promise<void>((r) => server.close(() => r())))

test('every page route loads the app shell from a UI folder inside a hidden folder', async () => {
  for (const route of ['/', '/chat', '/settings/models']) {
    const res = await fetch(base + route)
    assert.equal(res.status, 200, route)
    assert.equal(await res.text(), 'app shell', route)
    assert.equal(res.headers.get('cache-control'), 'no-store', route)
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/, route)
  }
})

test('assets load, and hidden or outside files never do', async () => {
  assert.equal(await (await fetch(`${base}/assets/app.js`)).text(), 'app code')
  for (const route of ['/.env', '/..%2foutside.txt', '/%2e%2e/outside.txt', '/assets/..%2f..%2foutside.txt']) {
    const body = await (await fetch(base + route)).text()
    assert.ok(!body.includes('secret') && !body.includes('outside the UI folder'), route)
  }
})
