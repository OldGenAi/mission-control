# Task: Shared Types
**ID:** task-001
**Assigned to:** gemma
**Size:** small
**Depends on:** nothing
**Phase:** 1 — Gateway Foundation

---

## What to build

Create the shared TypeScript type definitions used across the entire gateway. This is the foundation — every other file imports from here. Get this right and the rest of Phase 1 flows cleanly.

## File to create

`gateway/src/types.ts`

---

## Spec

### Wire protocol types

The gateway communicates over WebSocket using three message types:

```typescript
// Client → Gateway
interface GatewayRequest {
  type: 'req'
  id: string           // UUID, client-generated, used to match the response
  method: string       // e.g. "health", "chat.send"
  params: Record<string, unknown>
}

// Gateway → Client (response to a req)
interface GatewayResponse {
  type: 'res'
  id: string           // matches the request id
  ok: boolean
  payload?: Record<string, unknown>   // present when ok: true
  error?: {
    code: string       // e.g. "METHOD_NOT_FOUND", "AUTH_FAILED", "INVALID_PARAMS"
    message: string
  }
}

// Gateway → Client (server-initiated push)
interface GatewayEvent {
  type: 'event'
  event: string        // e.g. "chat.delta", "agent.status"
  payload: Record<string, unknown>
  seq?: number         // optional sequence number for ordering
}

type GatewayMessage = GatewayRequest | GatewayResponse | GatewayEvent
```

### Connected client

Represents a WebSocket connection that has completed the auth handshake:

```typescript
interface ConnectedClient {
  id: string                    // UUID assigned on connection
  ws: import('ws').WebSocket
  authed: boolean               // true once connect handshake completes
  connectedAt: number           // unix timestamp ms
}
```

### Push event names

String union of all valid push event names:

```typescript
type PushEventName =
  | 'connect.challenge'
  | 'chat.delta'
  | 'chat.final'
  | 'agent.status'
  | 'session.tool'
  | 'sessions.changed'
  | 'pipeline.tick'
  | 'pipeline.approval'
  | 'monitor.tick'
  | 'presence'
  | 'shutdown'
  | 'error.occurred'
```

### Agent status

```typescript
type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'tool_running'
  | 'context_warning'
  | 'error'
  | 'stopped'

interface AgentStatusEvent {
  agentId: string
  sessionId?: string
  status: AgentStatus
  detail?: string      // e.g. tool name when status is "tool_running"
  correlationId?: string
}
```

### Error codes

```typescript
const ERROR_CODES = {
  AUTH_FAILED: 'AUTH_FAILED',
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  INVALID_PARAMS: 'INVALID_PARAMS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
} as const

type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES]
```

### Method handler type

The shape every method handler must implement:

```typescript
type MethodHandler = (
  params: Record<string, unknown>,
  client: ConnectedClient
) => Promise<Record<string, unknown>>
```

---

## Acceptance criteria

- [ ] File compiles with `tsc --noEmit` with zero errors
- [ ] All types exported (use `export` on every interface/type/const)
- [ ] `GatewayMessage` is a discriminated union (the `type` field is the discriminant)
- [ ] `ConnectedClient` imports `WebSocket` from `ws` correctly — use `import type` or a regular import
- [ ] No `any` types anywhere

## Do not

- Do not import from any other gateway src file (this is the foundation, it has no deps)
- Do not add runtime logic — this file is types only
- Do not use `namespace` or `enum` — use `const` objects and `typeof` unions instead
- Do not add placeholder or example values — types only
