// Run with: npm test
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// auth.ts creates ~/.missioncontrol/config.json on import, so give it a throwaway home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-auth-test-'))
process.env['HOME'] = home
process.env['USERPROFILE'] = home

let validateOrigin: (origin: string | undefined) => boolean
let validateToken: (token: unknown) => boolean
let getConfig: () => Readonly<{ token: string }>
let redact: (input: string) => string

before(async () => {
  ;({ validateOrigin, validateToken, getConfig } = await import('../src/auth.js'))
  ;({ redact } = await import('../src/store/redact.js'))
})

after(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

test('WebSocket origin: loopback pages and non-browser clients are allowed', () => {
  for (const origin of [undefined, '', 'http://localhost', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']) {
    assert.equal(validateOrigin(origin), true, `${String(origin)} should be allowed`)
  }
})

test('WebSocket origin: other websites and look-alike hosts are refused', () => {
  for (const origin of [
    'http://evil.com', 'https://evil.com', 'http://localhost.evil.com', 'http://127.0.0.1.evil.com',
    'http://evil.com:5173', 'https://localhost', 'null', 'not a url', 'file://', 'http://192.168.1.10:5173',
  ]) {
    assert.equal(validateOrigin(origin), false, `${origin} should be refused`)
  }
})

test('gateway token: only the exact token is accepted', () => {
  const token = getConfig().token
  assert.equal(token.length >= 32, true)
  assert.equal(validateToken(token), true)
  assert.equal(validateToken(token.slice(0, -1)), false)
  assert.equal(validateToken(token + 'x'), false)
  assert.equal(validateToken(''), false)
  assert.equal(validateToken(undefined), false)
  assert.equal(validateToken(12345), false)
  assert.equal(validateToken(null), false)
})

test('redact removes keys, tokens and system paths from text', () => {
  const secrets = [
    'Authorization: Bearer abc123.def456-ghi',
    'key sk-or-v1-0123456789abcdef0123456789abcdef',
    'anthropic sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV',
    `token ${'a1'.repeat(32)}`,
    'password=hunter2hunter2',
    'brave BSAabcdefghijklmnopqrstuvwxyz0123',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
    'read /etc/shadow failed',
  ]
  for (const s of secrets) {
    const out = redact(s)
    assert.doesNotMatch(out, /hunter2|0123456789abcdef|ABCDEFGHIJKLMNOPQRSTUV|a1a1a1|abc123\.def456|SflKxw|\/etc\/shadow|BSAabcdef/, `leaked from: ${s} -> ${out}`)
  }
})
