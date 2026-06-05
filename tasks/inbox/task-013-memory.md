# Task: Memory Tools
**ID:** task-013
**Assigned to:** openrouter
**Size:** large
**Depends on:** tools/types.ts (done)

## What to build

`gateway/src/tools/memory.ts` — six memory tools that read and write to the `memory_entries` SQLite table.

Export a single factory function:

```typescript
export function makeMemoryTools(db: Database.Database): RegisteredTool[]
```

Returns all six tools as an array.

## File to create

`gateway/src/tools/memory.ts`

Working directory for OpenCode: `/users/jb/mission-control/gateway`

## Imports

```typescript
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { RegisteredTool, ToolContext, ToolResult } from './types.js'
```

## The memory_entries table schema

```sql
id          TEXT    PRIMARY KEY,
agent_id    TEXT    NOT NULL,
key         TEXT    NOT NULL,
content     TEXT    NOT NULL,
valid_from  INTEGER NOT NULL,
valid_until INTEGER   -- NULL = current fact; timestamp = superseded
```

## The six tools

**memory_write** — params: `{ key: string, content: string }`. Inserts a new entry with `valid_from = Date.now()`, `valid_until = NULL`. Returns `{ id }`.

**memory_get** — params: `{ key: string }`. Returns the current entry for that key (`valid_until IS NULL`) for the calling agent. Returns `{ entry: { id, key, content, validFrom } }` or `{ entry: null }` if not found.

**memory_search** — params: `{ query: string, limit?: number }`. Searches current entries (`valid_until IS NULL`) for the calling agent where content LIKE `%query%`. Limit defaults to 10, max 20. Returns `{ results: [{ id, key, content, validFrom }] }`.

**memory_replace** — params: `{ key: string, content: string }`. Finds the current entry for that key, sets its `valid_until = now`, inserts a new entry. Single SQLite transaction. Returns `{ id }` of new entry, or error if no current entry exists.

**memory_remove** — params: `{ key: string }`. Sets `valid_until = now` on the current entry. Does NOT delete the row — facts are never deleted. Returns `{ ok: true }` or error if not found.

**memory_supersede** — params: `{ key: string, content: string }`. Identical to memory_replace — same implementation, different name used by the pipeline runtime. Single transaction, marks old valid_until, inserts new. Returns `{ id }`.

## Rules

- `agentId` always comes from `context.agentId` — never from args
- All reads filter by `agent_id = context.agentId`
- All writes set `agent_id = context.agentId`
- Prepare all statements once in `makeMemoryTools` scope — not inside the execute functions
- Every ToolResult must include `correlationId: context.correlationId`, `toolName`, `status`, `output` (JSON string), `durationMs`
- No `any` types
- Zero TypeScript errors
