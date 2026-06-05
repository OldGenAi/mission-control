import OpenAI from 'openai'
import { jsonrepair } from 'jsonrepair'
import type { Message } from './types.js'

type OpenAIMessage = OpenAI.Chat.ChatCompletionMessageParam

export function toOpenAIMessages(messages: Message[]): OpenAIMessage[] {
  return messages.map((m): OpenAIMessage => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.tool_call_id ?? '',
      }
    }

    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      }
    }

    return {
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    }
  })
}

// ---------------------------------------------------------------------------
// Stall guard for streaming completions
// ---------------------------------------------------------------------------

/**
 * Aborts a streaming completion when the upstream goes silent.
 *
 * Neither the OpenAI SDK's request `timeout` nor undici's body timeout protect a
 * live stream: both only bound time-to-headers, and OpenRouter's SSE keep-alive
 * comments reset undici's body timeout — so a stalled provider (e.g. a saturated
 * free-tier queue) can hang a turn for 5 minutes or indefinitely. This guard
 * aborts if no chunk arrives within `stallMs`, resetting the clock on every
 * chunk — catching both a response that never starts and a mid-stream death that
 * keep-alives would otherwise mask. The reset means a healthy slow stream (a cold
 * local model taking 50s to first token, then streaming for minutes) is never cut.
 *
 *   const guard = createStallGuard(request.signal, STALL_MS)
 *   try {
 *     const stream = await client.chat.completions.create(body, { signal: guard.signal })
 *     for await (const chunk of stream) { guard.beat(); ... }
 *   } finally { guard.dispose() }
 *
 * On abort the SDK throws; check `guard.timedOut` in the catch to tell a stall
 * (surface a friendly message) apart from a user cancellation (request.signal).
 */
export interface StallGuard {
  /** Pass as the SDK request-option `signal`. Fires on stall OR user abort. */
  readonly signal: AbortSignal
  /** Call on every received chunk — resets the stall clock. */
  beat(): void
  /** Always call in `finally` — clears the pending timer. */
  dispose(): void
  /** True once the stall timer fired (vs a user-initiated abort). */
  readonly timedOut: boolean
}

export function createStallGuard(userSignal: AbortSignal | undefined, stallMs: number): StallGuard {
  const watchdog = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  let timedOut = false

  const beat = () => {
    clearTimeout(timer)
    timer = setTimeout(() => { timedOut = true; watchdog.abort() }, stallMs)
  }
  beat() // arm for the first chunk

  const signal = userSignal
    ? AbortSignal.any([userSignal, watchdog.signal])
    : watchdog.signal

  return {
    signal,
    beat,
    dispose: () => clearTimeout(timer),
    get timedOut() { return timedOut },
  }
}

// ---------------------------------------------------------------------------
// Tool-call argument parsing (with repair fallback)
// ---------------------------------------------------------------------------

/**
 * Parse the JSON arguments of a streamed tool call into an object.
 *
 * Models occasionally emit malformed JSON — most commonly by nesting a JSON
 * object inside a string field and breaking the escaping partway through (Qwen
 * does this on rich artifact content). Strict JSON.parse rejects it, which used
 * to reach the tool as empty args → a visible validation error plus a wasted
 * self-correcting retry. We try a strict parse first, then a jsonrepair pass
 * before giving up. Returns {} only when the arguments are genuinely empty or
 * unrecoverable — the tool's own validation then handles that case as before.
 */
export function parseToolArguments(
  raw: string,
  ctx: { correlationId: string; toolName: string; provider: string },
): Record<string, unknown> {
  if (!raw || !raw.trim()) return {} // no arguments sent — let the tool validate

  const asObject = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

  try {
    const obj = asObject(JSON.parse(raw))
    if (obj) return obj
  } catch {
    /* malformed — fall through to the repair pass */
  }

  try {
    const obj = asObject(JSON.parse(jsonrepair(raw)))
    if (obj) {
      console.warn(`[${ctx.provider}] ${ctx.correlationId} repaired malformed arguments for tool "${ctx.toolName}"`)
      return obj
    }
  } catch {
    /* unrepairable — fall through */
  }

  console.error(`[${ctx.provider}] ${ctx.correlationId} tool "${ctx.toolName}" arguments unparseable even after repair:`, raw.slice(0, 200))
  return {}
}
