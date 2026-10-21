// Opens the Mission Control UI in the default browser, already signed in.
//
// Proves to the running gateway that we hold the token in ~/.missioncontrol/config.json
// (challenge + HMAC, see launch-proof.ts; the token itself is never sent), receives a
// one-time code, and opens http://127.0.0.1:<port>/#login=<code>.
// Errors are thrown with a message meant for the person at the keyboard.

import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { launchProof } from '../launch-proof.js'
import { CONFIG_FILE } from '../paths.js'

function readToken(): string {
  let token: unknown
  try {
    token = (JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as { token?: unknown }).token
  } catch (err) {
    throw new Error(`Cannot read ${CONFIG_FILE} (${(err as Error).message}). Has Mission Control been started once as this user?`)
  }
  if (typeof token !== 'string') throw new Error(`No token in ${CONFIG_FILE}.`)
  return token
}

async function postJson(base: string, path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error(`Mission Control is not running at ${base}. Start it with: mc start`)
  }
  let reply: Record<string, unknown>
  try {
    reply = (await res.json()) as Record<string, unknown>
  } catch {
    throw new Error(`Something other than Mission Control is answering at ${base} (${res.status}, not JSON).`)
  }
  if (!res.ok) throw new Error(`The gateway refused ${path} (${res.status} ${String(reply['error'] ?? '')}). Is this the user that started it?`)
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

export async function openSignedIn(base: string): Promise<void> {
  const token = readToken()
  const { nonce } = await postJson(base, '/auth/challenge', {})
  if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) throw new Error('The gateway sent an unexpected challenge.')
  const { code } = await postJson(base, '/auth/launch', { nonce, proof: launchProof(token, nonce) })
  // The code goes onto a cmd.exe command line on Windows: hex only, nothing else.
  if (typeof code !== 'string' || !/^[0-9a-f]{64}$/.test(code)) throw new Error('The gateway sent an unexpected sign-in code.')
  openBrowser(`${base}/#login=${code}`)
  console.log(`Opening ${base} (the sign-in link works once, for one minute).`)
}
