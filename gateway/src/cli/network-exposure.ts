// mc doctor's network check: is Mission Control, or a model server it uses, answering on this
// computer's network addresses instead of only on 127.0.0.1?
//
// A server bound to 0.0.0.0 answers on every address the computer has, so other devices on the
// network (and, through DNS rebinding, web pages) can reach it. The check connects to each of
// this computer's own non-loopback addresses: a server that only listens on 127.0.0.1 refuses
// those connections, one listening on 0.0.0.0 accepts them. Nothing is sent after connecting.

import { createConnection } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { DoctorCheck } from './report-types.js'

export interface WatchedServer {
  name: string
  port: number
  fix: string
}

const CONNECT_TIMEOUT_MS = 600

/** This computer's own IPv4 addresses other than loopback (LAN, VPN such as Tailscale). */
export function ownAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address)
    }
  }
  return [...new Set(out)]
}

export function answersOn(address: string, port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: address, port })
    const done = (open: boolean): void => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** The first of `addresses` the server answers on, or null if it answers on none. */
export async function exposedAddress(port: number, addresses: string[]): Promise<string | null> {
  const results = await Promise.all(addresses.map(async (a) => ((await answersOn(a, port)) ? a : null)))
  return results.find((a) => a !== null) ?? null
}

export async function networkChecks(servers: WatchedServer[], addresses: string[] = ownAddresses()): Promise<DoctorCheck[]> {
  if (addresses.length === 0) {
    return [{ name: 'Network', status: 'info', detail: 'no network address found, so nothing can reach this computer from outside' }]
  }
  const found = await Promise.all(servers.map(async (s) => ({ s, at: await exposedAddress(s.port, addresses) })))
  const exposed = found.filter((f) => f.at !== null)
  if (exposed.length === 0) {
    return [{ name: 'Network', status: 'ok', detail: 'Mission Control and your model servers answer on this computer only' }]
  }
  return exposed.map(({ s, at }) => ({
    name: 'Network',
    status: 'warn',
    detail: `${s.name} (port ${s.port}) answers on ${at}, so other devices on your network can reach it`,
    fix: s.fix,
  }))
}
