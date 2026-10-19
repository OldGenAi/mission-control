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
import { guardedFetch } from './ssrf-guard.js'
import type { RegisteredTool, ToolContext, ToolResult } from './types.js'

// Ceiling on web_fetch response size. maxBytes is chosen by the model, so it is clamped here.
const FETCH_MAX_BYTES = 2 * 1024 * 1024
const FETCH_DEFAULT_BYTES = 512 * 1024

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

// SSRF protection (private/reserved address blocking, connect-time DNS check, redirect
// re-validation, capped body reads) lives in ./ssrf-guard.ts.

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

    const method = (args['method'] as string | undefined)?.toUpperCase() ?? 'GET'
    if (method !== 'GET' && method !== 'POST') {
      return makeResult(context.correlationId, 'web_fetch', start, '', `method "${method}" is not allowed — use GET or POST`)
    }
    const requestedBytes = typeof args['maxBytes'] === 'number' && Number.isFinite(args['maxBytes']) && args['maxBytes'] > 0
      ? Math.floor(args['maxBytes'])
      : FETCH_DEFAULT_BYTES
    const maxBytes = Math.min(requestedBytes, FETCH_MAX_BYTES)

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
      const response = await guardedFetch(rawUrl, {
        method,
        headers,
        body: method === 'POST' && typeof args['body'] === 'string' ? args['body'] : undefined,
        timeoutMs: 15_000,
        maxBytes,
      })

      const truncated = response.truncated
      const raw = new TextDecoder().decode(response.body)

      // Strip HTML to plain text for HTML responses — raw HTML is 128k+ tokens
      const contentType = response.contentType
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
        byteLength: response.body.byteLength,
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
    description: 'Search the web. Returns results with titles, URLs, snippets, and the recency of each result (age + page_age). For time-sensitive queries (news, current events, prices, "latest" or "today"), pass a freshness filter to restrict to recent results. Requires SEARCH_API_KEY.',
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
        freshness: {
          type: 'string',
          description: 'Optional recency filter for time-sensitive queries: "pd" (past 24h), "pw" (past week), "pm" (past month), "py" (past year), or a date range "YYYY-MM-DDtoYYYY-MM-DD". Omit for general queries that do not depend on how recent the result is.',
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

    // Optional recency filter (Brave `freshness`). Validate so only well-formed
    // values reach the API: pd/pw/pm/py or an explicit YYYY-MM-DDtoYYYY-MM-DD range.
    const freshnessRaw = typeof args['freshness'] === 'string' ? args['freshness'].trim() : ''
    const freshness = /^(pd|pw|pm|py|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/.test(freshnessRaw) ? freshnessRaw : ''

    try {
      // Brave Search API — swap for another provider by changing this block.
      // freshness (when set) restricts to recent pages; each result carries
      // age + page_age so the agent can judge how current a source is.
      let url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`
      if (freshness) url += `&freshness=${freshness}`
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

      interface BraveResult { title: string; url: string; description: string; age?: string; page_age?: string }
      const data = await response.json() as { web?: { results?: BraveResult[] } }
      const results = data.web?.results?.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.description,
        age: r.age,           // human-readable recency, e.g. "12 hours ago"
        pageAge: r.page_age,  // ISO timestamp of the page, when present
      })) ?? []

      return makeResult(context.correlationId, 'web_search', start, JSON.stringify({ freshness: freshness || 'any', results }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return makeResult(context.correlationId, 'web_search', start, '', redact(msg))
    }
  },
}
