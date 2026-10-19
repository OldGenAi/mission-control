/**
 * tools/ssrf-guard.ts — outbound HTTP for web_fetch that cannot be pointed at internal addresses
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * Why this exists: web_fetch takes a URL chosen by the model, and the model can be steered by
 * the pages it reads (prompt injection). Without a guard, "fetch this page" becomes "fetch
 * http://127.0.0.1:4747/..." or the cloud metadata address, and the answer goes back into the
 * conversation. Three layers close that:
 *
 *   1. IP literals are classified numerically (every IPv4 range, plus IPv6 forms that wrap an
 *      IPv4 address: ::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::/96, 6to4). Parsing the number, not
 *      matching the text, is what stops "[::ffff:7f00:1]" slipping past a string check.
 *   2. Host NAMES are resolved by our own lookup function and every returned address is
 *      classified the same way. The socket connects to an address we just checked, so a name
 *      cannot be checked as public and then connect as private (DNS rebinding), and a public
 *      name that points at 127.0.0.1 (localtest.me and friends) is refused.
 *   3. Redirects are followed by hand, and every hop goes back through layers 1 and 2.
 *
 * Responses are read as a stream and cut off at maxBytes, so a huge body cannot be pulled into
 * memory first and truncated afterwards.
 */

import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function ipv4Octets(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null
}

function isPrivateIPv4(o: number[]): boolean {
  const [a, b, c] = o
  return (
    a === 0 ||                                // 0.0.0.0/8 "this network"
    a === 10 ||                               // RFC 1918
    (a === 100 && b >= 64 && b <= 127) ||     // 100.64.0.0/10 carrier-grade NAT
    a === 127 ||                              // loopback
    (a === 169 && b === 254) ||               // link-local, includes cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||      // RFC 1918
    (a === 192 && b === 0 && c === 0) ||      // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 168) ||               // RFC 1918
    (a === 198 && (b === 18 || b === 19)) ||  // 198.18.0.0/15 benchmarking
    a >= 224                                  // multicast, reserved, broadcast
  )
}

/** Expand any valid IPv6 text form to its eight 16-bit groups, or null if it is not valid IPv6. */
function ipv6Groups(address: string): number[] | null {
  let s = address.toLowerCase()
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)
  if (!net.isIPv6(s)) return null

  // A dotted IPv4 tail (::ffff:1.2.3.4) is two more groups.
  const tail4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (tail4) {
    const o = ipv4Octets(tail4[1])
    if (!o) return null
    s = s.slice(0, tail4.index) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16)
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const groups = halves.length === 2
    ? [...head, ...Array<string>(8 - head.length - rest.length).fill('0'), ...rest]
    : head
  if (groups.length !== 8) return null
  const parsed = groups.map((g) => parseInt(g, 16))
  return parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? parsed : null
}

function isPrivateIPv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g
  const embedded = [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0

  if (firstFiveZero && g5 === 0) return true                          // ::/96 — unspecified, ::1, IPv4-compatible
  if (firstFiveZero && g5 === 0xffff) return isPrivateIPv4(embedded)  // ::ffff:0:0/96 IPv4-mapped
  if (g0 === 0x64 && g1 === 0xff9b) {                                 // 64:ff9b::/96 NAT64, 64:ff9b:1::/48 local NAT64
    if (g2 === 1) return true
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIPv4(embedded)
  }
  if (g0 === 0x2002) return isPrivateIPv4([g1 >> 8, g1 & 255, g2 >> 8, g2 & 255]) // 6to4 wraps an IPv4 address
  if (g0 === 0x2001 && g1 === 0) return true                          // Teredo tunnels
  if (g0 === 0x2001 && g1 === 0x0db8) return true                     // documentation range
  if ((g0 & 0xfe00) === 0xfc00) return true                           // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true                           // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true                           // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true                           // ff00::/8 multicast
  return false
}

/**
 * True when an IP literal is loopback, private, link-local, multicast, reserved or otherwise
 * not a normal public internet address. Anything that cannot be parsed counts as blocked.
 */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '')
  if (net.isIPv4(bare)) {
    const o = ipv4Octets(bare)
    return o === null ? true : isPrivateIPv4(o)
  }
  const groups = ipv6Groups(bare)
  return groups === null ? true : isPrivateIPv6(groups)
}

/**
 * Up-front check on the host part of a URL (URL.hostname form). IP literals are classified;
 * names that are internal by definition are refused. Ordinary public names pass here and are
 * checked again, address by address, when they are resolved at connect time.
 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (net.isIP(h) !== 0 || h.includes(':')) return isPrivateAddress(h)
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.localdomain') ||
    !h.includes('.')   // single-label names (intranet hosts) are never public
  )
}

// ---------------------------------------------------------------------------
// Connect-time DNS check
// ---------------------------------------------------------------------------

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void

/**
 * Drop-in `lookup` for http(s).request. Resolves the name, refuses if ANY returned address is
 * non-public, and otherwise hands the checked addresses to the socket — so the connection is
 * made to exactly what was validated.
 */
export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, [])
    const list = addresses as dns.LookupAddress[]
    const bad = list.find((a) => isPrivateAddress(a.address))
    if (bad) {
      const blocked: NodeJS.ErrnoException = new Error(
        `SSRF protection: "${hostname}" resolves to a private or reserved address (${bad.address}) — access denied`
      )
      blocked.code = 'ESSRF'
      return callback(blocked, [])
    }
    if (options.all) return callback(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

// ---------------------------------------------------------------------------
// Guarded fetch
// ---------------------------------------------------------------------------

export interface GuardedFetchOptions {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  timeoutMs: number
  /** Hard cap on decoded response bytes kept in memory. */
  maxBytes: number
  maxRedirects?: number
}

export interface GuardedFetchResult {
  status: number
  ok: boolean
  contentType: string
  body: Buffer
  /** True when the body was cut off at maxBytes. */
  truncated: boolean
  finalUrl: string
}

// Headers a caller may not set: they control framing or routing and would let a request lie
// about where it is going or how long it is.
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'keep-alive', 'proxy-connection', 'proxy-authorization',
])
const CREDENTIAL_HEADERS = ['authorization', 'cookie']

function assertAllowedTarget(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`protocol "${url.protocol}" is not allowed — use http or https`)
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error(`SSRF protection: "${url.hostname}" is a private or reserved host — access denied`)
  }
}

function requestOnce(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(url, { method, headers, signal, agent: false, lookup: guardedLookup }, resolve)
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function readCapped(res: http.IncomingMessage, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase().trim()
  let stream: NodeJS.ReadableStream = res
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip())
  else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate())
  else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress())

  const chunks: Buffer[] = []
  let size = 0
  let truncated = false
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer
      if (size + buf.length > maxBytes) {
        chunks.push(buf.subarray(0, maxBytes - size))
        truncated = true
        break
      }
      chunks.push(buf)
      size += buf.length
    }
  } finally {
    res.destroy()
  }
  return { body: Buffer.concat(chunks), truncated }
}

/**
 * Fetch a URL over http(s) without ever connecting to a private or reserved address.
 * Throws on a blocked target, a timeout, or a network error.
 */
export async function guardedFetch(initialUrl: string, opts: GuardedFetchOptions): Promise<GuardedFetchResult> {
  const signal = AbortSignal.timeout(opts.timeoutMs)
  const maxRedirects = opts.maxRedirects ?? 5

  let url = new URL(initialUrl)
  let method: string = opts.method
  let body = opts.body
  let headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.headers)) {
    if (!FORBIDDEN_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v
  }
  if (!headers['accept-encoding']) headers['accept-encoding'] = 'identity'

  try {
    for (let hop = 0; ; hop++) {
      assertAllowedTarget(url)
      const sendHeaders = body !== undefined
        ? { ...headers, 'content-length': String(Buffer.byteLength(body)) }
        : headers
      const res = await requestOnce(url, method, sendHeaders, body, signal)

      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location) {
        res.destroy()
        if (hop >= maxRedirects) throw new Error('SSRF protection: too many redirects')
        const next = new URL(location, url)
        if (next.origin !== url.origin) {
          headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.includes(k)))
        }
        // Same behaviour as fetch(): 303, and 301/302 after a POST, continue as a body-less GET.
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          method = 'GET'
          body = undefined
          const { 'content-type': _ct, ...withoutType } = headers
          headers = withoutType
        }
        url = next
        continue
      }

      const { body: bytes, truncated } = await readCapped(res, opts.maxBytes)
      return {
        status,
        ok: status >= 200 && status < 300,
        contentType: String(res.headers['content-type'] ?? ''),
        body: bytes,
        truncated,
        finalUrl: url.toString(),
      }
    }
  } catch (err) {
    if (signal.aborted) throw new Error(`request timed out after ${Math.round(opts.timeoutMs / 1000)}s`)
    throw err
  }
}
