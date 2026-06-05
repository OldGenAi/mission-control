# Task: Event Broadcaster
**ID:** task-003
**Assigned to:** gemma
**Size:** small
**Depends on:** task-001 (types.ts must exist first)
**Phase:** 1 — Gateway Foundation

---

## What to build

A simple broadcast module. The gateway pushes events to connected WebSocket clients. This module holds the client registry and provides functions to send events to one client or all clients.

## File to create

`gateway/src/broadcast.ts`

---

## Spec

```typescript
import type { ConnectedClient, GatewayEvent, GatewayResponse, PushEventName } from './types.js'
import { WebSocket } from 'ws'

// The live client registry — all currently connected + authed clients
// Key: client.id, Value: ConnectedClient
const clients = new Map<string, ConnectedClient>()

// Register a new client (called when a WebSocket connection opens)
function addClient(client: ConnectedClient): void

// Remove a client (called when a WebSocket connection closes)
function removeClient(clientId: string): void

// Get a client by ID
function getClient(clientId: string): ConnectedClient | undefined

// Get all currently connected clients
function getAllClients(): ConnectedClient[]

// Send a response to a specific client (reply to a req)
function sendResponse(client: ConnectedClient, response: GatewayResponse): void

// Push a named event to a specific client
function sendEvent(client: ConnectedClient, event: PushEventName, payload: Record<string, unknown>, seq?: number): void

// Push a named event to ALL connected + authed clients
function broadcastEvent(event: PushEventName, payload: Record<string, unknown>): void
```

### Behaviour rules

- `broadcastEvent` only sends to clients where `client.authed === true` — unauthenticated connections do not receive broadcast events
- `sendResponse` and `sendEvent` check `client.ws.readyState === WebSocket.OPEN` before sending — silently skip if the socket is not open
- All outgoing messages are serialised with `JSON.stringify` before sending
- No logging, no side effects other than sending messages and updating the Map

---

## Acceptance criteria

- [ ] Compiles with zero TypeScript errors
- [ ] All six functions exported
- [ ] `clients` Map is module-private (not exported)
- [ ] `broadcastEvent` skips unauthenticated clients
- [ ] `sendResponse` / `sendEvent` check socket readyState before sending

## Do not

- Do not use a class — use module-level functions and a module-level Map
- Do not throw on send errors — check readyState and skip silently
- Do not add any persistence, logging, or retry logic
- Do not import from any file other than `./types.js`
