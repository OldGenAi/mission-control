// Opens the Mission Control UI in the default browser, already signed in.
//
// Proves to the running gateway that we hold the token in ~/.missioncontrol/config.json
// (challenge + HMAC, see launch-proof.ts; the token itself is never sent), receives a
// one-time code, and opens http://127.0.0.1:<port>/#login=<code>.
// Run with: npm run open

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { launchProof } from '../launch-proof.js'

const CONFIG_FILE = join(homedir(), '.missioncontrol', 'config.json')
const PORT = Number(process.env['GATEWAY_PORT'] ?? 4747)
const BASE = `http://127.0.0.1:${PORT}`

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function readToken(): string {
  let token: unknown
  try {
    token = (JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as { token?: unknown }).token
  } catch (err) {
    fail(`Cannot read ${CONFIG_FILE} (${(err as Error).message}). Has Mission Control been started once as this user?`)
  }
  if (typeof token !== 'string') fail(`No token in ${CONFIG_FILE}.`)
  return token
}

async function postJson(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    fail(`Mission Control is not running on port ${PORT}. Start it first.`)
  }
  let reply: Record<string, unknown>
  try {
    reply = (await res.json()) as Record<string, unknown>
  } catch {
    fail(`Something other than Mission Control is answering on port ${PORT} (${res.status}, not JSON).`)
  }
  if (!res.ok) fail(`The gateway refused ${path} (${res.status} ${String(reply['error'] ?? '')}). Is this the user that started it?`)
  return reply
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '""', url]] :
    process.platform === 'darwin' ? ['open', [url]] :
    process.env['WSL_DISTRO_NAME'] ? ['cmd.exe', ['/c', 'start', '""', url]] :
    ['xdg-open', [url]]
  // Verbatim on Windows so the empty window title `""` reaches `start` unquoted.
  spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' }).unref()
}

async function main(): Promise<void> {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail(`GATEWAY_PORT must be a port number, got "${process.env['GATEWAY_PORT']}".`)
  const token = readToken()
  const { nonce } = await postJson('/auth/challenge', {})
  if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) fail('The gateway sent an unexpected challenge.')
  const { code } = await postJson('/auth/launch', { nonce, proof: launchProof(token, nonce) })
  // The code goes onto a cmd.exe command line on Windows: hex only, nothing else.
  if (typeof code !== 'string' || !/^[0-9a-f]{64}$/.test(code)) fail('The gateway sent an unexpected sign-in code.')
  openBrowser(`${BASE}/#login=${code}`)
  console.log(`Opening ${BASE} (the sign-in link works once, for one minute).`)
}

void main()
