# Mission Control — Architecture Document

**Version:** 0.3 — updated 2026-05-28  
**Status:** Approved — ready to build

---

## 1. What We Are Building

Mission Control is a standalone **Agentic OS** — a personal orchestration hub that coordinates multiple AI agents to plan and build. It has its own gateway, its own agent runtime, its own pipeline engine, its own memory system, and its own UI. It has no dependency on OpenClaw or any other AI platform.

### The core workflow

1. You bring a task to Mission Control
2. Dave (your personal agent) understands it, decides whether to handle it himself or hand it to the Orchestrator
3. The Orchestrator decomposes the task into a deterministic pipeline and delegates steps to specialist workers
4. Workers execute (LM Studio / OpenRouter / Anthropic), return artifacts
5. Approval gates pause the pipeline for human sign-off on critical decisions
6. Dave oversees everything, verifies output, reports back to you

### What makes it different from OpenClaw

| OpenClaw | Mission Control |
|----------|----------------|
| One agent, one gateway | Three-tier agent hierarchy |
| Single provider (LM Studio via config) | Provider abstraction — swap per task |
| LLM drives everything | Deterministic pipelines for orchestration |
| No concept of artifacts | Artifacts are first-class typed handoffs |
| Compaction silently destroys context | No auto-compaction, ever |
| MEMORY.md silently truncates | Hard limits enforced at write time |
| Built for chat channels | Built for agentic orchestration |

---

## 2. System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Mission Control UI                        │
│          (React + Vite, existing aurora theme)               │
│   Chat │ Monitor │ Sessions │ Agents │ Pipelines │ Settings  │
└───────────────────────────┬─────────────────────────────────┘
                            │ WebSocket  ws://127.0.0.1:4747
┌───────────────────────────▼─────────────────────────────────┐
│                      Gateway (Node.js)                       │
│   Auth │ Method Router │ Event Broadcaster                   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                  Three-Tier Agent Layer              │    │
│  │                                                      │    │
│  │  Dave (Personal Agent)                               │    │
│  │    └─ full LLM loop, full tools, long-term memory    │    │
│  │                                                      │    │
│  │  Orchestrator                                        │    │
│  │    └─ pipeline runtime (deterministic)               │    │
│  │         ├─ Specialist A (worker agent)               │    │
│  │         ├─ Specialist B (worker agent)               │    │
│  │         └─ Approval Gate → human → resume            │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Provider Abstraction Layer               │   │
│  │     LM Studio │ OpenRouter │ Anthropic API            │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌────────┐  │
│  │   Tool   │  │   Session    │  │ Pipeline │  │ Memory │  │
│  │ Executor │  │    Store     │  │  Runtime │  │ System │  │
│  └──────────┘  └──────────────┘  └──────────┘  └────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Gateway

The gateway is the single process that everything connects to. It runs persistently on the Beelink. The UI connects to it over WebSocket. All agents run inside it.

### 3.1 Wire Protocol

Three message types — all JSON text frames over WebSocket:

```
Client → Gateway:   { "type": "req",   "id": "<uuid>", "method": "<name>", "params": {} }
Gateway → Client:   { "type": "res",   "id": "<uuid>", "ok": true, "payload": {} }
                    { "type": "res",   "id": "<uuid>", "ok": false, "error": { "code": "...", "message": "..." } }
Gateway → Client:   { "type": "event", "event": "<name>", "payload": {} }
```

- Every `req` gets exactly one `res` with a matching `id`
- Events are fire-and-forget, pushed to all subscribed clients
- Unknown methods return `{ ok: false, error: { code: "METHOD_NOT_FOUND" } }`

### 3.2 Connection Handshake

```
1. Client opens WebSocket to ws://127.0.0.1:4747
2. Gateway checks Origin header — rejects if not loopback (security, see §11)
3. Gateway sends:  { type: "event", event: "connect.challenge", payload: { nonce: "<uuid>" } }
4. Client sends:   { type: "req", id: "...", method: "connect", params: { token: "...", nonce: "..." } }
5. Gateway validates token + nonce
6. Gateway sends:  { type: "res", id: "...", ok: true, payload: { type: "hello-ok", features: { methods: [...], events: [...] } } }
```

If the token is wrong: `{ ok: false, error: { code: "AUTH_FAILED" } }` and the socket closes.

### 3.3 Auth

- A single shared token stored at `~/.missioncontrol/config.json`
- Generated automatically on first gateway start (random 32-byte hex)
- Never blank — gateway refuses to start without a token
- The UI reads it from the same config file (local machine — same trust boundary)
- Scope system: v1 has one scope level (operator). Scope subsetting enforced if we expand later.

### 3.4 Method List (v1)

| Method | Description |
|--------|-------------|
| `connect` | Handshake + auth |
| `health` | Gateway status, uptime |
| `agents.list` | List configured agents |
| `agents.get` | Get single agent config + status |
| `models.list` | List available models per provider |
| `sessions.list` | List sessions (filterable by agent) |
| `sessions.create` | Create a new session |
| `sessions.history` | Fetch message history for a session |
| `sessions.delete` | Delete a session |
| `chat.send` | Send a message — triggers Dave's agentic loop |
| `chat.abort` | Cancel an in-progress run |
| `tools.list` | List tools available to an agent |
| `config.get` | Read MC config |
| `config.set` | Write MC config value |
| `logs.tail` | Stream gateway logs |
| `monitor.subscribe` | Subscribe to live agent activity events |
| `pipelines.list` | List saved pipeline definitions |
| `pipelines.run` | Start a pipeline run |
| `pipelines.status` | Get current run status |
| `pipelines.approve` | Approve or reject a paused approval gate |
| `artifacts.list` | List artifacts for a session or pipeline run |
| `artifacts.get` | Fetch a specific artifact |
| `monitoring.query` | Query historical records — pipeline runs, tool calls, model calls, errors. Filterable by agent, time range, status, correlationId |

### 3.5 Push Events

| Event | When | Payload |
|-------|------|---------|
| `connect.challenge` | On WebSocket open | `{ nonce }` |
| `chat.delta` | Streaming token chunk | `{ sessionId, text }` |
| `chat.final` | Run complete | `{ sessionId, message }` |
| `agent.status` | Agent lifecycle change | `{ agentId, sessionId, status, detail }` |
| `session.tool` | Tool call start/result | `{ sessionId, tool, status, input?, output? }` |
| `sessions.changed` | Session list updated | `{}` |
| `pipeline.tick` | Pipeline step progress | `{ runId, stepId, status, output? }` |
| `pipeline.approval` | Pipeline paused at gate | `{ runId, stepId, prompt, approvalId }` |
| `monitor.tick` | Live activity update | `{ instances: [...] }` — see §9 |
| `presence` | Gateway health ping | `{ uptime, agents }` |
| `shutdown` | Gateway shutting down | `{}` |

### 3.6 Port

`127.0.0.1:4747` — loopback only, no `0.0.0.0` binding.

---

## 4. Provider Abstraction Layer

Every agent session has a `provider` and `model` field. The provider layer translates between a single internal interface and the different APIs.

### 4.1 Internal Interface

```typescript
interface ProviderAdapter {
  chat(params: {
    messages: Message[]
    tools: ToolSchema[]
    systemPrompt: string
    stream: (delta: string) => void
  }): Promise<AssistantMessage>
}
```

All adapters implement this. The agentic loop only ever calls `adapter.chat()` — it never touches a provider API directly.

### 4.2 Four Provider Types

**Local OpenAI-compatible** (`local`)
- Covers: LM Studio, Ollama, llama.cpp server — anything exposing an OpenAI-compatible API on localhost
- Base URL: configurable per provider instance in `~/.missioncontrol/config.json`
- Auth: none (local)
- API: OpenAI-compatible — uses the `openai` npm package
- Use when: fast local runs, privacy-sensitive tasks, primary execution tier
- **Security:** `baseUrl` is validated at gateway startup — loopback addresses only (`127.0.0.1`, `localhost`, `::1`). Any non-loopback address is rejected with a clear config error. SSRF via provider config is not possible.

```json
{ "provider": "local", "baseUrl": "http://127.0.0.1:1234/v1",  "model": "gemma-4-27b" }
{ "provider": "local", "baseUrl": "http://127.0.0.1:11434/v1", "model": "llama3" }
{ "provider": "local", "baseUrl": "http://127.0.0.1:8080/v1",  "model": "mistral" }
```

Multiple local providers can run simultaneously on different ports. Each agent routes to whichever instance is configured for it.

**OpenRouter** (`openrouter`)
- Base URL: `https://openrouter.ai/api/v1`
- Auth: API key in `~/.missioncontrol/config.json`
- API: OpenAI-compatible — same adapter code as local, different base URL + key
- Use when: large models, tasks that exceed local hardware

**Anthropic** (`anthropic`)
- Base URL: Anthropic SDK default
- Auth: API key in `~/.missioncontrol/config.json`
- API: `@anthropic-ai/sdk` — own adapter (different streaming format, different tool call format)
- Use when: frontier capability, planning, verification

Provider config is per-agent, overridable per-session. Switching provider never affects other agents or sessions.

---

## 5. Agentic Loop

The loop runs inside the gateway, server-side. The model proposes — the gateway executes. The UI is a window into what's happening, not a participant.

### 5.1 Loop Flow

```
receive chat.send request
  │
  ├─ load agent identity (SOUL.md + AGENTS.md + IDENTITY.md → system prompt)
  ├─ load session history from SQLite
  ├─ check context budget — warn if > 80%
  │
  └─ LOOP:
      call provider.chat(messages, permitted_tools, systemPrompt)
        │                                                    ↑
        │                             async, off critical path: log model call
        │                             (tokens in/out, latency, model, cost estimate)
        │                             → tool_call_log + model_call_log in SQLite
        │
        ├─ stream text deltas → push chat.delta events to UI
        │
        ├─ if tool_call in response:
        │    validate tool is in agent's permitted set
        │    validate tool is in agent's credential capability list (see §8.4)
        │    push session.tool event (status: running)
        │    execute tool server-side  ←── assign correlationId to this execution
        │    validate output schema (evidence-based guardrails — see §9.7)
        │    async: write tool_call_log row (redacted — see §14)
        │    push session.tool event (status: done, output)
        │    append tool result to messages
        │    loop back ↑
        │    if any error: write to error_log with full correlationId chain
        │
        └─ if no tool_calls:
             push chat.final event with complete message
             persist message to session store
             run end-of-turn memory hook (agent may write to memory)
             done

All monitoring writes (tool_call_log, model_call_log, error_log) are buffered in memory
and flushed to SQLite every second on a background timer. They never block the agent loop.
```

### 5.2 Context Budget

- Each provider/model has a configured max token limit
- Budget tracked per turn: `(system prompt tokens) + (history tokens) + (current turn tokens)`
- At 80%: push `agent.status { status: "context_warning" }` — agent sees this and can summarise
- At 95%: abort the run with a clear error — never silently overflow to the provider
- No automatic compaction. The agent handles it explicitly if needed.

---

## 6. Memory System

Designed to fix OpenClaw's core failures: silent compaction, unbounded growth, silent truncation.

### 6.1 Memory Tiers

**Tier 1 — Active (always in context, loaded at session start)**

| File | Cap | Purpose |
|------|-----|---------|
| `SOUL.md` | 800 tokens | Who the agent is — philosophy, values, personality, permanent facts |
| `AGENTS.md` | 500 tokens | How the agent works — procedures, red lines, what it will and won't do |
| `IDENTITY.md` | 200 tokens | How the agent presents — name, tone, brief |
| `YYYY-MM-DD.md` | 300 tokens | Today + yesterday auto-loaded. Expires after 7 days unless promoted |

Rules:
- All four loaded **once** at session start as a frozen snapshot
- Changes written to disk immediately, visible **next session** (preserves LLM prefix cache)
- Hard cap enforced at **write time** — agent gets an error with current usage%, must consolidate first
- Agent manages its own memory via tools (`memory_write`, `memory_replace`, `memory_remove`)
- No silent truncation. Ever.

**Tier 2 — Archive (on-demand, zero passive token cost)**

- SQLite database: all past sessions stored indefinitely
- FTS5 full-text search — ~20ms queries
- Agent calls `memory_search` when it needs historical context
- `memory_get` for direct reads of specific files

### 6.2 Three-Part Identity (replaces single CORE.md)

Each agent gets three identity files instead of one monolithic memory file:

| File | Purpose | Analogy |
|------|---------|---------|
| `SOUL.md` | Philosophy, values, who you are at a deep level | The unchanging core |
| `AGENTS.md` | Procedures, capabilities, red lines, tool permissions | The operations manual |
| `IDENTITY.md` | Name, tone, how you present to users | The persona layer |

This separation means SOUL.md changes rarely (personality is stable), AGENTS.md changes when capabilities change, and IDENTITY.md changes when you rebrand or adjust communication style — without touching everything each time.

### 6.3 Temporal Memory

Every memory entry has a time dimension. Facts can be superseded — the old fact is preserved, not deleted.

```sql
memory_entries (
  id          TEXT PRIMARY KEY,
  file        TEXT NOT NULL,      -- "SOUL" | "AGENTS" | "IDENTITY" | "YYYY-MM-DD"
  content     TEXT NOT NULL,
  valid_from  INTEGER NOT NULL,   -- unix timestamp: when this fact became true
  valid_until INTEGER,            -- NULL = still current; timestamp = superseded
  created_at  INTEGER NOT NULL
)
```

Rules:
- `memory_write` creates a new entry with `valid_from = now`, `valid_until = NULL`
- `memory_supersede` sets `valid_until = now` on the old entry and creates a new one atomically
- `memory_search` queries only current entries (`valid_until IS NULL`) by default
- Historical queries are possible: "what did I know about X on date Y"
- Nothing is ever deleted — the full history of what the agent knew is preserved

### 6.4 Memory Tools

| Tool | Action |
|------|--------|
| `memory_write` | Add a new entry (`valid_from = now`, `valid_until = NULL`). Fails if over cap. |
| `memory_replace` | Update existing entry by substring match (non-temporal, in-place edit) |
| `memory_remove` | Mark entry `valid_until = now` (soft delete — preserves history) |
| `memory_supersede` | Replace a specific entry with a new one atomically — sets valid_until on old, creates new |
| `memory_get` | Read SOUL.md / AGENTS.md / IDENTITY.md / daily note (current entries only) |
| `memory_search` | FTS5 search across session history (current entries by default, optional historical) |

### 6.5 No Compaction

There is no automatic compaction in Mission Control. If a session is running long:
- The context budget warning fires at 80%
- The agent can choose to summarise and write key points to SOUL.md
- The session continues — nothing is destroyed behind the agent's back

---

## 7. Tool System

Tools are typed Node.js functions. The model proposes a tool call. The gateway validates it's permitted, executes it, returns the result. The model never executes anything directly.

### 7.1 Tool List (v1)

| Tool | Default | Implementation | Notes |
|------|---------|---------------|-------|
| `file_read` | on | `fs.readFile` | Workspace boundary enforced |
| `file_write` | on | `fs.writeFile` | Workspace boundary enforced |
| `file_edit` | on | diff/patch | Workspace boundary enforced |
| `exec` | **off** | `child_process.spawn` | Must be explicitly enabled per session |
| `web_fetch` | on | native `fetch` | Private IP ranges blocked (SSRF) |
| `web_search` | on | Brave/Tavily API | API key required in config |
| `memory_write` | on | `fs.writeFile` | Cap enforced, see §6 |
| `memory_replace` | on | in-place edit | Cap enforced |
| `memory_remove` | on | in-place edit | — |
| `memory_get` | on | `fs.readFile` | — |
| `memory_search` | on | SQLite FTS5 | — |
| `artifact_write` | on | SQLite + JSON | Write typed artifact, returns artifact ID |
| `memory_supersede` | on | SQLite atomic update | Replace a memory entry, preserve history |
| `subagent_spawn` | orchestrator only | gateway internal | Spawn worker agent, see §8.3 |

### 7.2 Permission Filtering

Each agent has a configured tool set. Before every model call, only the schemas for permitted tools are sent. The model never sees tools it can't use — it can't attempt to call them.

`subagent_spawn` is only in the orchestrator's permitted set. Dave does not have it. Specialists do not have it.

### 7.3 Workspace Boundary

All file tools resolve paths relative to the agent's configured workspace folder. Any path that tries to escape with `../` or an absolute path outside the workspace returns an error. Override requires an explicit config flag (not a runtime parameter — a deliberate admin action).

### 7.4 exec Tool

Off by default. When enabled for a session:
- User must approve each command before it runs
- Command, working directory, and args are shown in the UI before execution
- Approval stored for the session — same exact command doesn't need re-approval

### 7.5 artifact_write Tool

```typescript
artifact_write({
  type: "plan" | "code" | "review" | "report" | "data",
  title: string,
  content: string,         // the artifact body
  schema?: object,         // optional JSON schema the content must validate against
  sessionId?: string,      // link to a session
  pipelineRunId?: string   // link to a pipeline run
}) → { artifactId: string }
```

Every artifact is stored in SQLite with a unique ID, type, content, and links back to its origin session or pipeline run. They form a complete audit trail of what every agent produced.

---

## 8. Multi-Agent Orchestration

### 8.1 Three-Tier Agent Hierarchy

```
Dave (Tier 1 — Personal Agent)
  │  Full LLM loop. Full tools. All memory. Your AI. Persistent, always running.
  │  Handles tasks himself or delegates to the Orchestrator.
  │
  └─ Orchestrator (Tier 2 — Pipeline Manager)
       │  Runs deterministic pipelines. Hub-and-spoke controller.
       │  Decomposes tasks, delegates to specialists, manages approval gates.
       │  Does NOT execute tasks — it coordinates them.
       │
       ├─ Specialist Agent (Tier 3 — Worker)
       │    Single-purpose. One task. Returns an artifact. Goes away.
       │    Examples: researcher, coder, reviewer, writer, emailer
       │
       └─ Specialist Agent (Tier 3 — Worker)
            ...
```

The Tier 1 personal agent is referenced in code and the database as `tier1_agent`. The display name ("Dave" or any other name) is a config value in `~/.missioncontrol/config.json` and is never hardcoded into the protocol, schema, or gateway logic. Other users of Mission Control give their personal agent whatever name they choose.

The Tier 1 agent is unchanged by this architecture. It keeps all its tools, all its memory, and continues operating as a full LLM loop. It is the only entry point you interact with directly.

### 8.2 Hub-and-Spoke Communication

Tier 3 workers communicate **only with the Orchestrator** — never with each other and never with Dave directly.

```
Dave → Orchestrator → Worker A
                    → Worker B
                    → Worker C
                    ← (artifacts back to Orchestrator)
                    → Dave (final output)
```

This rule is enforced architecturally: workers only have `artifact_write` and their task-specific tools. They have no `subagent_spawn`, no `chat.send`. They cannot initiate contact with anything.

### 8.3 subagent_spawn Tool

The Orchestrator's mechanism for spawning workers:

```typescript
subagent_spawn({
  role: string,                    // "researcher" | "coder" | "reviewer" | ...
  task: string,                    // what to do
  context: string,                 // mandatory — no implicit inheritance from parent
  inputArtifacts?: string[],       // artifact IDs from prior steps
  tools: string[],                 // composable per-spawn — only what this task needs
  await: boolean,                  // true = block until done, false = fire-and-forget
  maxIterations?: number,          // default 20
  provider?: string,               // override provider for this spawn
  model?: string                   // override model for this spawn
}) → { runId: string, artifact?: Artifact, status: string }
```

**Batch mode** — spawn multiple workers in parallel:
```typescript
subagent_spawn({
  batch: [
    { role: "researcher", task: "...", context: "...", tools: [...] },
    { role: "researcher", task: "...", context: "...", tools: [...] }
  ],
  await: true
}) → { results: [{ runId, artifact, status }, ...] }
```

### 8.4 Spec as Code + Agent Credentials Registry

> ⚠️ **The spec files are the binding contract for agent behaviour — tool lists, red lines, allowed tools, handoff contracts.** Before making any assumption about what an agent can do or how it is structured, read the spec file. They live at `gateway/src/agents/specs/`. There are four: `dave.md`, `orchestrator.md`, `worker-researcher.md`, `worker-coder.md`. These are NOT summarised in this document — read them directly.

Every agent type has a spec file that defines exactly what it is and what it does. The spec is the contract. The spec is written before any agent is built.

Six-section format:

```markdown
# Spec: [Agent Name]

## Role
One paragraph. What this agent does and why it exists.

## Inputs
JSON schema of what must be provided via context + inputArtifacts.

## Outputs
JSON schema of the artifact this agent must return.

## Operational Constraints
- Timeout: Xs
- Max iterations: N
- Cost ceiling: $X per run
- Retry policy: N retries on failure before escalation

## Red Lines
- What this agent must NEVER do (examples: no file_write, no exec, no external API)

## Handoff Contract
What the Orchestrator must provide and what it will receive back.
```

Specs live in `gateway/src/agents/specs/`. They are the source of truth for agent configuration. If a spec changes, the agent behaviour changes.

**Agent Credentials Registry**

At gateway startup, every spec file is parsed into a runtime identity record and loaded into an in-memory registry:

```typescript
interface AgentCredential {
  agentId: string
  role: string
  tier: 1 | 2 | 3
  capabilities: string[]   // tools this agent is permitted to use — from spec Red Lines + tool list
  redLines: string[]        // natural language constraints — logged but not machine-enforced
}
```

Rules:
- Registry is loaded **once at startup** from spec files — it is **read-only at runtime**
- No gateway API method can modify agent credentials — changes require editing the spec file and restarting the gateway
- At spawn time: the gateway checks `subagent_spawn.tools` against the target role's `capabilities`. Any tool not in the credential list is **stripped before the spawn proceeds** — not just filtered pre-inference, but blocked at the spawn boundary
- A spawn requesting a tool not in the credential list writes a security warning to `error_log` and continues with the stripped tool set
- `config.set` is explicitly prohibited from touching agent credentials

### 8.5 Escalation Pipeline (Model Arbitrage)

Route tasks by difficulty to manage cost and latency:

```
Cheap tier (Gemma local, ~80% of tasks)
  → if output fails evidence check or confidence too low:
Mid tier (OpenRouter mid-model, ~15% of tasks)
  → if still fails:
Frontier tier (Anthropic Claude, ~5% of tasks)
  → if still fails: escalate to human
```

Routing is controlled in the Orchestrator's pipeline definition. Each `llm` step declares a `tier` and the escalation behaviour is automatic. Most tasks never leave the cheap tier.

---

## 9. Pipeline Runtime

The Orchestrator does not reason its way through tasks in a free-form LLM loop. It executes **deterministic pipelines** — workflows defined as data, running deterministically. The LLM fires the starting pistol (Dave delegates to the Orchestrator). After that, the runtime drives.

This is our own implementation, informed by OpenClaw's Lobster but built from scratch and tailored to our use case. ~1000-1500 LOC, in-process, no external dependencies beyond better-sqlite3 (already in the stack).

### 9.1 Why Deterministic Pipelines

| LLM-driven loop | Deterministic pipeline |
|-----------------|----------------------|
| Can hallucinate the next step | Next step is defined in the spec |
| Hard to audit | Full execution trace in SQLite |
| Can't resume after failure | Resume tokens — pick up from exact step |
| Token-expensive for coordination | Zero tokens for routing decisions |
| Struggles on local models | Works identically on any model |
| No approval gates | Native gate support |

### 9.2 Pipeline Definition Format

YAML files (`.yaml`). JSON also accepted. Stored in `gateway/src/pipelines/`.

```yaml
name: build_feature
version: 1
description: "Research, implement, and review a feature"
args:
  task:
    type: string
    required: true

budget:
  max_tokens: 80000           # total tokens across all steps in this run
  max_cost_usd: 0.75          # hard ceiling — pipeline aborts if exceeded
  timeout_seconds: 600        # wall-clock limit for the entire run
  on_exceed: notify_human     # abort | notify_human | fallback_to_tier_1

steps:
  - id: plan
    type: llm
    agent: orchestrator
    prompt: |
      Break this task into implementation steps: {{ args.task }}
    outputSchema:
      type: object
      required: [steps, rationale]
      properties:
        steps: { type: array, items: { type: string } }
        rationale: { type: string }
        evidence: { type: string }   # required by evidence guardrail

  - id: implement
    type: spawn_agent
    role: coder
    inputArtifacts: [plan]
    await: true
    tools: [file_read, file_write, file_edit, memory_get]

  - id: review_gate
    type: approval_gate
    prompt: "Review implementation for {{ args.task }}?"
    items: "{{ implement.artifact }}"

  - id: review
    type: spawn_agent
    role: reviewer
    when: "$review_gate.approved"
    inputArtifacts: [implement]
    await: true
    tools: [file_read, memory_get]
```

### 9.3 Step Types

| Type | What it does |
|------|-------------|
| `llm` | Calls a model with a prompt, validates response against `outputSchema`, writes result as artifact |
| `spawn_agent` | Calls `subagent_spawn`, waits for artifact if `await: true` |
| `approval_gate` | Pauses execution, returns approval request to UI, waits for human decision |
| `condition` | Evaluates `when:` expression, branches or skips next steps |
| `parallel` | Runs a group of steps concurrently, waits for all to complete |

### 9.4 Approval Gates + Resume Tokens

When a pipeline hits an `approval_gate` step:

1. Pipeline status changes to `waiting`
2. Gateway pushes `pipeline.approval` event to all connected UIs
3. UI shows the approval card with prompt and context
4. An `approvalId` and a signed `resumeToken` are returned to the UI
5. Human approves or rejects via `pipelines.approve` method
6. Pipeline resumes from the exact step that was waiting
7. If rejected: pipeline records the decision and follows `onReject` branch or terminates

The `resumeToken` is an HMAC-signed opaque string: `runId:stepId:timestamp:sig`. It cannot be forged or replayed after expiry.

### 9.5 Durable Task State (SQLite)

Every pipeline run has a row in the database. State survives gateway restarts.

```sql
CREATE TABLE pipeline_runs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL,          -- pending|running|waiting|completed|failed|budget_exceeded
  revision        INTEGER NOT NULL DEFAULT 0,
  step_id         TEXT,
  state_json      TEXT,
  approval_id     TEXT,
  resume_token    TEXT,
  error           TEXT,
  -- budget tracking
  budget_max_tokens    INTEGER,
  budget_max_cost_usd  REAL,
  budget_timeout_secs  INTEGER,
  budget_on_exceed     TEXT,
  tokens_used          INTEGER NOT NULL DEFAULT 0,
  cost_usd_used        REAL NOT NULL DEFAULT 0.0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

The runner checks `tokens_used` and `cost_usd_used` after every step. If either exceeds the budget ceiling, the run status is set to `budget_exceeded` and the `on_exceed` policy is executed before any further steps run.

Optimistic locking via `revision`: any update must supply the current revision. Prevents concurrent resume conflicts if two clients try to approve the same gate.

### 9.6 Self-Healing Watchdog

Runs every 2 minutes. Queries for stuck records:

```sql
SELECT * FROM pipeline_runs
WHERE status = 'running'
AND updated_at < (unixepoch() - 120)
```

For each stuck run: reset to `pending`, increment retry count, log the recovery.

Only escalates to human (pushes a notification event) when:
- `retry_count > max_retries` (default 3)
- `budget_max_cost_usd` or `budget_max_tokens` breached (unless `on_exceed = abort`)
- `budget_timeout_secs` exceeded
- A new failure spike appears (more than 3 failures in 10 minutes across all runs)

Everything else it fixes silently. The whole point is to not page you for things a machine can handle.

### 9.7 Evidence-Based Guardrails

Every `llm` step's `outputSchema` must include an `evidence` field. The schema validator checks this after every model call. If the output doesn't include evidence, the response is rejected and the step escalates to the next tier (see §8.5).

This eliminates hallucination architecturally — not by hoping the model behaves, but by refusing to accept output that doesn't justify itself.

```yaml
outputSchema:
  type: object
  required: [answer, evidence]
  properties:
    answer: { type: string }
    evidence:
      type: string
      minLength: 20    # must say something meaningful
```

---

## 10. Artifacts

Artifacts are the currency of the pipeline. Every step that produces output produces an artifact. Artifacts are typed, stored, versioned, and linked to their origin.

### 10.1 Artifact Schema

```typescript
interface Artifact {
  id: string
  type: "plan" | "code" | "review" | "report" | "data"
  title: string
  content: string
  agentId: string
  sessionId?: string
  pipelineRunId?: string
  stepId?: string
  createdAt: number
  metadata?: Record<string, unknown>
}
```

### 10.2 Rules

- Every `spawn_agent` step returns an artifact or the step is marked failed
- Artifacts can be passed as `inputArtifacts` to downstream steps — the pipeline explicitly threads them
- Artifacts are never deleted — they are the audit trail
- Artifact content is stored in SQLite, not on the filesystem, so it survives workspace resets

### 10.3 Gateway Methods

- `artifacts.list` — list artifacts for a session or pipeline run, filterable by type
- `artifacts.get` — fetch a specific artifact by ID

---

## 11. Monitoring — Live and Historical

Everything that happens in Mission Control is recorded. Two views: live (what's happening right now) and historical (what happened, when, and why it failed).

### 11.1 Live Monitor Tab — Per-Instance Card

| Field | Description |
|-------|-------------|
| Agent name | Plus provider + model badge |
| Status pill | `idle` / `thinking` / `tool: file_read` / `streaming` / `error` |
| Current task | What it was asked to do (first 80 chars of the message) |
| Active tool | Tool name + elapsed time while running |
| Context bar | Token usage / total, amber at 80%, red at 95% |
| Memory bar | SOUL.md usage % |
| Elapsed | Time since current run started |
| Cost so far | Estimated cost of current run in USD |
| Pipeline | If running inside a pipeline: step name + run status |

### 11.2 Live Monitor — How It Works

- Powered by `monitor.tick` push events from the gateway
- Gateway aggregates `agent.status` + `session.tool` + `pipeline.tick` events into a tick payload every 1 second
- UI subscribes on tab open, unsubscribes on tab close
- No polling — pure push

### 11.3 Historical Monitoring

Everything is stored. Every model call, tool call, pipeline step, and error has a row in SQLite. The UI (Phase 8) exposes this via the `monitoring.query` gateway method.

Queryable history includes:
- All pipeline runs with status, duration, tokens used, cost
- All tool calls with agent, tool name, duration, success/fail, correlationId
- All model calls with model, tokens in/out, latency, cost estimate
- All errors with full correlation chain (UI event → gateway log → SQLite row → input that caused it)
- Error rate over time, slowest steps, most expensive runs

**Error correlation:** Every operation is assigned a `correlationId` at the gateway entry point. This ID flows through: the WebSocket response, the gateway log line, the tool_call_log row, and the error_log row. When something fails, one correlationId surfaces the complete picture.

### 11.4 New Gateway Method

| Method | Description |
|--------|-------------|
| `monitoring.query` | Query historical records — pipeline runs, tool calls, model calls, errors. Filterable by agent, time range, status, correlationId |

---

## 12. Session Storage

All data in one database: `~/.missioncontrol/db.sqlite`. **WAL mode enabled from first startup** — required for concurrent agent writes without contention.

| Table | Purpose |
|-------|---------|
| `sessions` | Session index — id, agentId, label, provider, model, timestamps, tokenCount |
| `messages` | Message history — id, sessionId, role, content (JSON), timestamp, usage |
| `messages_fts` | FTS5 virtual table over messages — powers `memory_search` |
| `pipeline_runs` | Pipeline execution state — see §9.5 |
| `artifacts` | Typed agent outputs — see §10.1 |
| `memory_entries` | Temporal memory entries — see §6.3 |
| `tool_call_log` | Every tool execution — id, correlationId, agentId, sessionId, pipelineRunId, tool, input_hash, output_hash, duration_ms, success, error, timestamp |
| `model_call_log` | Every model call — id, correlationId, agentId, provider, model, tokens_in, tokens_out, latency_ms, cost_usd, timestamp |
| `error_log` | Every error with full chain — id, correlationId, timestamp, agentId, sessionId, pipelineRunId, stepId, tool, error_message, stack_trace, input_summary |

**WAL mode**: `PRAGMA journal_mode=WAL` set in `db.ts` immediately after database open. No exceptions.

**Monitoring writes**: `tool_call_log`, `model_call_log`, and `error_log` writes are buffered in memory and flushed in batches every second on a background timer. They never block the agent loop or pipeline runner.

**Note on `tool_call_log`**: `input_hash` and `output_hash` are SHA-256 hashes of the raw payload — the actual content is not stored. Full payloads are retrievable only for the current session in memory, never persisted to disk. This prevents sensitive file contents, API responses, and credentials from accumulating in the monitoring database.

---

## 13. Security Model

| Threat | How We Handle It |
|--------|-----------------|
| Cross-site WebSocket hijacking (ClawBleed CVE-2026-25253) | Strict Origin header check on every WebSocket upgrade. Non-loopback origins rejected immediately. |
| Privilege escalation (CVE-2026-32922 class) | Scope subsetting enforced at token issuance. Token can never have more scopes than its issuer. |
| Prompt injection → tool abuse | Tool permission filtering pre-inference. `exec` off by default. Workspace boundary on file tools. `subagent_spawn` restricted to orchestrator only. |
| Agent capability violation | Agent credentials registry checked at every spawn. Tools not in the agent's declared capability list are stripped before the spawn proceeds. Violation logged to `error_log`. |
| Credentials registry tampering | Registry loaded read-only from spec files at startup. No API method can modify it at runtime. Changes require spec file edit + gateway restart. |
| Path traversal | Workspace boundary enforced in all file tool implementations. Absolute paths and `../` return an error. |
| SSRF via web_fetch | Private/loopback IP ranges blocked by default. Configurable allowlist for exceptions. |
| SSRF via provider baseUrl | Local provider `baseUrl` validated at startup — loopback only. Any non-loopback address is rejected with a config error before the gateway starts. |
| No auth on startup | Token generated on first start, stored in config, gateway refuses to start without one. |
| Context overflow | Budget tracked per turn, enforced at 95%. Never silent. |
| Pipeline cost overflow | `budget:` stanza enforced per run. Status set to `budget_exceeded` before any further steps. |
| Forged resume tokens | HMAC-signed, include timestamp, rejected after expiry. |
| Concurrent approval race | Optimistic locking via `revision` integer on pipeline_runs table. |
| API keys in source | Keys stored in `~/.missioncontrol/config.json`, never in code, never in the UI bundle. |
| Sensitive data in monitoring logs | Tool call inputs and outputs stored as SHA-256 hashes only — raw payloads never written to disk. Error log stores input_summary (truncated, redacted), not full input. |
| Sensitive data leaking via errors | All error messages pass through a redaction filter before reaching `error_log` or the UI. Known patterns (API keys, tokens, file paths outside workspace) are scrubbed. |

---

## 14. Observability and Data Integrity

### 14.1 WAL Mode

SQLite Write-Ahead Logging is enabled in `db.ts` immediately after database open:

```typescript
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
```

This is not optional. Without WAL, concurrent agent writes cause contention and locking delays. It must be the first thing set after opening the database.

### 14.2 Async Monitoring Writes

All writes to `tool_call_log`, `model_call_log`, and `error_log` go through a buffer:

- Events are pushed to an in-memory queue (never dropped)
- A background timer flushes the queue to SQLite in a single batch transaction every 1 second
- If a flush fails, it is retried on the next tick — the queue holds until it succeeds
- The agent loop and pipeline runner never `await` a monitoring write

The only exception: `error_log` writes for fatal errors (gateway crash, unhandled exception) are written synchronously before process exit.

### 14.3 Redaction Rules

Before any data is written to `error_log` or passed to the UI in an error event, it passes through a redaction filter. The filter scrubs:

- Bearer tokens and API keys (regex patterns for common formats)
- File paths outside the workspace boundary
- Contents matching `password`, `secret`, `token`, `key` field names in JSON
- Stack trace lines referencing `~/.missioncontrol/config.json`

Redaction is applied to `error_message`, `stack_trace`, and `input_summary` fields. The raw unredacted data is never written anywhere.

### 14.4 Correlation IDs

Every operation that enters the gateway is assigned a `correlationId` (UUID v4) at the point of entry:

- For WebSocket requests: assigned when the `req` message is received
- For pipeline steps: assigned when the step begins execution
- For background operations (watchdog, flush timer): assigned per invocation

The `correlationId` flows through:
1. The gateway log line for the operation
2. Any tool calls made during the operation (`tool_call_log.correlationId`)
3. Any model calls made (`model_call_log.correlationId`)
4. Any errors raised (`error_log.correlationId`)
5. The `res` message back to the UI (for request-originated operations)

In the UI: an error card shows its `correlationId`. One click shows every log entry, tool call, and model call that shares that ID. Silent failures become impossible — every fault has a traceable origin.

### 14.5 Data Retention

- `messages`, `sessions`, `artifacts`, `memory_entries`: retained indefinitely — these are the permanent record
- `pipeline_runs`: retained indefinitely — audit trail
- `tool_call_log`, `model_call_log`: retained for 90 days by default (configurable). Older rows pruned by the watchdog on its 2-minute cycle
- `error_log`: retained for 180 days by default (configurable)

## 15. Deployment

### Development / Daily Use (Beelink)
```
cd mission-control/gateway && npm run dev    # gateway on :4747
cd mission-control/app && npm run dev        # UI on :5173
```

### Production (Beelink)
- Gateway runs as a systemd-user service
- UI built to static files, served by the gateway's Express HTTP server
- Single process, single port

### Mac Staging
- `Dockerfile` in `gateway/` builds a container image
- `docker-compose.yml` at project root wires gateway + volume mounts
- Same build, different deployment — test a new version on Mac before pushing to Beelink
- Agent data (memory, sessions, artifacts) mounted as volumes — survives container restarts

---

## 16. Directory Structure

```
mission-control/
├── app/                            ← React UI (existing, kept)
│   └── src/
│       ├── lib/
│       │   ├── gateway-client.ts   ← replace: point to our gateway
│       │   └── mc-config.ts        ← keep
│       └── pages/
│           ├── ChatPage.tsx         ← keep, update for new protocol
│           ├── MonitorPage.tsx      ← new
│           └── ...
│
├── gateway/                        ← Node.js backend (new)
│   └── src/
│       ├── index.ts                ← entry point
│       ├── server.ts               ← WebSocket + HTTP server, wires auth + router
│       ├── auth.ts                 ← token validation, Origin check
│       ├── router.ts               ← method dispatcher
│       ├── broadcast.ts            ← push event broadcasting
│       ├── loop.ts                 ← agentic loop (Dave's loop)
│       ├── monitor.ts              ← aggregates events into monitor.tick
│       ├── methods/                ← one file per method group
│       │   ├── connect.ts
│       │   ├── sessions.ts
│       │   ├── chat.ts
│       │   ├── agents.ts
│       │   ├── pipelines.ts
│       │   ├── artifacts.ts
│       │   └── monitor.ts
│       ├── providers/              ← provider adapters
│       │   ├── types.ts
│       │   ├── lmstudio.ts
│       │   ├── openrouter.ts
│       │   └── anthropic.ts
│       ├── tools/                  ← tool implementations
│       │   ├── types.ts
│       │   ├── file.ts
│       │   ├── exec.ts
│       │   ├── web.ts
│       │   ├── memory.ts
│       │   ├── artifact.ts
│       │   └── spawn.ts            ← subagent_spawn
│       ├── pipeline/               ← pipeline runtime
│       │   ├── types.ts            ← PipelineRun, Step, Artifact types
│       │   ├── runner.ts           ← step executor
│       │   ├── loader.ts           ← YAML/JSON pipeline file loader
│       │   ├── approval.ts         ← approval gate + resume token
│       │   └── watchdog.ts         ← self-healing watchdog
│       ├── agents/                 ← agent configs + specs
│       │   └── specs/              ← 6-section spec files per agent type
│       ├── memory/
│       │   ├── loader.ts           ← loads SOUL.md + AGENTS.md + IDENTITY.md + daily note
│       │   └── store.ts            ← cap enforcement, write/replace/remove, FTS5
│       └── store/
│           └── db.ts               ← SQLite setup, migrations, all tables
│
├── docs/
│   ├── ARCHITECTURE.md             ← this file
│   └── BUILD_PLAN.md
│
└── CLAUDE.md
```

---

## 17. Build Sequence

Phases are listed in `docs/BUILD_PLAN.md`. This is the logical dependency order:

1. Gateway skeleton (auth, health, WebSocket)
2. LM Studio adapter + basic loop (Dave chatting, no tools)
3. Session storage (messages persist)
4. File tools + workspace boundary
5. Memory system (SOUL.md / AGENTS.md / IDENTITY.md loaded into system prompt)
6. UI gateway client (chat works end-to-end)
7. **Artifact system** (artifact_write tool, SQLite table, gateway methods)
8. **Pipeline runtime** (YAML loader, step executor, approval gates, SQLite state, watchdog)
9. **subagent_spawn** (orchestrator gets it, spawn → worker → artifact → return)
10. OpenRouter + Anthropic adapters
11. Escalation pipeline (tier routing in llm steps)
12. Monitor tab
13. exec tool + web tools
14. Docker build

---

*This document is the source of truth for the build. Any change to the architecture goes here first, then into code.*

---

## Decisions Log

- **2026-05-18** — Code lives at `C:\Users\oldge\Projects\mission-control\`
- **2026-05-18** — Stack locked: Vite + React + TypeScript + Tailwind
- **2026-05-26** — **ARCHITECTURAL PIVOT**: standalone agentic OS, no OpenClaw dependency
- **2026-05-26** — Provider abstraction: multi-provider, swappable per agent
- **2026-05-26** — Multi-agent first-class: personal agent as overseer, workers as delegates
- **2026-05-26** — Memory system: bounded frozen files + SQLite history, no compaction
- **2026-05-26** — Security: Origin validation, scope subsetting, workspace boundary, exec off by default
- **2026-05-26** — Deployment: native on Beelink, Docker for Mac staging
- **2026-05-26** — Live monitoring tab: per-instance visual status panel
- **2026-05-26** — Tools: built from scratch, Node.js native, filtered pre-inference
- **2026-05-28** — Three-tier hierarchy: personal agent → Orchestrator → Specialists
- **2026-05-28** — Hub-and-spoke topology: workers only talk to Orchestrator
- **2026-05-28** — Artifacts as first-class concept: typed, stored in SQLite, explicit threading
- **2026-05-28** — Approval gates with HMAC resume tokens, optimistic locking on pipeline_runs
- **2026-05-28** — Deterministic pipeline runtime (YAML, ~1000-1500 LOC, in-process)
- **2026-05-28** — Evidence-based guardrails: evidence field required in all llm step outputs
- **2026-05-28** — Escalation pipeline: cheap → mid → frontier routing by output quality
- **2026-05-28** — subagent_spawn tool: composable toolsets, mandatory context, batch mode
- **2026-05-28** — Spec as Code: 6-section spec file per agent type
- **2026-05-28** — Three-part identity: SOUL.md + AGENTS.md + IDENTITY.md
- **2026-05-28** — v0.3: Local provider covers LM Studio, Ollama, llama.cpp — configurable baseUrl, loopback-only
- **2026-05-28** — v0.3: Temporal memory — valid_from/valid_until, memory_supersede, full history preserved
- **2026-05-28** — v0.3: Personal agent display name is config, not hardcoded (`tier1_agent` in code)
- **2026-05-28** — v0.3: Budget stanza in pipeline YAML — max_tokens, max_cost_usd, timeout, on_exceed
- **2026-05-28** — v0.3: Error correlation chain — correlationId through gateway → logs → SQLite → UI
- **2026-05-28** — v0.3: Monitor everything — tool_call_log, model_call_log, error_log, historical via monitoring.query
- **2026-05-28** — v0.3: WAL mode mandatory, monitoring writes async (buffered, off critical path)
- **2026-05-28** — v0.3: Redaction filter on all error writes; tool payloads stored as hashes only
- **2026-05-28** — v0.3: Agent credentials registry — read-only at runtime, enforced at every spawn boundary
- **2026-05-28** — v0.3: Provider baseUrl SSRF protection — loopback-only at gateway startup
- **2026-05-28** — v0.3: A2A protocol explicitly excluded — no external agent communication in v1
- **2026-05-28** — v0.3: MCP opt-in extension only — native Node.js tools are default, no MCP token overhead on built-ins
