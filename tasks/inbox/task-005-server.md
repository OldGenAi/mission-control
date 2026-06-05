# Task: HTTP + WebSocket Server
**ID:** task-005
**Assigned to:** openrouter
**Size:** large
**Depends on:** task-001 (types.ts), task-002 (auth.ts), task-003 (broadcast.ts), task-004 (router.ts)
**Phase:** 1 — Gateway Foundation

---

## What to build

The core server file. Creates the Express HTTP server and the WebSocket server, wires auth and routing, manages the connection lifecycle. This is the heart of the gateway.

## File to create

`gateway/src/server.ts`

---

## Context

Mission Control is a standalone agentic OS. The gateway is a Node.js process that runs persistently on the local machine. It listens only on loopback (`127.0.0.1:4747`) — never on `0.0.0.0`. The browser UI connects to it over WebSocket. All agents run inside the gateway process.

This file has already been reviewed for security requirements. Implement exactly what is specified.

---

## Spec

### Imports

```typescript
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import express from 'express'
import { validateToken, validateOrigin } from './auth.js'
import { addClient, removeClient, sendResponse, sendEvent, broadcastEvent } from './broadcast.js'
import { dispatch, registerMethod } from './router.js'
import type { ConnectedClient, GatewayRequest } from './types.js'
import { ERROR_CODES } from './types.js'
import { randomUUID } from 'crypto'
```

### Constants

```typescript
const PORT = 4747
const HOST = '127.0.0.1'
```

### startServer function

```typescript
export async function startServer(): Promise<void>
```

Inside `startServer`:

1. Create Express app
2. Add `express.json()` middleware
3. Add a single HTTP route: `GET /health` → returns `{ ok: true, uptime: <seconds> }`
4. Create `http.createServer(app)`
5. Create `WebSocketServer({ server, host: HOST })`
6. Attach WebSocket event handlers (see below)
7. Register all method handlers with `registerMethod` (health only for Phase 1 — see task-007)
8. Call `server.listen(PORT, HOST, callback)` — resolve the Promise in the callback
9. Log `[gateway] listening on ws://127.0.0.1:4747`

### WebSocket connection handler

On each new WebSocket `connection` event:

```
1. Check Origin header (from the upgrade request):
   - Call validateOrigin(request.headers.origin)
   - If it returns false: terminate the socket immediately, do not create a client
   - No error message to the client — just terminate

2. Create a ConnectedClient:
   { id: randomUUID(), ws, authed: false, connectedAt: Date.now() }

3. Register with addClient(client)

4. Send the auth challenge:
   sendEvent(client, 'connect.challenge', { nonce: randomUUID() })
   Store the nonce on a local Map<string, string> keyed by client.id

5. Set a 10-second auth timeout:
   If the client has not authed within 10 seconds, terminate the socket

6. Attach message handler (see below)

7. On 'close': removeClient(client.id), clear the auth timeout
8. On 'error': log the error, removeClient(client.id)
```

### WebSocket message handler

On each `message` event for a connected client:

```
1. Parse the message as JSON. If parse fails: send error response with code INVALID_PARAMS

2. Check message.type === 'req'. Anything else: ignore silently.

3. Assign a correlationId = randomUUID() for this request

4. If !client.authed AND method !== 'connect':
   Send res: { ok: false, error: { code: 'AUTH_FAILED', message: 'Not authenticated' } }
   Return — do not dispatch.

5. Call dispatch(message.method, message.params, client):
   - On success: sendResponse(client, { type: 'res', id: message.id, ok: true, payload: result })
   - On METHOD_NOT_FOUND error: sendResponse with ok: false, error from dispatch
   - On any other error: sendResponse with ok: false, error: { code: 'INTERNAL_ERROR', message: err.message }
   Log errors with [gateway] prefix and include correlationId
```

### Connect method (inline in server.ts for Phase 1)

Register the `connect` method inline for now (task-006 will replace this with the proper handler):

```typescript
registerMethod('connect', async (params, client) => {
  // This placeholder just marks the client as authed
  // The real connect handler with nonce validation is in task-006
  const token = params.token as string
  if (!validateToken(token)) {
    throw { code: 'AUTH_FAILED', message: 'Invalid token' }
  }
  client.authed = true
  // Clear auth timeout for this client
  return { type: 'hello-ok', features: { methods: listMethods(), events: [] } }
})
```

Note: `listMethods` is imported from `./router.js`

### stopServer function

```typescript
export async function stopServer(): Promise<void>
```

Broadcasts a `shutdown` event to all clients, closes the WebSocket server, closes the HTTP server.

---

## Acceptance criteria

- [ ] Compiles with zero TypeScript errors
- [ ] Gateway binds to `127.0.0.1:4747` only — not `0.0.0.0`
- [ ] WebSocket connections with invalid Origin are terminated before a client is created
- [ ] Unauthenticated clients can only call `connect` — all other methods get AUTH_FAILED
- [ ] Auth timeout: client terminated after 10s if not authed
- [ ] JSON parse errors return INVALID_PARAMS, not a crash
- [ ] `startServer` and `stopServer` both exported
- [ ] Errors logged with correlationId

## Do not

- Do not bind to any address other than `127.0.0.1`
- Do not allow unauthenticated clients to call any method except `connect`
- Do not swallow errors silently — log them with correlationId
- Do not add any agent, provider, or database logic — this is infrastructure only
- Do not use `any` types
