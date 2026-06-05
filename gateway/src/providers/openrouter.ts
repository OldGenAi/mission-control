/**
 * providers/openrouter.ts — OpenRouter cloud provider adapter
 *
 * OpenRouter speaks the OpenAI-compatible API format, so the streaming logic
 * mirrors local.ts. The key difference: no SSRF check — OpenRouter is
 * intentionally a cloud endpoint.
 */

import OpenAI from 'openai'
import type {
  ProviderAdapter,
  CompletionRequest,
  StreamChunk,
  ToolCall,
} from './types.js'
import { toOpenAIMessages, createStallGuard, parseToolArguments } from './utils.js'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

// Abort a stalled stream after this long with no chunk. Well under undici's 300s
// default so a saturated free-tier queue fails fast instead of hanging the turn
// for 5 minutes; comfortably above any healthy cloud time-to-first-token.
const STALL_MS = 120_000

// ---------------------------------------------------------------------------
// OpenRouterProvider
// ---------------------------------------------------------------------------

export interface OpenRouterConfig {
  apiKey: string  // from env var OPENROUTER_API_KEY
  name?: string   // defaults to 'openrouter'
}

export class OpenRouterProvider implements ProviderAdapter {
  readonly name: string
  private readonly client: OpenAI

  constructor(config: OpenRouterConfig) {
    this.name = config.name ?? 'openrouter'
    this.client = new OpenAI({
      baseURL: OPENROUTER_BASE_URL,
      apiKey: config.apiKey,
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

    // OpenRouter accepts `reasoning: { effort }` on reasoning-capable models.
    // The OpenAI SDK type doesn't model it, so we cast just the extension.
    const reasoningExt = request.reasoning ? { reasoning: request.reasoning } as Record<string, unknown> : {}

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
        ...reasoningExt,
      }, { signal: guard.signal })

      for await (const chunk of stream) {
        guard.beat()
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0
          outputTokens = chunk.usage.completion_tokens ?? 0
        }

        const choice = chunk.choices[0]
        if (!choice) continue

        const delta = choice.delta

        if (delta.content) {
          yield { type: 'text_delta', delta: delta.content }
        }

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

        // Some OpenRouter models send 'stop' when tools were accumulated instead of 'tool_calls'
        const shouldEmitTools =
          choice.finish_reason === 'tool_calls' ||
          (choice.finish_reason !== null && choice.finish_reason !== undefined && toolAccumulator.size > 0)

        if (shouldEmitTools && toolAccumulator.size > 0) {
          for (const [, acc] of toolAccumulator) {
            const args = parseToolArguments(acc.argumentsRaw, {
              correlationId: request.correlationId, toolName: acc.name, provider: 'openrouter',
            })
            const toolCall: ToolCall = { id: acc.id, name: acc.name, arguments: args }
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
        const msg = `model did not respond within ${STALL_MS / 1000}s — the provider may be busy (common on free tiers). Try again or switch model.`
        console.error(`[openrouter] ${request.correlationId} stall timeout — surfacing as done:`, msg)
        yield { type: 'done', usage: { inputTokens, outputTokens }, error: msg }
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[openrouter] ${request.correlationId} provider error — surfacing as done:`, msg)
      yield { type: 'done', usage: { inputTokens, outputTokens }, error: msg }
      return
    } finally {
      guard.dispose()
    }

    yield { type: 'done', usage: { inputTokens, outputTokens } }
  }
}
