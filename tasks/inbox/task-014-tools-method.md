# Task: tools.list Method Handler
**ID:** task-014
**Assigned to:** gemma
**Size:** small

## What to build

`gateway/src/methods/tools.ts` — a single handler: `tools.list`

Working directory: `/users/jb/mission-control/gateway`

## Pattern — follow sessions.ts exactly

```typescript
import type { MethodHandler } from '../types.js'
import { registerMethod } from '../router.js'

export function registerToolsMethods(/* params */): void {
  // prepare statements here if needed (none needed for this file)
  registerMethod('tools.list', handler)
}
```

## What tools.list does

It receives a `Map<string, RegisteredTool>` of the available tools. Returns the list of tool schemas to the caller.

```typescript
import type { RegisteredTool } from '../tools/types.js'
```

**params:** none (the tools map is passed to the factory)

**response:**
```json
{ "tools": [ { "name": "...", "description": "...", "parameters": { ... } } ] }
```

Just map over the tools map and return `tool.schema` for each entry.

## Full signature

```typescript
export function registerToolsMethods(tools: Map<string, RegisteredTool>): void
```

## Rules

- No `any` types
- Zero TypeScript errors
- Prepare statements once in outer scope (none needed here)
- Every handler must call `reply(result)` or `reply({ error: '...' })`
- Follow the MethodHandler signature from `../types.js`
- No comments unless non-obvious

## File to create

`gateway/src/methods/tools.ts`
