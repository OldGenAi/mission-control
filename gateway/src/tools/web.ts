/**
 * tools/web.ts — web_fetch and web_search
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * web_fetch: blocks requests to private IP ranges (SSRF protection). The agent
 * must not be able to reach internal network services by giving it a URL.
 *
 * web_search: calls a search API. Requires SEARCH_API_KEY env var. Returns
 * a stub if the key is absent — the tool exists in the registry but fails
 * gracefully so the agent can report the issue.
 */

import { redact } from '../store/redact.js'
import type { RegisteredTool, ToolContext, ToolResult } from './types.js'

// ---------------------------------------------------------------------------
// HTML stripping — removes tags, scripts, styles, collapses whitespace
// Keeps visible text only. Prevents 512KB HTML blowing up the model context.
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    // Drop <script> and <style> blocks wholesale
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // Drop HTML comments
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Replace block-level tags with newlines so paragraphs stay readable
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article|header|footer|nav|main)>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    // Collapse runs of whitespace to single spaces / newlines
    .replace(/[ \t]+/g, ' ')
    .replace(/( \n)+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------
// SSRF protection — private IP range block
// ---------------------------------------------------------------------------

function isPrivateHost(hostname: string): boolean {
  let h = hostname.replace(/^\[|\]$/g, '').toLowerCase()

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) — unwrap to the embedded IPv4 and check that,
  // so the mapped form can't smuggle a loopback/private address past the IPv4 rules.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h)
  if (mapped) h = mapped[1]

  // IPv6 literals (contain a colon)
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true   // loopback / unspecified
    if (/^fe[89ab]/.test(h)) return true         // link-local fe80::/10
    if (/^f[cd]/.test(h)) return true            // unique-local fc00::/7
    return false
  }

  // Hostnames + IPv4
  if (h === 'localhost' || h === 'metadata.google.internal') return true
  if (/^127\./.test(h)) return true                                    // loopback
  if (h === '0.0.0.0' || /^0\./.test(h)) return true                   // unspecified / 0.0.0.0/8
  if (/^10\./.test(h)) return true                                     // RFC 1918
  if (/^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true  // CGNAT RFC 6598
  if (/^169\.254\./.test(h)) return true                              // link-local incl. cloud metadata 169.254.169.254

  return false
}

// Fetch with SSRF-safe redirect handling: a public URL can 302-redirect to a private or
// metadata address, which the single up-front host check misses. We follow redirects
// manually and re-validate every hop's host + protocol before continuing. Capped to avoid loops.
const MAX_REDIRECTS = 5
async function ssrfSafeFetch(initialUrl: string, init: RequestInit): Promise<Response> {
  let url = initialUrl
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { ...init, redirect: 'manual' })
    if (res.status < 300 || res.status >= 400) return res
    const location = res.headers.get('location')
    if (!location) return res
    if (hop >= MAX_REDIRECTS) throw new Error('SSRF protection: too many redirects')
    const next = new URL(location, url)   // resolves relative redirects against the current hop
    if (!['http:', 'https:'].includes(next.protocol)) {
      throw new Error(`SSRF protection: redirect to disallowed protocol "${next.protocol}"`)
    }
    if (isPrivateHost(next.hostname)) {
      throw new Error(`SSRF protection: redirect to private/reserved host "${next.hostname}" blocked`)
    }
    url = next.toString()
  }
}

function makeResult(
  correlationId: string,
  toolName: string,
  start: number,
  output: string,
  error?: string
): ToolResult {
  return {
    correlationId,
    toolName,
    status: error ? 'error' : 'ok',
    output,
    error,
    durationMs: Date.now() - start,
  }
}

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

export const webFetch: RegisteredTool = {
  schema: {
    name: 'web_fetch',
    description: 'Fetch the content of a public URL. Private IP addresses and internal network hosts are blocked.',
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch. Must be a public internet address.',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST'],
          description: 'HTTP method. Defaults to GET.',
        },
        body: {
          type: 'string',
          description: 'Request body for POST requests.',
        },
        headers: {
          type: 'object',
          description: 'Optional HTTP headers as key-value pairs.',
        },
        maxBytes: {
          type: 'number',
          description: 'Maximum response size in bytes. Defaults to 524288 (512 KB).',
        },
      },
    },
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const start = Date.now()
    const rawUrl = args['url']

    if (typeof rawUrl !== 'string' || !rawUrl) {
      return makeResult(context.correlationId, 'web_fetch', start, '', 'url must be a non-empty string')
    }

    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return makeResult(context.correlationId, 'web_fetch', start, '', `invalid URL: "${rawUrl}"`)
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return makeResult(context.correlationId, 'web_fetch', start, '', `protocol "${parsed.protocol}" is not allowed — use http or https`)
    }

    if (isPrivateHost(parsed.hostname)) {
      return makeResult(
        context.correlationId,
        'web_fetch',
        start,
        '',
        `SSRF protection: "${parsed.hostname}" is a private or reserved host — access denied`
      )
    }

    const method = (args['method'] as string | undefined)?.toUpperCase() ?? 'GET'
    const maxBytes = typeof args['maxBytes'] === 'number' ? args['maxBytes'] : 512 * 1024

    const rawHeaders = args['headers']
    const headers: Record<string, string> = {
      'User-Agent': 'MissionControl/1.0',
    }
    if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (typeof v === 'string') headers[k] = v
      }
    }

    try {
      const response = await ssrfSafeFetch(rawUrl, {
        method,
        headers,
        body: method === 'POST' && typeof args['body'] === 'string' ? args['body'] : undefined,
        signal: AbortSignal.timeout(15_000),
      })

      const buffer = await response.arrayBuffer()
      const truncated = buffer.byteLength > maxBytes
      const slice = truncated ? buffer.slice(0, maxBytes) : buffer
      const raw = new TextDecoder().decode(slice)

      // Strip HTML to plain text for HTML responses — raw HTML is 128k+ tokens
      const contentType = response.headers.get('content-type') ?? ''
      const isHtml = contentType.includes('text/html') || raw.trimStart().startsWith('<')
      const body = isHtml ? stripHtml(raw) : raw

      // Hard cap on what goes to the model — prevent context overflow
      const MODEL_MAX_CHARS = 24_000   // ~6k tokens, plenty for any page content
      const modelBody = body.length > MODEL_MAX_CHARS
        ? body.slice(0, MODEL_MAX_CHARS) + '\n[truncated — output too large]'
        : body

      const result = JSON.stringify({
        status: response.status,
        ok: response.ok,
        url: rawUrl,
        body: modelBody,
        truncated: truncated || body.length > MODEL_MAX_CHARS,
        byteLength: buffer.byteLength,
      })

      return makeResult(context.correlationId, 'web_fetch', start, result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return makeResult(context.correlationId, 'web_fetch', start, '', redact(msg))
    }
  },
}

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

// Injectable key source: lets web_search read the live UI value (Settings → Providers →
// Web Search) and fall back to the SEARCH_API_KEY env var. Wired in index.ts. Reading it
// per-call means a UI edit takes effect immediately — no gateway restart.
let getSearchApiKey: () => string | undefined = () => process.env['SEARCH_API_KEY']
export function setSearchApiKeySource(fn: () => string | undefined): void {
  getSearchApiKey = fn
}

export const webSearch: RegisteredTool = {
  schema: {
    name: 'web_search',
    description: 'Search the web and return a list of results with titles, URLs, and snippets. Requires SEARCH_API_KEY environment variable.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'The search query.',
        },
        count: {
          type: 'number',
          description: 'Number of results to return. Defaults to 5, max 10.',
        },
      },
    },
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const start = Date.now()
    const apiKey = getSearchApiKey()

    if (!apiKey) {
      return makeResult(
        context.correlationId,
        'web_search',
        start,
        '',
        'web_search is not configured — add a key in Settings → Providers → Web Search (or set SEARCH_API_KEY)'
      )
    }

    const query = args['query']
    if (typeof query !== 'string' || !query) {
      return makeResult(context.correlationId, 'web_search', start, '', 'query must be a non-empty string')
    }

    const count = Math.min(typeof args['count'] === 'number' ? args['count'] : 5, 10)

    try {
      // Brave Search API — swap for another provider by changing this block
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      })

      if (!response.ok) {
        return makeResult(context.correlationId, 'web_search', start, '', `search API returned ${response.status}`)
      }

      const data = await response.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } }
      const results = data.web?.results?.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.description,
      })) ?? []

      return makeResult(context.correlationId, 'web_search', start, JSON.stringify({ results }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return makeResult(context.correlationId, 'web_search', start, '', redact(msg))
    }
  },
}
