// Builds one ready-to-run Mission Control package for one system: a private copy of the
// official Node (checked against release/node-pins.json), the built gateway with its
// production dependencies, the built UI, and the `mc` launcher.
//
// Run from the repo root after `npm run build` in gateway/ and app/:
//   node release/build-package.mjs [--platform linux-x64] [--version 0.3.0]
// Writes release/out/mission-control-<version>-<platform>.tar.gz (.zip on Windows) and a .sha256 file.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'release', 'out')
const CACHE = join(ROOT, 'release', '.cache')
const pins = JSON.parse(readFileSync(join(ROOT, 'release', 'node-pins.json'), 'utf-8'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const value = process.argv[i + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`)
  return value
}

function hostPlatform() {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'win' }[process.platform]
  if (!os || !['x64', 'arm64'].includes(process.arch)) throw new Error(`unsupported build host: ${process.platform}-${process.arch}`)
  return `${os}-${process.arch}`
}

const platform = arg('platform', hostPlatform())
const version = arg('version', JSON.parse(readFileSync(join(ROOT, 'gateway', 'package.json'), 'utf-8')).version)
const isWindows = platform.startsWith('win-')
// Windows' own tar (bsdtar) reads and writes zip; Git Bash's GNU tar, often first on PATH, does not.
const TAR = process.platform === 'win32' ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
const pin = pins.archives[platform]
if (!pin) throw new Error(`no pinned Node build for ${platform}; known: ${Object.keys(pins.archives).join(', ')}`)
// Each package is built and smoke-tested on its own system (archive format, launcher, file modes).
if (platform.split('-')[0] !== hostPlatform().split('-')[0]) throw new Error(`build the ${platform} package on ${platform.split('-')[0]}, not on ${process.platform}`)
if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error(`version must be plain (letters, digits, . + -), got "${version}"`)

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// Supply chain: the only Node that goes into a package is one whose bytes match the pin.
async function pinnedNodeArchive() {
  mkdirSync(CACHE, { recursive: true })
  const file = join(CACHE, pin.file)
  if (existsSync(file) && sha256(readFileSync(file)) === pin.sha256) return file
  const url = `https://nodejs.org/dist/${pins.version}/${pin.file}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Node download failed: ${res.status} ${url}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const actual = sha256(bytes)
  if (actual !== pin.sha256) throw new Error(`Node archive checksum mismatch for ${pin.file}: expected ${pin.sha256}, got ${actual}`)
  writeFileSync(file, bytes)
  return file
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' })
}

// better-sqlite3 ships its C sources and a prebuilt binary for every system (27 MB); a
// package needs only its own system's binary. The smoke test proves the database still opens.
function pruneSqlite(dir) {
  const keep = `${isWindows ? 'win32' : platform.split('-')[0]}-${platform.split('-')[1]}.node`
  const prebuilds = join(dir, 'prebuilds')
  if (!existsSync(join(prebuilds, keep))) throw new Error(`better-sqlite3 has no prebuilt binary ${keep}`)
  for (const file of readdirSync(prebuilds)) {
    if (file !== keep) rmSync(join(prebuilds, file))
  }
  for (const sources of ['deps', 'src']) rmSync(join(dir, sources), { recursive: true, force: true })
}

function requireBuilt(path, hint) {
  if (!existsSync(path)) throw new Error(`${path} is missing: ${hint}`)
}

const LAUNCHER_SH = `#!/bin/sh
# Mission Control launcher. mc start: run Mission Control. mc open: open it in the browser, signed in.
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node="$here/node/bin/node"
case "$1" in
  start) exec "$node" "$here/gateway/dist/index.js" ;;
  open)  exec "$node" "$here/gateway/dist/cli/open.js" ;;
  *) echo "usage: mc start | mc open" >&2; exit 2 ;;
esac
`

const LAUNCHER_CMD = `@echo off
rem Mission Control launcher. mc start: run Mission Control. mc open: open it in the browser, signed in.
setlocal
set "HERE=%~dp0.."
if "%~1"=="start" ( "%HERE%\\node\\node.exe" "%HERE%\\gateway\\dist\\index.js" & exit /b )
if "%~1"=="open" ( "%HERE%\\node\\node.exe" "%HERE%\\gateway\\dist\\cli\\open.js" & exit /b )
echo usage: mc start ^| mc open 1>&2
exit /b 2
`

async function main() {
  requireBuilt(join(ROOT, 'gateway', 'dist', 'index.js'), 'run `npm run build` in gateway/ first')
  requireBuilt(join(ROOT, 'app', 'dist', 'index.html'), 'run `npm run build` in app/ first')

  const name = `mission-control-${version}-${platform}`
  const stage = join(OUT, 'stage', name)
  rmSync(join(OUT, 'stage'), { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })

  // Node: only the runtime and its licence, nothing else from the archive.
  const extracted = join(OUT, 'stage', 'node-extract')
  mkdirSync(extracted, { recursive: true })
  run(TAR, ['-xf', await pinnedNodeArchive(), '-C', extracted])
  const nodeRoot = join(extracted, pin.file.replace(/\.(tar\.xz|tar\.gz|zip)$/, ''))
  const nodeBin = isWindows ? join(nodeRoot, 'node.exe') : join(nodeRoot, 'bin', 'node')
  const nodeDest = isWindows ? join(stage, 'node', 'node.exe') : join(stage, 'node', 'bin', 'node')
  mkdirSync(dirname(nodeDest), { recursive: true })
  cpSync(nodeBin, nodeDest)
  cpSync(join(nodeRoot, 'LICENSE'), join(stage, 'node', 'LICENSE'))
  rmSync(extracted, { recursive: true, force: true })

  // Gateway: compiled code plus production dependencies only. .npmrc keeps install scripts off.
  const gateway = join(stage, 'gateway')
  cpSync(join(ROOT, 'gateway', 'dist'), join(gateway, 'dist'), { recursive: true })
  for (const f of ['package.json', 'package-lock.json', '.npmrc']) cpSync(join(ROOT, 'gateway', f), join(gateway, f))
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], gateway)
  pruneSqlite(join(gateway, 'node_modules', 'better-sqlite3'))

  cpSync(join(ROOT, 'app', 'dist'), join(stage, 'app', 'dist'), { recursive: true })
  cpSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'))
  // The Inter font files are inside app/dist; the SIL Open Font License asks for its text to travel with them.
  cpSync(join(ROOT, 'app', 'node_modules', '@fontsource', 'inter', 'LICENSE'), join(stage, 'licenses', 'Inter-OFL.txt'))

  mkdirSync(join(stage, 'bin'))
  if (isWindows) {
    writeFileSync(join(stage, 'bin', 'mc.cmd'), LAUNCHER_CMD.replace(/\n/g, '\r\n'))
  } else {
    writeFileSync(join(stage, 'bin', 'mc'), LAUNCHER_SH)
    chmodSync(join(stage, 'bin', 'mc'), 0o755)
    chmodSync(nodeDest, 0o755)
  }

  const commit = process.env['GITHUB_SHA'] ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf-8' }).trim()
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ name: 'mission-control', version, platform, node: pins.version, commit }, null, 2) + '\n')

  const archive = `${name}${isWindows ? '.zip' : '.tar.gz'}`
  rmSync(join(OUT, archive), { force: true })
  run(TAR, isWindows ? ['-a', '-cf', join(OUT, archive), '-C', join(OUT, 'stage'), name] : ['-czf', join(OUT, archive), '-C', join(OUT, 'stage'), name])
  const digest = sha256(readFileSync(join(OUT, archive)))
  writeFileSync(join(OUT, `${archive}.sha256`), `${digest}  ${archive}\n`)
  rmSync(join(OUT, 'stage'), { recursive: true, force: true })
  console.log(`${archive}\n${digest}`)
}

await main()
