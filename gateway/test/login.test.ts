// Run with: npm test
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// auth.ts creates ~/.missioncontrol/config.json on import, so give it a throwaway home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-login-test-'))
process.env['HOME'] = home
process.env['USERPROFILE'] = home

const uiDir = path.join(home, 'ui')
fs.mkdirSync(path.join(uiDir, 'assets'), { recursive: true })
fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>shell</title>')
fs.writeFileSync(path.join(uiDir, 'assets', 'app-abc123.js'), 'console.log(1)')
fs.writeFileSync(path.join(home, 'secret.txt'), 'outside the UI folder')

type Login = typeof import('../src/login.js')
let login: Login
let launchProof: (token: string, nonce: string) => string
let validateHost: (host: string | undefined) => boolean
let isOwnOrigin: (origin: string | undefined, host: string | undefined) => boolean
let token: string
let server: Server
let base: string
let host: string

before(async () => {
  login = await import('../src/login.js')
  ;({ launchProof } = await import('../src/launch-proof.js'))
  const auth = await import('../src/auth.js')
  ;({ validateHost, isOwnOrigin } = auth)
  token = auth.getConfig().token
  const { buildHttpApp } = await import('../src/http-app.js')
  server = buildHttpApp(uiDir).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`
  base = `http://${host}`
})

after(() => {
  server.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const post = (urlPath: string, body: Record<string, unknown>, origin: string | null = null) => fetch(`${base}${urlPath}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
  body: JSON.stringify(body),
})
const redeem = (code: unknown, origin: string | null = base) => post('/auth/redeem', { code }, origin)

function newCode(now = Date.now()): string {
  const nonce = login.issueLaunchChallenge(now)
  const code = login.issueLaunchCode(nonce, launchProof(token, nonce), now)
  assert.ok(code)
  return code
}

test('a launch code needs a fresh challenge answered with the token', () => {
  const nonce = login.issueLaunchChallenge()
  assert.equal(login.issueLaunchCode(nonce, launchProof('not-the-token', nonce)), null, 'wrong token')
  assert.equal(login.issueLaunchCode(nonce, launchProof(token, nonce)), null, 'a failed try burns the nonce')

  const other = login.issueLaunchChallenge()
  assert.equal(login.issueLaunchCode(other, launchProof(token, nonce)), null, 'proof for another nonce')
  for (const bad of [undefined, '', 'zz'.repeat(32), token, 42]) {
    assert.equal(login.issueLaunchCode(login.issueLaunchChallenge(), bad), null, String(bad).slice(0, 20))
  }

  const now = Date.now()
  const late = login.issueLaunchChallenge(now)
  assert.equal(login.issueLaunchCode(late, launchProof(token, late), now + 61_000), null, 'expired challenge')
  assert.match(newCode(), /^[0-9a-f]{64}$/)
})

test('launch codes work once and only within their minute', () => {
  const now = Date.now()
  const code = newCode(now)
  assert.equal(login.redeemLaunchCode(code, now + 1000), true)
  assert.equal(login.redeemLaunchCode(code, now + 1000), false, 'second use must fail')

  const late = newCode(now)
  assert.equal(login.redeemLaunchCode(late, now + 61_000), false, 'expired code must fail')
  assert.equal(login.redeemLaunchCode(late, now + 1000), false, 'an expired code is gone even if the clock goes back')

  for (const bad of [undefined, null, '', 'x'.repeat(64), 42, {}]) {
    assert.equal(login.redeemLaunchCode(bad), false)
  }
})

test('only the newest 16 launch codes stay open', () => {
  const codes = Array.from({ length: 20 }, () => newCode())
  assert.equal(login.redeemLaunchCode(codes[0]), false, 'oldest code was dropped')
  assert.equal(login.redeemLaunchCode(codes[19]), true)
})

test('sessions: valid until expiry, and any change to one is refused', () => {
  const now = Date.now()
  const { session, expiresAt } = login.issueSession(now)
  assert.equal(login.validateSession(session, now), true)
  assert.equal(login.validateSession(session, expiresAt * 1000 + 1), false, 'expired')

  const [v, exp, id, mac] = session.split('.')
  const flip = (s: string) => (s[0] === 'a' ? 'b' : 'a') + s.slice(1)
  for (const forged of [
    `${v}.${Number(exp) + 999999}.${id}.${mac}`,   // stretched expiry
    `${v}.${exp}.${flip(id!)}.${mac}`,              // other id
    `${v}.${exp}.${id}.${flip(mac!)}`,              // other signature
    `v2.${exp}.${id}.${mac}`,
    `${session}.extra`,
    token,                                          // the gateway token is not a session
    '', undefined, 123,
  ]) {
    assert.equal(login.validateSession(forged, now), false, `should refuse ${String(forged).slice(0, 40)}`)
  }
})

test('Host header: loopback only, no look-alikes', () => {
  for (const ok of ['127.0.0.1:4747', 'localhost:4747', '[::1]:4747', 'LOCALHOST:4747', 'localhost']) {
    assert.equal(validateHost(ok), true, ok)
  }
  for (const bad of [undefined, '', 'evil.com', 'evil.com:4747', 'localhost.evil.com:4747', '127.0.0.1.nip.io:4747',
    'localhost:4747@evil.com', 'localhost:4747/x', '192.168.4.29:4747', '0.0.0.0:4747']) {
    assert.equal(validateHost(bad), false, String(bad))
  }
})

test('own origin: exactly the page this server served', () => {
  assert.equal(isOwnOrigin('http://127.0.0.1:4747', '127.0.0.1:4747'), true)
  assert.equal(isOwnOrigin('http://localhost:5173', 'localhost:4747'), false, 'another local port')
  assert.equal(isOwnOrigin('http://localhost:4747', '127.0.0.1:4747'), false, 'other name')
  assert.equal(isOwnOrigin('https://127.0.0.1:4747', '127.0.0.1:4747'), false)
  assert.equal(isOwnOrigin(undefined, '127.0.0.1:4747'), false)
  assert.equal(isOwnOrigin('http://evil.com', 'evil.com'), false)
})

test('HTTP: the launcher handshake works, and refuses anything a browser sends', async () => {
  assert.equal((await post('/auth/challenge', {}, base)).status, 403, 'browser Origin on challenge')

  const challenge = async () => ((await (await post('/auth/challenge', {})).json()) as { nonce: string }).nonce
  const nonce = await challenge()
  assert.match(nonce, /^[0-9a-f]{64}$/)
  assert.equal((await post('/auth/launch', { nonce, proof: launchProof(token, nonce) }, base)).status, 403, 'browser Origin on launch')

  const wrong = await challenge()
  const refused = await post('/auth/launch', { nonce: wrong, proof: launchProof('guess', wrong) })
  assert.equal(refused.status, 403)
  assert.deepEqual(await refused.json(), { ok: false, error: 'AUTH_FAILED' })
  assert.equal((await post('/auth/launch', { nonce: wrong, proof: launchProof(token, wrong) })).status, 403, 'nonce burned')

  const good = await challenge()
  const ok = await post('/auth/launch', { nonce: good, proof: launchProof(token, good) })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('cache-control'), 'no-store')
  assert.match(((await ok.json()) as { code: string }).code, /^[0-9a-f]{64}$/)
  assert.equal((await post('/auth/launch', { nonce: good, proof: launchProof(token, good) })).status, 403, 'nonce reused')

  const malformed = await fetch(`${base}/auth/launch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
  assert.equal(malformed.status, 400)
  assert.equal(await malformed.text(), '', 'no error details for bad JSON')
})

test('HTTP: redeem gives a session once, only to our own page', async () => {
  const code = newCode()
  assert.equal((await redeem(code, 'http://localhost:5173')).status, 403, 'other local page')
  assert.equal((await redeem(code, null)).status, 403, 'no Origin')

  const fresh = newCode()
  const res = await redeem(fresh)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const { session } = (await res.json()) as { session: string }
  assert.equal(login.validateSession(session), true)
  assert.equal((await redeem(fresh)).status, 403, 'second use')
})

test('HTTP: a rebinding Host is refused everywhere', async () => {
  const http = await import('node:http')
  const status = (urlPath: string) => new Promise<number>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address() && (server.address() as AddressInfo).port, path: urlPath,
      headers: { host: 'evil.com' } }, (res) => { res.resume(); resolve(res.statusCode!) }).on('error', reject)
  })
  for (const p of ['/', '/health', '/assets/app-abc123.js', '/chat']) {
    assert.equal(await status(p), 403, p)
  }
})

test('HTTP: the UI is served with a strict policy, and nothing outside its folder', async () => {
  const shell = await fetch(`${base}/settings`)
  assert.equal(shell.status, 200)
  assert.match(await shell.text(), /<title>shell<\/title>/)
  const csp = shell.headers.get('content-security-policy') ?? ''
  assert.match(csp, /script-src 'self'(;|$)/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.doesNotMatch(csp, /https?:/, 'the UI loads nothing from other sites')
  assert.match(csp, new RegExp(`connect-src 'self' ws://${host.replace(/[.]/g, '\\.')}`))
  assert.equal(shell.headers.get('x-frame-options'), 'DENY')
  assert.equal(shell.headers.get('x-powered-by'), null)

  const asset = await fetch(`${base}/assets/app-abc123.js`)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/)
  assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404, 'missing asset is not the app shell')

  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/..%5csecret.txt']) {
    const res = await fetch(`${base}${p}`)
    const body = await res.text()
    assert.doesNotMatch(body, /outside the UI folder/, p)
    assert.doesNotMatch(body, /node_modules|at .*\.js:\d+/, `${p}: no stack trace`)
  }
})
