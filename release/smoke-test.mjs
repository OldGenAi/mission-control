// Unpacks a release package into a throwaway folder and runs it the way a user would:
// `mc start` with a fresh home, then checks the UI and health on a spare port, and that
// the gateway token appears nowhere in the shipped UI.
//
//   node release/smoke-test.mjs release/out/mission-control-<version>-<platform>.tar.gz

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const archive = resolve(process.argv[2] ?? '')
const PORT = 4799
const work = mkdtempSync(join(tmpdir(), 'mc-smoke-'))
const home = join(work, 'home')

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

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`)
      if (res.ok) return true
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

const isWindows = process.platform === 'win32'
// Windows' own tar reads zip; Git Bash's GNU tar, often first on PATH there, does not.
const TAR = isWindows ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
const name = basename(archive).replace(/\.(tar\.gz|zip)$/, '')
execFileSync(TAR, ['-xf', archive, '-C', work])
const root = join(work, name)

const env = { ...process.env, HOME: home, USERPROFILE: home, GATEWAY_PORT: String(PORT), PROVIDER: 'local' }
const gateway = isWindows
  ? spawn('cmd.exe', ['/c', join(root, 'bin', 'mc.cmd'), 'start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(join(root, 'bin', 'mc'), ['start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
gateway.stdout.on('data', (d) => { log += d })
gateway.stderr.on('data', (d) => { log += d })

try {
  if (!(await waitForHealth())) {
    fail(`gateway did not answer /health within 30 s\n${log}`)
  } else {
    const page = await fetch(`http://127.0.0.1:${PORT}/settings`)
    const html = await page.text()
    if (page.status !== 200 || !html.includes('<div id="root">')) fail(`UI not served (${page.status})`)
    if (!(page.headers.get('content-security-policy') ?? '').includes("script-src 'self'")) fail('UI served without its Content-Security-Policy')

    const token = JSON.parse(readFileSync(join(home, '.missioncontrol', 'config.json'), 'utf-8')).token
    const leaked = filesUnder(join(root, 'app', 'dist')).filter((f) => readFileSync(f).includes(token))
    if (leaked.length) fail(`gateway token found in shipped UI: ${leaked.join(', ')}`)

    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8'))
    console.log(`ok: ${manifest.name} ${manifest.version} ${manifest.platform}, Node ${manifest.node}, UI and health on port ${PORT}`)
  }
} finally {
  if (isWindows) execFileSync('taskkill', ['/pid', String(gateway.pid), '/T', '/F'], { stdio: 'ignore' })
  else gateway.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 1000))
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}
