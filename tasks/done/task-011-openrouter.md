# Task: OpenRouter Provider Adapter
**ID:** task-011
**Assigned to:** gemma
**Size:** small
**Depends on:** providers/types.ts and providers/local.ts (both must exist)
**Phase:** 2 — Provider + Loop

---

## What to build

The OpenRouter provider adapter. OpenRouter speaks the OpenAI-compatible API format, so this is a thin wrapper around LocalProvider that swaps in the OpenRouter base URL and requires an API key.

## File to create

`gateway/src/providers/openrouter.ts`

---

## Spec

```typescript
import { LocalProvider, type LocalProviderConfig } from './local.js'
import type { ProviderAdapter } from './types.js'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export interface OpenRouterConfig {
  apiKey: string   // required — from env var OPENROUTER_API_KEY
  name?: string    // defaults to 'openrouter'
}

export class OpenRouterProvider implements ProviderAdapter {
  private readonly inner: LocalProvider
  readonly name: string

  constructor(config: OpenRouterConfig) {
    // OpenRouter is cloud — bypass the loopback check in LocalProvider
    // by passing the URL directly to the OpenAI client, not through LocalProvider.
    // See implementation note below.
  }

  // Delegate complete() to the inner LocalProvider instance
  complete = this.inner.complete.bind(this.inner)
}
```

### Implementation note

`LocalProvider` enforces loopback-only URLs. OpenRouter is a cloud URL so it cannot use `LocalProvider` directly. Instead, `OpenRouterProvider` should create its own `OpenAI` client pointed at `https://openrouter.ai/api/v1` with the API key, and implement `complete()` by delegating to a `LocalProvider`-style implementation — OR duplicate the minimal OpenAI client setup inline.

The simplest correct approach: do NOT extend LocalProvider. Instead, import `OpenAI` from `openai` directly and create a client with the OpenRouter baseURL. Then implement `complete()` by calling the same streaming logic as local.ts — you can copy and adapt it. The key difference is no SSRF check (OpenRouter is intentionally a cloud endpoint).

```typescript
import OpenAI from 'openai'
import type { ProviderAdapter, CompletionRequest, StreamChunk, ToolCall } from './types.js'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

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
    // same streaming logic as local.ts — tool accumulation, text_delta, done
  }
}
```

---

## Acceptance criteria

- [ ] Compiles with zero TypeScript errors
- [ ] `OpenRouterProvider` implements `ProviderAdapter`
- [ ] `name` defaults to `'openrouter'`
- [ ] `complete()` streams text deltas, tool calls, and a final done chunk
- [ ] No loopback check — OpenRouter is a cloud endpoint
- [ ] No `any` types

## Do not

- Do not import from any file other than `./types.js` and `openai`
- Do not add retry logic, logging, or error swallowing
- Do not hardcode a model name — model comes from `request.model`
