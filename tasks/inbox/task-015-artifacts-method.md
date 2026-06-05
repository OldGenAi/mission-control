# Task: artifacts Method Handlers
**ID:** task-015
**Assigned to:** gemma
**Size:** small

## What to build

`gateway/src/methods/artifacts.ts` — two handlers: `artifacts.list` and `artifacts.get`

Working directory: `/users/jb/mission-control/gateway`

## Pattern — follow sessions.ts exactly

```typescript
import type Database from 'better-sqlite3'
import type { MethodHandler } from '../types.js'
import { registerMethod } from '../router.js'

export function registerArtifactsMethods(db: Database.Database): void {
  // prepare statements here
  registerMethod('artifacts.list', listHandler)
  registerMethod('artifacts.get', getHandler)
}
```

## Database schema

```sql
artifacts (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,  -- plan|code|review|report|data
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  session_id    TEXT,
  pipeline_run_id TEXT,
  step_id       TEXT,
  created_at    INTEGER NOT NULL
)
```

## artifacts.list

**params:** `{ agentId?: string, sessionId?: string, type?: string, limit?: number }`

Builds a SELECT with optional WHERE clauses. Limit defaults to 50, max 100. Returns newest first (`ORDER BY created_at DESC`).

**response:** `{ artifacts: [{ id, type, title, agentId, sessionId, createdAt }] }` — content is NOT included in list results (too large).

## artifacts.get

**params:** `{ id: string }` — required

Returns the full artifact including content.

**response:** `{ artifact: { id, type, title, content, agentId, sessionId, pipelineRunId, stepId, createdAt } }` or `{ error: 'not found' }` with the handler returning the error object (caller sees ok:false).

## Row interface

```typescript
interface ArtifactRow {
  id: string
  type: string
  title: string
  content: string
  agent_id: string
  session_id: string | null
  pipeline_run_id: string | null
  step_id: string | null
  created_at: number
}
```

## Rules

- No `any` types
- Zero TypeScript errors
- Prepare all statements once in outer scope
- Follow the MethodHandler signature: `(params, client) => Promise<Record<string, unknown>>`
- For artifacts.list: build the query dynamically based on which params are present (use an array of conditions + values)
- For artifacts.get: if not found, return `{ error: 'not found' }` (the router wraps this in ok:false automatically when the handler throws, but simpler to just return the error object — check sessions.ts for the pattern used there)
- No comments unless non-obvious

## File to create

`gateway/src/methods/artifacts.ts`
