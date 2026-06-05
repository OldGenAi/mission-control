# Task: Gateway Entry Point
**ID:** task-008
**Assigned to:** gemma
**Size:** small
**Depends on:** task-005 (server.ts must exist — this just calls startServer)
**Phase:** 1 — Gateway Foundation

---

## What to build

The entry point for the gateway process. Imports `startServer` from `server.ts`, calls it, handles top-level errors. That's it — this file should be very short.

## File to create

`gateway/src/index.ts`

---

## Spec

```typescript
import { startServer } from './server.js'

startServer().catch((err) => {
  console.error('[gateway] Fatal startup error:', err)
  process.exit(1)
})
```

That is essentially the entire file. The only additions allowed:

1. A startup banner printed to stdout before `startServer()` is called:
```
[mission-control] gateway starting...
```

2. Process signal handlers for clean shutdown:
```typescript
process.on('SIGTERM', () => { /* call stopServer if it exists, then process.exit(0) */ })
process.on('SIGINT',  () => { /* same */ })
```

If `server.ts` does not export a `stopServer` function, the signal handlers just call `process.exit(0)` directly.

---

## Acceptance criteria

- [ ] Compiles with zero TypeScript errors
- [ ] Calls `startServer()` and handles rejection
- [ ] SIGTERM and SIGINT handlers present
- [ ] File is under 30 lines

## Do not

- Do not add any logic beyond what is described — this is a thin entry point only
- Do not import anything other than from `./server.js`
- Do not add configuration loading here — that belongs in server.ts
