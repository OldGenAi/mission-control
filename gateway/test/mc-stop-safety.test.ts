// Run with: npm test (after npm run build: this drives the built dist/cli/mc.js)
//
// `mc stop` must never stop a process just because something on the port names it.
// A fake server answers /health with the pid of an innocent process; with no matching
// pid file in ~/.missioncontrol, mc stop has to refuse and the process must survive.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'

const mcEntry = path.join(__dirname, '..', 'dist', 'cli', 'mc.js')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-stop-test-'))
let innocent: ChildProcess
let fake: http.Server
let port: number

before(async () => {
  innocent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  fake = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, uptime: 5, version: '9.9.9', pid: innocent.pid }))
  })
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
  port = (fake.address() as AddressInfo).port
})

after(() => {
  innocent.kill()
  fake.close()
  fs.rmSync(home, { recursive: true, force: true })
})

// Asynchronous on purpose: the fake server lives in this process, so a blocking spawn
// would stop it from answering.
function mc(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [mcEntry, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, GATEWAY_PORT: String(port) },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

test('mc stop refuses a pid that only the port vouches for', { skip: !fs.existsSync(mcEntry) && 'run npm run build first' }, async () => {
  const result = await mc('stop')
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /not a Mission Control started by this user/)
  assert.equal(alive(innocent.pid!), true, 'the innocent process must still be running')
})

test('mc stop also refuses when the pid file names a different process', { skip: !fs.existsSync(mcEntry) && 'run npm run build first' }, async () => {
  fs.mkdirSync(path.join(home, '.missioncontrol'), { recursive: true })
  fs.writeFileSync(path.join(home, '.missioncontrol', 'gateway.pid'), JSON.stringify({ pid: innocent.pid! + 1, port }))
  const result = await mc('stop')
  assert.equal(result.status, 1)
  assert.equal(alive(innocent.pid!), true)
})

test('mc status and mc doctor run without starting anything', { skip: !fs.existsSync(mcEntry) && 'run npm run build first' }, async () => {
  const status = await mc('status')
  assert.equal(status.status, 0)
  assert.match(status.stdout, /^Mission Control \d+\.\d+\.\d+\nStatus:   running/)
  const doctor = await mc('doctor')
  assert.match(doctor.stdout, /\[warn\] Gateway: something answers .* but not with this user's pid file/)
  assert.doesNotMatch(doctor.stdout + doctor.stderr, new RegExp(home.replace(/\\/g, '\\\\')), 'home folder shown as ~')
})
