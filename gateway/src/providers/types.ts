/**
 * providers/types.ts — ProviderAdapter interface
 *
 * The contract every provider adapter must implement.
 * local.ts, openrouter.ts, and anthropic.ts all satisfy this interface.
 *
 * Do not add runtime logic here — types only.
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string                         // unique ID — matches tool result back to call
  name: string                       // tool name
  arguments: Record<string, unknown> // parsed JSON arguments from the model
}

export interface Message {
  role: MessageRole
  content: string          // text content — empty string if tool_calls is present
  tool_calls?: ToolCall[]  // set on assistant messages that invoke tools
  tool_call_id?: string    // set on tool messages — matches ToolCall.id
}

// ---------------------------------------------------------------------------
// Tool definitions (sent to the model)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON schema object
}

// ---------------------------------------------------------------------------
// Completion request
// ---------------------------------------------------------------------------

export interface CompletionRequest {
  model: string
  messages: Message[]
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
  /**
   * Reasoning effort hint for models that expose chain-of-thought (OpenRouter
   * reasoning models, future Anthropic extended thinking). Adapters that don't
   * support it silently drop the field — never an error.
   */
  reasoning?: { effort: 'low' | 'medium' | 'high' }
  correlationId: string // flows through to model_call_log — required, never omit
  /** Abort signal for user-initiated cancellation. Passed as the SDK's request-
   *  option `signal`, so firing it cancels the in-flight HTTP request mid-stream.
   *  The loop treats an aborted stream as a clean stop, never a PROVIDER_ERROR. */
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Streaming output
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/**
 * StreamChunk — what complete() yields on each iteration.
 *
 * text_delta  — a token or partial token of text output. Stream to the client.
 * tool_call   — the model wants to call a tool. Execute it, append result, loop.
 * done        — stream is finished. usage is always present. `error` is set when
 *               the stream ended because of an upstream failure (e.g. a 429
 *               rate-limit) rather than normal completion — see the
 *               ProviderAdapter contract below.
 */
export type StreamChunk =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'done'; usage: TokenUsage; error?: string }

// ---------------------------------------------------------------------------
// ProviderAdapter — the interface all adapters implement
// ---------------------------------------------------------------------------

/**
 * Every provider adapter implements this interface.
 *
 * complete() is an async generator — use `for await (const chunk of adapter.complete(req))`.
 * It must always yield exactly one `done` chunk as the final item.
 * It must never throw — an upstream error (network failure, 429 rate-limit, etc.)
 * is surfaced as a final `done` chunk with `error` set and whatever usage was read
 * (zero if the failure happened before the first token). Callers detect failure by
 * checking `done.error`, never via try/catch around the iteration.
 */
export interface ProviderAdapter {
  readonly name: string // e.g. 'lmstudio', 'openrouter', 'anthropic'
  complete(request: CompletionRequest): AsyncIterable<StreamChunk>
}
