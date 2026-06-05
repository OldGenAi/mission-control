# Task: Method Router
**ID:** task-004
**Assigned to:** gemma
**Size:** small
**Depends on:** task-001 (types.ts must exist first)
**Phase:** 1 — Gateway Foundation

---

## What to build

The method dispatcher. When the gateway receives a `req` message, the router looks up the method name and calls the right handler. Think of it as a simple map from method name to function.

## File to create

`gateway/src/router.ts`

---

## Spec

```typescript
import type { MethodHandler } from './types.js'

// Register a handler for a method name
// Called once at startup for each supported method
function registerMethod(method: string, handler: MethodHandler): void

// Dispatch a request to its registered handler
// Returns the handler's result payload, or throws if method not found
// Throws an object with { code: 'METHOD_NOT_FOUND', message: string } if not registered
async function dispatch(
  method: string,
  params: Record<string, unknown>,
  client: import('./types.js').ConnectedClient
): Promise<Record<string, unknown>>

// Return a list of all registered method names (used by the health and connect handlers)
function listMethods(): string[]
```

### Behaviour rules

- `dispatch` must reject unknown methods by throwing `{ code: 'METHOD_NOT_FOUND', message: 'Unknown method: <name>' }`
- If a registered handler throws, `dispatch` must re-throw — do not swallow errors
- `registerMethod` called twice with the same method name replaces the previous handler (last write wins)
- The internal registry is a `Map<string, MethodHandler>`

---

## Acceptance criteria

- [ ] Compiles with zero TypeScript errors
- [ ] `registerMethod`, `dispatch`, `listMethods` all exported
- [ ] Registry is module-private
- [ ] Unknown method throws the correct error shape
- [ ] Handler errors propagate (not swallowed)

## Do not

- Do not add middleware, auth checks, or logging — the server.ts handles all of that
- Do not import from any file other than `./types.js`
- Do not use a class
- Do not pre-register any methods in this file — that happens in server.ts
