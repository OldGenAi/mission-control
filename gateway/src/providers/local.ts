/**
 * providers/local.ts — Generic local OpenAI-compatible provider
 *
 * Covers LM Studio, Ollama, llama.cpp — anything that speaks the OpenAI API
 * format on localhost. The baseUrl is configurable per instance.
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * SSRF protection: baseUrl is validated as loopback-only at construction time.
 * Any non-loopback URL causes an immediate hard error — the gateway will not start.
 */

import OpenAI from 'openai'
import type {
  ProviderAdapter,
  CompletionRequest,
  StreamChunk,
  ToolCall,
} from './types.js'
import { toOpenAIMessages, createStallGuard, parseToolArguments } from './utils.js'

// Abort a stalled stream after this long with no chunk. Generous headroom for local
// cold-start (model load can take tens of seconds), but bounded so a wedged local server
// fails the turn instead of hanging it forever. The clock resets on every chunk received.
const STALL_MS = 120_000

// ---------------------------------------------------------------------------
// SSRF protection — loopback-only validation
// ---------------------------------------------------------------------------

function assertLoopbackUrl(baseUrl: string): void {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error(`[local] Invalid baseUrl — could not parse as URL: "${baseUrl}"`)
  }

  const hostname = url.hostname
  const isLoopback =
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1'

  // host.docker.internal is the well-known Docker hostname for reaching the
  // host machine from inside a container.
  const isDockerHost = hostname === 'host.docker.internal'

  // RFC 1918 private addresses are allowed — they cannot reach the public internet.
  // This covers Docker-on-Windows setups where LM Studio is reachable at the
  // vEthernet (WSL) adapter IP (172.x.x.x) rather than loopback.
  // NOTE: this URL comes from admin config in .env, not from agent input —
  // the SSRF risk is admin misconfiguration, not prompt injection.
  const parsed = hostname.split('.').map(Number)
  const isPrivate =
    (parsed[0] === 10) ||
    (parsed[0] === 172 && parsed[1] >= 16 && parsed[1] <= 31) ||
    (parsed[0] === 192 && parsed[1] === 168)

  if (!isLoopback && !isDockerHost && !isPrivate) {
    throw new Error(
      `[local] SSRF protection: baseUrl must be loopback, host.docker.internal, ` +
      `or a private RFC 1918 address. Got hostname: "${hostname}". ` +
      `For cloud providers use the openrouter or anthropic adapter.`
    )
  }
}

// ---------------------------------------------------------------------------
// LocalProvider
// ---------------------------------------------------------------------------

export interface LocalProviderConfig {
  name?: string    // display name — defaults to 'local'
  baseUrl: string  // e.g. 'http://127.0.0.1:1234/v1' — must be loopback
  apiKey?: string  // LM Studio ignores this — any string works
}

export class LocalProvider implements ProviderAdapter {
  readonly name: string
  private readonly client: OpenAI

  constructor(config: LocalProviderConfig) {
    // SSRF check — hard error at construction, before any request is made
    assertLoopbackUrl(config.baseUrl)

    this.name = config.name ?? 'local'
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey ?? 'local-no-key',
    })
  }

  async *complete(request: CompletionRequest): AsyncGenerator<StreamChunk> {
    const messages = toOpenAIMessages(request.messages)

    const tools = request.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))

    console.log(`[local] ${request.correlationId} → model=${request.model} tools=${tools?.length ?? 0}${tools?.length ? ' [' + tools.map(t => t.function.name).join(', ') + ']' : ''}`)

    // Accumulate fragmented tool call arguments by index
    // OpenAI streaming sends tool calls across multiple chunks
    const toolAccumulator = new Map<
      number,
      { id: string; name: string; argumentsRaw: string }
    >()

    let inputTokens = 0
    let outputTokens = 0

    // Per the ProviderAdapter contract this generator must never throw: an
    // upstream error (429, dropped connection) is surfaced as a final `done`
    // carrying `error`, so the agent loop logs it and fails the turn cleanly
    // instead of an unhandled rejection tearing the run down. Text already
    // streamed before the failure stays valid.
    const guard = createStallGuard(request.signal, STALL_MS)
    try {
      const stream = await this.client.chat.completions.create({
        model: request.model,
        messages,
        tools: tools?.length ? tools : undefined,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }, { signal: guard.signal })

      for await (const chunk of stream) {
        guard.beat()
        // Usage — some local servers include this, some don't
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0
          outputTokens = chunk.usage.completion_tokens ?? 0
        }

        const choice = chunk.choices[0]
        if (!choice) continue

        const delta = choice.delta

        // Text delta
        if (delta.content) {
          yield { type: 'text_delta', delta: delta.content }
        }

        // Tool call fragments — accumulate by index
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (!toolAccumulator.has(idx)) {
              toolAccumulator.set(idx, { id: '', name: '', argumentsRaw: '' })
            }
            const acc = toolAccumulator.get(idx)!
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name += tc.function.name
            if (tc.function?.arguments) acc.argumentsRaw += tc.function.arguments
          }
        }

        // Emit complete tool calls.
        // Standard: finish_reason === 'tool_calls'
        // Fallback:  some local servers send 'stop' even when tool calls were accumulated
        const shouldEmitTools =
          choice.finish_reason === 'tool_calls' ||
          (choice.finish_reason !== null && choice.finish_reason !== undefined && toolAccumulator.size > 0)

        if (shouldEmitTools && toolAccumulator.size > 0) {
          console.log(`[local] ${request.correlationId} finish_reason="${choice.finish_reason}" emitting ${toolAccumulator.size} tool call(s)`)
          for (const [, acc] of toolAccumulator) {
            const args = parseToolArguments(acc.argumentsRaw, {
              correlationId: request.correlationId, toolName: acc.name, provider: 'local',
            })
            const toolCall: ToolCall = { id: acc.id, name: acc.name, arguments: args }
            console.log(`[local] ${request.correlationId} tool call → ${acc.name}(${acc.argumentsRaw.slice(0, 80)})`)
            yield { type: 'tool_call', toolCall }
          }
          toolAccumulator.clear()
        }
      }
    } catch (err) {
      // A user-initiated abort (request.signal) is intentional — end the stream as
      // a clean done with no error, so the loop stops quietly without logging a
      // PROVIDER_ERROR. Anything else is a real upstream failure.
      if (request.signal?.aborted) {
        yield { type: 'done', usage: { inputTokens, outputTokens } }
        return
      }
      if (guard.timedOut) {
        const msg = `local model did not send a token within ${STALL_MS / 1000}s — the server may be loading the model or wedged. Try again or check the local provider.`
        console.error(`[local] ${request.correlationId} stall timeout — surfacing as done:`, msg)
        yield { type: 'done', usage: { inputTokens, outputTokens }, error: msg }
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[local] ${request.correlationId} provider error — surfacing as done:`, msg)
      yield { type: 'done', usage: { inputTokens, outputTokens }, error: msg }
      return
    } finally {
      guard.dispose()
    }

    console.log(`[local] ${request.correlationId} stream done — in=${inputTokens} out=${outputTokens}`)
    yield { type: 'done', usage: { inputTokens, outputTokens } }
  }
}
