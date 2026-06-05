# Task: Dave's Agentic Loop
**ID:** task-012
**Assigned to:** openrouter
**Size:** large
**Depends on:** providers/types.ts, providers/local.ts, providers/openrouter.ts, agents/registry.ts (all done)

---

## What to build

`gateway/src/loop.ts` — the core agentic loop for Mission Control.

This is the engine that runs Dave (the Tier 1 personal agent). It receives a user message, calls the model via a provider adapter, streams the response to the client, handles tool calls (stubbed for now — tools are Phase 4), and loops until the model produces a final text response.

**Phase 2 scope — no tools yet.** Tool execution is stubbed with a placeholder response. The infrastructure for handling tool calls (checking capabilities, returning stub results, looping back) MUST be correct because Phase 4 will slot real executors in. The stub must be clearly marked with a `// Phase 4:` comment.

---

## File to create

`gateway/src/loop.ts`

Working directory for OpenCode: `/users/jb/mission-control/gateway`

---

## What you can import

These files already exist — import from them:

```typescript
import { randomUUID } from 'node:crypto'
import type { ProviderAdapter, Message, StreamChunk } from './providers/types.js'
import { AgentRegistry } from './agents/registry.js'
import type { AgentStatus } from './types.js'
```

The `broadcast` function signature from `broadcast.ts` (already exists):
```typescript
sendEvent(client: ConnectedClient, event: PushEventName, payload: Record<string, unknown>): void
```

You do NOT import sendEvent directly. Instead, `AgentLoopConfig` receives a `broadcast` callback — see below. This keeps loop.ts decoupled from the WebSocket layer.

Do NOT import from: session store, memory loader, monitor buffer, tools — none of those exist yet (Phases 3–5).

---

## Spec

### Config and public interface

```typescript
export interface AgentLoopConfig {
  agentId: string          // e.g. 'tier1_agent' — used for registry lookups
  provider: ProviderAdapter
  model: string            // e.g. 'gemma-4-27b-it'
  registry: AgentRegistry
  // Callback to push a GatewayEvent to one specific client.
  // Signature: (clientId, eventName, payload) => void
  broadcast: (clientId: string, event: string, payload: Record<string, unknown>) => void
  maxIterations?: number   // hard cap on tool-call loop iterations. Default: 20
}

export interface RunParams {
  message: string    // the user's message text
  sessionId: string
  clientId: string   // which connected client receives the streamed events
  correlationId?: string  // if omitted, one is assigned at the top of run()
}

export class AgentLoop {
  constructor(config: AgentLoopConfig)
  async run(params: RunParams): Promise<void>
}
```

---

### run() — step by step

**Step 1 — Assign correlationId**

```typescript
const correlationId = params.correlationId ?? randomUUID()
```

This correlationId flows through every event and provider call in this turn. Never omit it.

**Step 2 — Send agent.status: thinking**

Broadcast to the client:
```json
{ "agentId": "<agentId>", "sessionId": "<sessionId>", "status": "thinking", "correlationId": "<id>" }
```
Event name: `agent.status`

**Step 3 — Build the message history**

Phase 3 will add real session loading. For now, stub it:
```typescript
// Phase 3: load session history from SQLite
const history: Message[] = []
```

Build the messages array:
```typescript
const messages: Message[] = [
  { role: 'system', content: buildSystemPrompt() },  // see below
  ...history,
  { role: 'user', content: params.message },
]
```

**Step 4 — Build the system prompt**

```typescript
function buildSystemPrompt(): string {
  // Phase 5: load SOUL.md + AGENTS.md + IDENTITY.md + daily note from memory system
  // For now return a minimal placeholder so the model has something to work with
  return 'You are Dave, a personal AI agent running inside Mission Control.'
}
```

**Step 5 — Tool definitions**

```typescript
// Phase 4: build tool definitions from the registry + tool executor
// For now, pass no tools to the model (undefined)
const tools = undefined
```

**Step 6 — The model loop**

This is the core. Run a loop with a hard iteration limit:

```typescript
let iterations = 0
const maxIterations = this.config.maxIterations ?? 20

while (iterations < maxIterations) {
  iterations++

  // call the provider
  const stream = this.config.provider.complete({
    model: this.config.model,
    messages,
    tools,
    correlationId,
  })

  let responseText = ''
  const pendingToolCalls: ToolCall[] = []

  // stream the response
  for await (const chunk of stream) {
    if (chunk.type === 'text_delta') {
      responseText += chunk.delta
      // stream to client
      this.broadcast(clientId, 'chat.delta', { delta: chunk.delta, correlationId })
    }

    if (chunk.type === 'tool_call') {
      pendingToolCalls.push(chunk.toolCall)
    }

    if (chunk.type === 'done') {
      // Phase 3: write model_call_log row via monitor buffer
      // usage: chunk.usage
    }
  }

  // If the model produced text and no tool calls — we are done
  if (pendingToolCalls.length === 0) {
    // append the assistant response to history
    messages.push({ role: 'assistant', content: responseText })

    // Phase 3: persist turn to session store

    // send chat.final
    this.broadcast(clientId, 'chat.final', {
      text: responseText,
      sessionId,
      correlationId,
    })
    break
  }

  // Tool calls — handle each one
  // Append the assistant turn with tool_calls to messages
  messages.push({
    role: 'assistant',
    content: responseText,  // may be empty string if model went straight to tools
    tool_calls: pendingToolCalls,
  })

  // send agent.status: thinking (between tool rounds)
  this.broadcast(clientId, 'agent.status', {
    agentId: this.config.agentId,
    sessionId,
    status: 'thinking' as AgentStatus,
    correlationId,
  })

  for (const toolCall of pendingToolCalls) {
    const permitted = this.config.registry.hasCapability(this.config.agentId, toolCall.name)

    if (!permitted) {
      // Security violation — tool not in this agent's credential list
      // Phase 3: write to error_log via monitor buffer
      console.warn(
        `[loop] ${correlationId} SECURITY: agent "${this.config.agentId}" ` +
        `attempted unpermitted tool "${toolCall.name}" — returning error to model`
      )
      messages.push({
        role: 'tool',
        content: JSON.stringify({
          error: `Tool "${toolCall.name}" is not permitted for this agent.`,
        }),
        tool_call_id: toolCall.id,
      })
      continue
    }

    // Permitted — send agent.status: tool_running
    this.broadcast(clientId, 'agent.status', {
      agentId: this.config.agentId,
      sessionId,
      status: 'tool_running' as AgentStatus,
      detail: toolCall.name,
      correlationId,
    })

    // Phase 4: execute the tool and get a real result
    // For now, return a stub so the loop structure is correct
    const toolResult = {
      result: `Tool "${toolCall.name}" invoked successfully (stub — Phase 4 will wire real execution).`,
      stub: true,
    }

    // Phase 3: write tool_call_log row via monitor buffer (hash the payload, never raw)

    messages.push({
      role: 'tool',
      content: JSON.stringify(toolResult),
      tool_call_id: toolCall.id,
    })
  }

  // loop back to model with tool results appended
}

if (iterations >= maxIterations) {
  // Hard limit hit — send an error event and stop
  this.broadcast(clientId, 'chat.final', {
    text: '[Loop limit reached — the agent stopped after the maximum number of iterations.]',
    sessionId,
    correlationId,
    error: 'max_iterations_exceeded',
  })
}
```

**Step 7 — Always send agent.status: idle when done**

After the loop exits (success or limit), always broadcast:
```json
{ "agentId": "...", "sessionId": "...", "status": "idle", "correlationId": "..." }
```

**Step 8 — Error handling**

Wrap the entire run() body in a try/catch. On any unhandled error:
- broadcast `agent.status: error` with `{ detail: err.message, correlationId }`
- broadcast `chat.final` with `{ text: '[An error occurred. See gateway logs.]', error: 'internal', correlationId }`
- log the error to console with the correlationId

---

### Context budget warning

After building the full messages array on each iteration, do a rough token estimate:
```typescript
function estimateTokens(messages: Message[]): number {
  const chars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0)
  return Math.ceil(chars / 4)  // rough: 1 token ≈ 4 chars
}
```

If estimated tokens > 100_000 (roughly 80% of a 128k context):
- broadcast `agent.status: context_warning` with `{ estimatedTokens, correlationId }`
- continue the loop (do NOT truncate or compact — the agent handles context management in Phase 5)

---

### Private helper — the broadcast wrapper

Inside the class, add a private method to reduce repetition:
```typescript
private broadcast(clientId: string, event: string, payload: Record<string, unknown>): void {
  this.config.broadcast(clientId, event, payload)
}
```

---

## Acceptance criteria

- [ ] `AgentLoop` class exported from `gateway/src/loop.ts`
- [ ] `AgentLoopConfig` and `RunParams` interfaces exported
- [ ] `correlationId` assigned at top of `run()` if not provided — flows to ALL events and the provider call
- [ ] `agent.status: thinking` sent at start of run
- [ ] Model called via `provider.complete()` — response streamed correctly
- [ ] `chat.delta` events sent for every `text_delta` chunk
- [ ] Loop exits cleanly when model returns text with no tool calls
- [ ] `chat.final` sent with full text and correlationId
- [ ] `agent.status: idle` always sent when run() completes (success or error)
- [ ] Tool calls: `registry.hasCapability()` called for every tool before executing
- [ ] Unpermitted tool: error returned to model as tool result, `console.warn` logged, loop continues
- [ ] Permitted tool: stub result returned (clearly marked `// Phase 4:`), loop continues
- [ ] Hard iteration limit enforced — sends `chat.final` with error field if limit hit
- [ ] Context budget estimate computed each iteration — `agent.status: context_warning` if > 100k tokens
- [ ] All Phase 3/4/5 stubs clearly marked with `// Phase 3:`, `// Phase 4:`, `// Phase 5:` comments
- [ ] Zero TypeScript errors (`node node_modules/typescript/bin/tsc --noEmit` from gateway/)
- [ ] No use of `any` — strict TypeScript throughout

## Do not

- Do not import from session store, memory loader, monitor buffer, or tools — none exist yet
- Do not implement real tool execution — stub only
- Do not truncate or compact the message history — context management is Phase 5
- Do not hardcode 'Dave' anywhere except the stub system prompt (where it's clearly a placeholder)
- Do not bind to WebSocket directly — use only the `broadcast` callback
- Do not add any external npm dependencies
