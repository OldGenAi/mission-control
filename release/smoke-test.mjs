// Unpacks a release package into a throwaway folder and uses it the way a person would:
// `mc start` with a fresh home, checks the UI and health on a spare port, that the gateway
// token appears nowhere in the shipped UI, then `mc status`, `mc doctor` and `mc stop`.
//
//   node release/smoke-test.mjs release/out/mission-control-<version>-<platform>.tar.gz

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const archive = resolve(process.argv[2] ?? '')
const PORT = 4799
const BASE = `http://127.0.0.1:${PORT}`
const work = mkdtempSync(join(tmpdir(), 'mc-smoke-'))
const home = join(work, 'home')
const isWindows = process.platform === 'win32'
// Windows' own tar reads zip; Git Bash's GNU tar, often first on PATH there, does not.
const TAR = isWindows ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'

function fail(message) {
  console.error(`SMOKE TEST FAILED: ${message}`)
  process.exitCode = 1
}

function filesUnder(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

async function healthy() {
  try {
    return (await fetch(`${BASE}/health`)).ok
  } catch {
    // Not listening.
    return false
  }
}

const name = basename(archive).replace(/\.(tar\.gz|zip)$/, '')
execFileSync(TAR, ['-xf', archive, '-C', work])
const root = join(work, name)
const env = { ...process.env, HOME: home, USERPROFILE: home, GATEWAY_PORT: String(PORT), PROVIDER: 'local' }

function mc(...args) {
  const result = isWindows
    ? spawnSync('cmd.exe', ['/c', join(root, 'bin', 'mc.cmd'), ...args], { env, encoding: 'utf-8' })
    : spawnSync(join(root, 'bin', 'mc'), args, { env, encoding: 'utf-8' })
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

try {
  const started = mc('start')
  if (started.code !== 0 || !(await healthy())) {
    fail(`mc start failed (${started.code})\n${started.out}`)
  } else {
    const page = await fetch(`${BASE}/settings`)
    const html = await page.text()
    if (page.status !== 200 || !html.includes('<div id="root">')) fail(`UI not served (${page.status})`)
    if (!(page.headers.get('content-security-policy') ?? '').includes("script-src 'self'")) fail('UI served without its Content-Security-Policy')

    const token = JSON.parse(readFileSync(join(home, '.missioncontrol', 'config.json'), 'utf-8')).token
    const leaked = filesUnder(join(root, 'app', 'dist')).filter((f) => readFileSync(f).includes(token))
    if (leaked.length) fail(`gateway token found in shipped UI: ${leaked.join(', ')}`)

    const status = mc('status')
    if (status.code !== 0 || !status.out.includes('Status:   running')) fail(`mc status: ${status.out}`)
    const doctor = mc('doctor')
    if (doctor.code !== 0 || !doctor.out.includes('[ok]   Gateway')) fail(`mc doctor: ${doctor.out}`)

    const stopped = mc('stop')
    if (stopped.code !== 0 || (await healthy())) fail(`mc stop: ${stopped.out}`)
    if (existsSync(join(home, '.missioncontrol', 'gateway.pid'))) fail('pid file left behind after mc stop')

    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8'))
    if (!process.exitCode) console.log(`ok: ${manifest.name} ${manifest.version} ${manifest.platform}, Node ${manifest.node}: mc start, UI, status, doctor, stop`)
  }
} finally {
  if (await healthy()) mc('stop')
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}
