# Task: Health Method Handler
**ID:** task-007
**Assigned to:** gemma
**Size:** small
**Depends on:** task-001 (types.ts), task-005 (server.ts must exist so startup time is available)
**Phase:** 1 — Gateway Foundation

---

## What to build

The handler for the `health` gateway method. Returns gateway status, uptime, and version. Simple, no side effects.

## File to create

`gateway/src/methods/health.ts`

---

## Spec

```typescript
import type { MethodHandler } from '../types.js'

// Registered as: registerMethod('health', healthHandler)
export const healthHandler: MethodHandler = async (params, client) => {
  return {
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),  // seconds since gateway started
    version: '0.1.0',
    timestamp: Date.now(),
  }
}
```

### startTime

The gateway start time must be recorded at module load time:

```typescript
const startTime = Date.now()
```

This means `startTime` is set when `health.ts` is first imported — which happens when the gateway starts. Uptime will be accurate from that point.

### Response shape

```typescript
{
  status: 'ok',
  uptime: number,   // integer seconds
  version: string,  // '0.1.0'
  timestamp: number // unix ms
}
```

---

## Acceptance criteria

- [ ] Compiles with zero TypeScript errors
- [ ] `healthHandler` exported as a named export
- [ ] `uptime` is a whole number (use `Math.floor`)
- [ ] Handler is a valid `MethodHandler` — takes `(params, client)` and returns `Promise<Record<string, unknown>>`

## Do not

- Do not import from anything other than `../types.js`
- Do not add any side effects
- Do not hardcode a timestamp — it must be computed at call time
