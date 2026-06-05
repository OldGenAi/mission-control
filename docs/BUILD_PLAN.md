# Mission Control — Structured Build Plan

**Version:** 0.3 — updated 2026-06-02 (evening, model-routing fix + spec rewrites + loader.ts extension)  
**Status (2026-06-04 PM):** ✅ **MULTI-WORKER FAN-OUT shipped + proven on local AND paid cloud.** `subagent_spawn` `batch:` (`tools/spawn.ts`, ARCHITECTURE §8.3) runs N workers in parallel; `orchestrator.md` = one spawn (single/batch) + one summary + STOP. Token-explosion fixed (cumulative-output guard in worker-loop, file_read capped 24k, researcher ≤3 fetches, daily_digest 250k). Models dropdown shows paid. Monitor polish (live STATUS/latency, 6-box grid, active PIPELINES). Tested clean: Gemma UI+Dave, Qwen-paid UI+Dave (budget enforcement live-fire confirmed via a real overrun abort; true cloud concurrency proven). Active = `Dave/openrouter/qwen3-235b-a22b-2507` instruct. Deferred final-polish: CONTEXT ring %, OpenRouter cost in UI, Qwen first-artifact_write self-corrected validation miss. NEXT: §9.6 self-healing + §8.5 tier-escalation deferred → audit/git/README/release. ─── Prior (2026-06-03 LATE): consecutive-failure containment extended to the pipeline tier — new `gateway/src/failure-tracker.ts` (`ConsecutiveFailureTracker`, limit 3, success resets); `loop.ts` refactored onto it; `worker-loop.ts` now stops a worker/orchestrator at 3 consecutive tool failures (closes the unbounded orchestrator-respawn runaway). Proven deterministically (strike + reset tests), tsc clean, deployed, full code-inspection pass. NO retry / NO auto-respawn / NO fan-out yet / §9.6+§8.5 still deferred — this is the safety guard for fan-out. NEXT = `batch:` fan-out in `tools/spawn.ts` (ARCHITECTURE §8.3) + orchestrator.md, then the real concurrency break test. ─── Earlier 2026-06-03: SIX fixes shipped + PROVEN on local Gemma — chat-loop containment (3-strike + iteration cap 40→10 wired + per-turn deadline 600s), mid-stream Stop button (real `AbortController`, §3.7+§3.16), `file_list` discovery tool (§3.20, Dave 17 tools / Coder 6), reliable stop via `active-runs.ts` (delete aborts run §3.25 + bubble/Stop survive tab-switch via real `agent.status` §3.24 + `persistMessages` FK-tolerant §3.21). OpenRouter cause later SETTLED (see VERIFIED_STATE EVENING). Prior status preserved below.

**Status:** MODEL ROUTING + SPEC + LOADER ARCHITECTURE FIXED (2026-06-02 evening). **Catastrophic closure-capture bug found and fixed**: `tools/pipeline.ts:137` and `tools/spawn.ts:35` captured `provider`+`model` at gateway-boot time. Every UI model swap only affected Dave (chat.send route); orchestrator+workers stayed on whatever was active at gateway boot regardless of UI. **Fixed via `ToolContext` propagation + `resolveActive` resolver pattern** across 6 files: (1) `tools/types.ts` adds `provider?: ProviderAdapter` + `model?: string` to ToolContext; (2) `worker-loop.ts` injects caller's `config.provider`+`config.model` into ToolContext when invoking tools; (3) `loop.ts` does same for Dave's loop; (4) `tools/spawn.ts` reads `ctx.provider ?? closure provider`, `ctx.model ?? closure model` so sub-agents inherit caller's lineage; (5) `tools/pipeline.ts` accepts `resolveActive: () => { provider, model }` resolver and calls at execute() time; (6) `index.ts` wires resolver closure reading `settingsStore.get()` + `providerRegistry.get(...)`. **Verified end-to-end twice** — `model_call_log` shows Dave + orchestrator + worker all on same active model. **Orchestrator self-contradiction fixed**: spec said "exactly four tool calls" but only 2 of 4 steps were tool calls → Nemotron padded to "four" with 2 extra artifact_writes (3-4 artifacts per run). Changed to "exactly two tool calls (the rest are mental steps)" + tighter Red Lines. Verified: orchestrator now writes exactly 1 spawn + 1 artifact per run. **dave.md → tier1_agent.md renamed** (matching role-name convention of orchestrator.md, worker-researcher.md, worker-coder.md). **`memory/loader.ts` extended** with `loadSpecBody(agentId)` function (mirrors `worker-loop.ts loadWorkerSystemPrompt`) so Dave's spec body now loads into his runtime prompt — previously was dead code at runtime (only registry parsed its frontmatter). Hardcoded tool list in loader.ts updated to include `pipeline_run` + `pipeline_status`. **AGENTS.md in DB updated** to add `memory_promote` + `pipeline_run` + `pipeline_status` to tool list + line about preferring pipelines for orchestration. **IDENTITY.md in DB updated** "task guru" → "guru" (smaller pull toward self-execution). **DB FTS5 from previous session repaired** via Python sqlite3 `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')` + integrity_check ok. **3 UNFIXED issues going into next session**: (A) Dave's same-session behaviour regresses — clean in fresh chat (2 messages, no polling), but polls+self-executes by run 3 in same chat. Suspected: conversation history pattern-matches own past poll behaviour, outweighing spec rules at `## Operational Spec` position in system prompt. (B) Orchestrator improvises retries when worker hits upstream errors → one aborted run consumed 158.7k tokens (normal ~18k). (C) Free-tier upstream rate limits on Nemotron-120B + Gemma-31B trigger after ~3 same-session runs. £10 OpenRouter credit topped up mid-session, untouched (free models throughout). Memory rules added: `feedback_dont_blame_the_model.md` (STRICT — 100% facts required), `feedback_verify_deploy_before_claiming.md` (covers diagnosis AND deployment claims), `feedback_stop_when_user_says_step_back.md`, `feedback_terminal_workflow.md` (no tmux). Stop hook in user settings.json. **Next session**: fix Dave regression FIRST (likely loader.ts spec ordering or per-turn injection), consider paid Gemma 31B (`google/gemma-4-31b-it`, ~$0.001/pipeline, £10 = ~10,000 pipelines) to eliminate free-tier rate-limit confound, then endurance retest. Previous status preserved below.

**Earlier status (2026-06-02 noon):** ENDURANCE / CONCURRENCY SESSION (post-autonomy-polish). Surfaced + fixed 4 more bugs, then hit DB FTS5 corruption that blocks further verification until repaired. **Bugs fixed this session:** (1) **Docker deployment gap** — container loads from `/app/dist` baked into image, NOT from mounted host path. All `tsc` builds of host dist were invisible. Workaround: `docker cp /home/oldge/mission-control/gateway/dist/. mission-control-gateway-1:/app/dist/ && docker restart`. Long-term: rebuild image or mount `/app` as volume. (2) **Pipeline live instance binding** — `gateway/src/methods/pipelines.ts` now imports `SettingsStore` + `ProviderRegistry`, resolves active instance at `pipelines.run` call time (mirrors chat). `gateway/src/index.ts:149` passes both into `pipelineDeps`. Was using boot-time provider only. (3) **`spawn_agent` step task template** — added optional `task?: string` field to `StepDefinition` in `gateway/src/pipeline/types.ts`; `gateway/src/pipeline/runner.ts` interpolates `{{context.KEY}}` placeholders (same pattern as `llm` step's `userPrompt`); `gateway/src/pipelines/summarise_url.yaml` updated. Fallback chain: `step.task` → `context.task` → `Execute step ${step.id}`. (4) **Orchestrator spec verbatim-pass-through** — both Gemma 4-26b and gpt-oss-120b were ignoring the URL task they received and inventing fake worker tasks ("Project Status", "Test Report", "Global Trending News"). Fixed `gateway/src/agents/specs/orchestrator.md` Role section to explicitly state: "Your task is provided in the first user message… pass to worker verbatim… if the user's task includes a URL, you must pass it through unchanged." End-to-end verified on OpenRouter gpt-oss-120b: example.com + example.org pipelines completed with on-topic artifacts referencing actual web_fetch evidence. **ChatPage auto-scroll fix:** only auto-scrolls when within 120px of bottom; force-scrolls on session switch via `forceScrollNextRef`. **⛔ DB CORRUPTION:** `SqliteError: SQLITE_CORRUPT_VTAB` on FTS5 — caused by ~6 abrupt `kill <pid>` of gateway during writes earlier in session (compounded by container restart loop). Repair: `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')` after `docker stop` + backup. **Outstanding before release:** repair DB → endurance retest (1 → 2 → 3 concurrent on OpenRouter, multiple consecutive clean runs per JB's "no errors" rule) → SIGTERM graceful shutdown handler in gateway → audit sign-off → git init → README. **Operational rules (do not violate):** NEVER `kill <pid>` the gateway, always `docker restart mission-control-gateway-1`; always full `npm run build` (bare `tsc` skips post-build copy of `.md` and `.yaml`); always `docker cp + restart + verify via docker logs --tail 10` after dist changes; expect `tier1_agent (tier 1, 16 tools)` in startup log if dave spec is current. **Local Gemma incidental finding:** under 2x concurrent pipeline load, Gemma 4-26b returned plain text instead of structured tool calls ~50% of the time — known small-model issue, not a code bug; cleanly handled by gpt-oss-120b on OpenRouter once orchestrator spec was fixed. Below: previous status from autonomy + polish session — Major shipped: **proactive Dave notify on pipeline completion** (Dave autonomously messages user, 30s debounce, per-session lock, AUTO-NOTIFY chip — `gateway/src/notify/pipeline-notify.ts` + `gateway/src/session-lock.ts` + migration v4 adds `launching_session_id` + `launching_agent_id` + `messages.auto_notify`); **artifact ↔ pipeline linkage** (ToolContext.pipelineRunId/stepId threading through runner → worker-loop → artifact_write); **sub-worker token propagation** (worker-loop now parses tokensUsed from subagent_spawn JSON, pipeline budgets enforced); **`pipeline_status` tool** (Dave checks outcomes; 16 tools total); **null-runId race fix** (was a name-mismatch query bug); **chat-instance live binding** (ChatPage.selectedModel from active instance, models.list resolver-based, instance switching updates catalogue without restart); **session title polish** (autoTitle `instance · MM/DD HH:MM`, dropdown `title · shortId`, live refresh via chat.send response); **Overview health pills 3-state** (Not selected / Active / Unreachable with matching dot colors); **health endpoint reads active instance** (was env-stale). Plus `.gitignore`, `gateway/.env.example`, and `CLAIMS.md` (every public claim mapped to code with SAFE / NEEDS QUALIFIER / DO NOT CLAIM verdict — includes DO NOT CLAIM list for auto-retry, tier escalation, Anthropic direct, per-instance baseUrl, Skills, Plugins, Channels integrations). Verified end-to-end twice on Gemma: pipeline_run with real runId → research_task on davelocal → orchestrator + worker artifacts linked → 30s after completed, notifier fires → Dave autonomously calls pipeline_status → AUTO-NOTIFY summary message with both artifact titles. Earlier this evening: ONE BIG CODING PUSH closed both 🔴 TOP PRIORITY + all 8 PRIORITY DEFER + 4 of 5 POLISH PHASE items. TypeScript zero errors throughout 8+ Docker rebuilds. ⚠️ Architecture-vs-reality gap: §9.6 auto-retry / §8.5 tier escalation NOT built (watchdog marks failed, no retry, no escalation) — JB has not publicly claimed these, safe to defer. **Next:** audit sign-off → git init → README → public release. **Streaming choppy on Gemma reasoning models** (LM Studio upstream batching — confirmed not our code) — documented in CLAIMS.md, README will note. 🔴 TP#1 X-post gap shipped: `memory_promote` tool + hourly 7-day daily-note sweep job (`gateway/src/memory/sweep.ts`) + dave.md rewrite (daily-notes section, milestone direct-write vs promotion, end-of-day summary triggers, act-first-narrate-after red-line) + AgentsPage DAILY NOTE hint line. 🔴 TP#2 Settings wiring shipped: typed JSON store at `~/.missioncontrol/settings.json` (`gateway/src/store/settings.ts`) + `settings.get`/`settings.update` methods with masked-on-wire keys + `settings.changed` broadcast + `reasoning: { effort }` plumbed through CompletionRequest → openrouter adapter → AgentLoop RunParams → chat.send params + ProvidersTab/ModelsTab/QuickTab/InfrastructureTab rewired through gateway via `useSettings()` hook + ChatPage sends `{ model, thinking }` per message + Gateway Endpoint fields left honestly read-only (server can't reconfigure own listen port at runtime). PD#3-9 all closed (act-first-narrate-after folded into TP#1; milestone guidance in dave.md; migration v3 adds per-message input_tokens/output_tokens/duration_ms to messages; daily-note UX hint shipped in TP#1; Channels Connect buttons re-styled as honest "Coming soon" pills; Monitor CONTEXT label tier1_agent→Dave + PIPELINE stale fallback removed; mc:theme/mc:mode localStorage cleanup + dead mcConfig methods removed). Polish phase items L1+L2+L4+Instances shipped: `pipelines.available` reads YAMLs dynamically from builtin + `~/.missioncontrol/pipelines/`; 5 preset pipelines added — total 8 (summarise_url, draft_document, code_review, daily_digest, fact_check); `pipeline_run` tool — Dave now has 15 tools; ProviderRegistry holds one adapter per provider with valid creds + `instances[]` + `activeInstanceId` in settings + instances.list/create/update/delete/setActive methods + Sidebar rewired with live list + Add modal (filtered to providers-with-creds) + chat.send resolves to active instance's provider+model. **L3 visual pipeline builder + Skills + Plugins + Channels integrations deliberately deferred** to future sessions (architectural decisions needed). TypeScript zero errors across gateway + app at every checkpoint. Docker rebuilt + boot-tested four times — clean every time. Smoke tests green: settings round-trip via Node SettingsStore, 7-day sweep with DB fixtures (1 fact expired, 1 milestone untouched), memory_promote SQL flip, migration v3 column presence, instances auto-seed on upgrade, pipelines.available returns all 8 with titles+descriptions. ⚠️ `.gitignore` STILL not written — MUST exclude `gateway/.env`, `~/.missioncontrol/settings.json`, `**/node_modules`, `**/dist`, `*.sqlite`, secrets. Next: write `.gitignore` → audit sign-off → public release (GitHub + Docker Hub + Reddit + X launch thread).

---

## 1. The Team

| Agent | Machine | Model | Role |
|-------|---------|-------|------|
| **Claude Code** | Beelink | claude-sonnet-4-6 | Overseer — architecture, specs, security, review, hard problems |
| **Gemma Agent** | Beelink | Gemma 4 26B (LM Studio) | Small tasks — individual files, utilities, fixes, tests |
| **OpenCode** | Beelink | — | Execution — running builds, tests, linting on Beelink |
| **OpenRouter Agent** | Mac | GPT-OSS-120B via OpenRouter, free (OpenClaw Docker) | Big tasks — full module generation, complex logic |

---

## 2. Role Boundaries

### Claude Code — Overseer
- Writes the spec/brief for every component before it gets built
- Reviews all output before it's accepted into the codebase
- Makes all architecture decisions
- Takes on any task that requires cross-file understanding or is security-sensitive
- Has direct access to the project via Windows filesystem and WSL

### Gemma Agent (Beelink, LM Studio)
**Good for:**
- Implementing a single well-defined file from a clear spec
- Small utility functions, type definitions, config schemas
- Fixing a specific named bug with a clear reproduction
- Running file operations, moving/renaming things
- Wiring up a new route or handler once the pattern is established

**Not for:**
- Anything that touches more than 2-3 files simultaneously
- Security-sensitive code (auth, token handling, tool boundaries)
- The agentic loop, pipeline runtime, or provider adapters
- Anything where the design isn't fully locked first

### OpenCode (Beelink)
- Runs `npm install`, `npm run dev`, `npm run build`
- Executes test suites and reports results
- Runs linting, type checks
- Does not write code — only executes and reports

### OpenRouter Agent (Mac, GPT-o3 120B)
**Good for:**
- Generating a complete module from a detailed spec (300-500 line files)
- The pipeline runtime — needs a big context to hold all the pieces
- Provider adapters (especially the Anthropic one — complex streaming)
- The memory system — multiple interacting files
- The subagent_spawn tool + orchestrator loop
- Any task where Gemma has attempted and got stuck

**Not for:**
- Tasks that need live file access to the Beelink project (unless sync is confirmed)
- Security-sensitive code — Claude reviews all security code before accepting

---

## 3. Infrastructure Setup (one-time, before build starts)

### 3.1 Syncthing — Confirm on Next Mac Boot

Currently confirmed synced:
- `/home/oldge/.openclaw/workspace` → Mac (OpenClaw workspace — definitely live)
- `/home/oldge/` → Mac (home directory — needs confirmation on Mac side)

**Action required (next Mac boot):**
1. Open Syncthing UI on Mac (`http://127.0.0.1:8384`)
2. Confirm whether home directory folder is accepted and syncing
3. If yes — move the mission-control project to `~/mission-control/` in WSL
4. If no — add `mission-control/` as a new Syncthing folder on both sides

### 3.2 Task Coordination Folder

A `tasks/` folder inside the OpenClaw workspace acts as the shared inbox:

```
/home/oldge/.openclaw/workspace/
└── tasks/
    ├── inbox/      ← Claude drops new task briefs here
    ├── inprogress/ ← Agent moves brief here when picked up
    ├── review/     ← Agent drops output here when done
    └── done/       ← Claude moves here after accepting
```

### 3.3 Task Brief Format

Every task brief is a Markdown file. Example: `task-001-gateway-server.md`

```markdown
# Task: [Component Name]
**ID:** task-NNN
**Assigned to:** gemma | openrouter | claude
**Size:** small | medium | large
**Depends on:** [task ID or "nothing"]

## What to build
[exact description of what the file/module should do]

## File to create
`gateway/src/path/to/file.ts`

## Spec
[full technical spec — types, behaviour, edge cases]

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Do not
- [explicit list of things to avoid]
```

---

## 4. Build Sequence with Agent Assignments

Each step marked 🔒 is security-sensitive — Claude reviews before any output is accepted. Nothing moves to the next phase until the test at the end of the current phase passes.

### Phase 1 — Gateway Foundation

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 1.1 | `gateway/src/types.ts` — shared types (Request, Response, Event, Client) | Gemma | Small | — |
| 1.2 | `gateway/src/auth.ts` — token load/generate, Origin validation | Claude | Small | 🔒 |
| 1.3 | `gateway/src/broadcast.ts` — push event broadcaster | Gemma | Small | — |
| 1.4 | `gateway/src/router.ts` — method dispatcher | Gemma | Small | — |
| 1.5 | `gateway/src/server.ts` — HTTP + WebSocket server, wires auth + router | OpenRouter | Large | 🔒 |
| 1.6 | `gateway/src/methods/connect.ts` — handshake handler | Claude | Small | 🔒 |
| 1.7 | `gateway/src/methods/health.ts` — health check | Gemma | Small | — |
| 1.8 | `gateway/src/index.ts` — entry point, startup | Gemma | Small | — |
| 1.9 | **Test:** gateway starts, health responds, bad Origin rejected | OpenCode | — | — |

### Phase 2 — Provider + Loop (Dave's Loop)

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 2.1 | `gateway/src/providers/types.ts` — ProviderAdapter interface | Claude | Small | — |
| 2.2 | `gateway/src/providers/local.ts` — generic local OpenAI-compat adapter (covers LM Studio, Ollama, llama.cpp). Configurable baseUrl. Validates baseUrl is loopback-only at instantiation — rejects anything else with a hard error | Claude | Medium | 🔒 |
| 2.3 | `gateway/src/providers/openrouter.ts` — OpenRouter adapter (reuses local.ts with cloud baseUrl + API key) | Gemma | Small | — |
| 2.4 | `gateway/src/providers/anthropic.ts` — Anthropic adapter | OpenRouter | Large | — |
| 2.5 | `gateway/src/agents/registry.ts` — agent credentials registry. Loads all spec files from `agents/specs/` at startup, parses into `AgentCredential` records, stores in memory. Read-only after load — no method can modify it at runtime | Claude | Small | 🔒 |
| 2.6 | `gateway/src/loop.ts` — Dave's agentic loop (no tools yet). Assigns `correlationId` at loop entry. Checks agent credential capabilities before every tool call | OpenRouter | Large | 🔒 |
| 2.7 | **Test:** gateway starts, local provider connects to LM Studio, bad baseUrl rejected, credentials registry loaded | OpenCode | — | — |

### Phase 3 — Session Storage + Observability Foundation

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 3.1 | `gateway/src/store/db.ts` — SQLite setup. **First line after open: `PRAGMA journal_mode=WAL`**. Migrations for all tables: sessions, messages, messages_fts (FTS5), pipeline_runs, artifacts, memory_entries (with valid_from/valid_until), tool_call_log, model_call_log, error_log | Claude | Medium | 🔒 |
| 3.2 | `gateway/src/store/monitor-buffer.ts` — async monitoring write buffer. In-memory queue for tool_call_log, model_call_log, error_log events. Flushes to SQLite in batch every 1 second on a background timer. Never blocks the caller. Fatal errors written synchronously before process exit | Claude | Small | — |
| 3.3 | `gateway/src/store/redact.ts` — redaction filter. Scrubs API keys, tokens, passwords, out-of-workspace paths from any string before it reaches error_log or the UI. Used by error_log writer and error event broadcaster | Claude | Small | 🔒 |
| 3.4 | `gateway/src/methods/sessions.ts` — sessions.list/create/history/delete | Gemma | Medium | — |
| 3.5 | Wire session persistence into loop.ts | Claude | Small | — |
| 3.6 | **Test:** WAL mode confirmed on, session created, messages persist, monitor-buffer flushes without blocking, redact strips a test API key | OpenCode | — | — |

### Phase 4 — Tools

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 4.1 | `gateway/src/tools/types.ts` — ToolSchema, ToolResult, executor interface. Include `correlationId` field on every ToolResult | Claude | Small | 🔒 |
| 4.2 | `gateway/src/tools/file.ts` — file_read, file_write, file_edit with workspace boundary | Claude | Medium | 🔒 |
| 4.3 | `gateway/src/tools/web.ts` — web_fetch (SSRF protection) + web_search | Claude | Medium | 🔒 |
| 4.4 | `gateway/src/tools/memory.ts` — memory_write, memory_replace, memory_remove, memory_get, memory_search, **memory_supersede** (atomic valid_until + new entry). All reads query `valid_until IS NULL` by default | OpenRouter | Large | — |
| 4.5 | `gateway/src/tools/exec.ts` — exec tool, off by default, approval flow | Claude | Medium | 🔒 |
| 4.6 | `gateway/src/tools/artifact.ts` — artifact_write, SQLite storage | Claude | Medium | 🔒 |
| 4.7 | Wire tool executor into loop.ts — assigns correlationId per execution, writes tool_call_log row via monitor-buffer (input/output stored as SHA-256 hash only, never raw content), writes error_log via monitor-buffer on failure | Claude | Small | 🔒 |
| 4.8 | `gateway/src/methods/tools.ts` — tools.list handler | Gemma | Small | — |
| 4.9 | `gateway/src/methods/artifacts.ts` — artifacts.list, artifacts.get | Gemma | Small | — |
| 4.10 | **Test:** file_read works, workspace boundary blocks traversal, artifact_write stores and retrieves, tool_call_log row written with hash not raw content, memory_supersede creates new entry and marks old as valid_until | OpenCode | — | — |

### Phase 5 — Memory System

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 5.1 | `gateway/src/memory/loader.ts` — loads SOUL.md, AGENTS.md, IDENTITY.md, daily note at session start. Reads from memory_entries table (`valid_until IS NULL`) not flat files | Gemma | Medium | — |
| 5.2 | `gateway/src/memory/store.ts` — cap enforcement, write/replace/remove/supersede, FTS5 search. All writes use temporal schema (valid_from = now, valid_until = NULL). memory_supersede is atomic (single SQLite transaction) | OpenRouter | Large | — |
| 5.3 | Wire memory loader into loop.ts system prompt construction | Claude | Small | — |
| 5.4 | **Test:** SOUL.md loaded into context, write over cap returns error, memory_supersede marks old entry and creates new in single transaction | OpenCode | — | — |

### Phase 6 — Pipeline Runtime

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 6.1 | `gateway/src/pipeline/types.ts` — PipelineRun, Step, StepType, Envelope types. Include BudgetConfig type and budget tracking fields on PipelineRun | Claude | Small | — |
| 6.2 | `gateway/src/pipeline/loader.ts` — load and validate YAML/JSON pipeline files. Parse and validate `budget:` stanza if present | Gemma | Small | — |
| 6.3 | `gateway/src/pipeline/runner.ts` — step executor (llm, spawn_agent, condition, parallel). After every step: update tokens_used and cost_usd_used in pipeline_runs. Check against budget ceiling — if exceeded, execute on_exceed policy before any further steps. Write pipeline step events to model_call_log via monitor-buffer | OpenRouter | Large | — |
| 6.4 | `gateway/src/pipeline/approval.ts` — approval_gate step, resume token sign/verify | Claude | Medium | 🔒 |
| 6.5 | `gateway/src/pipeline/watchdog.ts` — stuck run detector, self-healing, notification. Also checks budget_timeout_secs (wall-clock timeout) on running pipelines | Gemma | Medium | — |
| 6.6 | `gateway/src/tools/spawn.ts` — subagent_spawn tool. Checks spawn tools against agent credentials registry — strips any tool not in target role's capability list, logs security warning to error_log | Claude | Medium | 🔒 |
| 6.7 | `gateway/src/methods/pipelines.ts` — pipelines.list, pipelines.run, pipelines.status, pipelines.approve | Claude | Medium | 🔒 |
| 6.8 | Write first real pipeline definition: `gateway/src/pipelines/health_check.yaml` — smoke test pipeline with budget stanza | Claude | Small | — |
| 6.9 | **Test:** pipeline runs, budget enforced (abort when exceeded), llm step fires, approval gate pauses, resume works, stuck run auto-heals, spawn strips uncredentialed tool | OpenCode | — | — |

### Phase 7 — UI Wired Up

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 7.1 | `app/src/lib/gateway-client.ts` — replace OpenClaw client with our gateway client | Claude | Medium | 🔒 |
| 7.2 | Update `ChatPage.tsx` — use new gateway client, new event names | Gemma | Medium | — |
| 7.3 | `gateway/src/methods/chat.ts` — chat.send + chat.abort handlers | Claude | Medium | 🔒 |
| 7.4 | **Test:** full end-to-end — type a message in UI, response streams back | Manual | — | — |

### ✅ UI Review — COMPLETE (2026-05-30)

All 9/9 tabs interviewed and locked. Full specs in PROGRESS.md. Tab build order and agent assignments below.

---

### Phase 8 — Pre-work: Gateway Wiring (must happen before any tab builds)

These four items are required by the Chat tab spec. Claude writes all of them — they touch security-sensitive paths (loop.ts, chat.ts broadcast).

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.0a | `gateway/src/loop.ts` — wire `inputTokens` + `outputTokens` into `chat.final` broadcast. Currently only written to monitorBuffer, never sent to UI. Read the usage from model response, add to final event payload. | Claude | Small | 🔒 |
| 8.0b | `gateway/src/loop.ts` — add real t/ps timing. Track `durationMs` from first token to last. Currently hardcoded 0 in model_call_log. Wire into `chat.final` payload as `tokensPerSecond`. | Claude | Small | — |
| 8.0c | `gateway/src/index.ts` + `gateway/src/loop.ts` — add `session.tool` broadcast event. When any tool executes, emit `{event: "session.tool", payload: {sessionId, toolName, correlationId, status}}` to subscribed clients. | Claude | Small | 🔒 |
| 8.0d | `gateway/src/methods/agents.ts` — `agents.list` method. Reads from credentials registry (already loaded), returns array of `{agentId, tier, capabilities, model}`. Wire into `gateway/src/index.ts`. | Claude | Small | — |

---

### Phase 8 — All Tabs Build

Build order: gateway → overview → sessions → chat → pipelines → agents → monitor → memory → settings → channels → sidebar. Nothing skipped.

#### 8.1 — Overview tab

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.1a | `app/src/pages/OverviewPage.tsx` — stat cards (Dave status, sessions today, tokens+cost, pipelines running/pending, messages today). System health strip (gateway, LM Studio, OpenRouter, SQLite). Recent activity feed (last 10 events, timestamped). Quick actions (new session, jump to pipeline, jump to approvals with badge count). All live via WebSocket events — no refresh button. | Claude | Medium | — |
| 8.1b | Wire `OverviewPage` into `App.tsx` — replace stub route `/` and `/overview` | Claude | Small | — |

#### 8.2 — Sessions tab

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.2a | `app/src/pages/SessionsPage.tsx` — full table from `sessions.list`. Columns: name · agent · status (Active/Idle/Ended) · last updated · message count · token total. Search bar. Click row → opens in Chat tab. Per-row actions: Edit (rename), Delete. Pagination. | Gemma | Medium | — |

#### 8.3 — Chat tab

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.3a | `app/src/pages/ChatPage.tsx` — full rebuild to spec. Keep context bubble exactly as-is. Add token count + t/ps under Dave's responses (from `chat.final`). Add thinking toggle + tool calls toggle in header (wire to `session.tool` events). Attach file button. Export chat button. Full voice: STT input + TTS output (Start Talk + Talk options buttons). Approval gates as inline Dave messages with Approve/Reject buttons. Remove anything rejected in spec. | Claude | Large | 🔒 |

#### 8.4 — Pipelines tab

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.4a | `app/src/pages/PipelinesPage.tsx` — Runs sub-tab: all pipeline executions (running/completed/failed/paused), real-time via `pipeline.tick` event, each row shows name + current step + status + token spend + progress bar. Approvals sub-tab: live gate queue (pipelines paused at gates), historical log of every gate raised + decision made. | Claude | Medium | — |

#### 8.5 — Agents tab

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.5a | `app/src/pages/AgentsPage.tsx` — left panel: agent roster (Dave/Orchestrator/Workers), each with name + tier + live status dot + current task + progress bar. Right panel: 7 sub-tabs per agent: Overview (status, session, context %, model, cost) · Files (SOUL/AGENTS/IDENTITY/MEMORY — blurred until clicked, editable) · Tools (full list, toggle on/off, grouped by category, Quick Presets, Enable/Disable All — wired to real gateway within spec limits) · Skills (empty state, structure ready) · Plugins (empty state slot) · Channels (Telegram/Discord/WhatsApp/iMessage — UI slot, no wiring) · Presets (named tool configs — save + switch). Nothing from OpenClaw stubs carried forward. | OpenRouter | Large | — |

#### 8.6 — Monitor tab (gateway first)

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.6a | `gateway/src/monitor.ts` — `MonitorTracker` class. Tracks per-agent state (updated by broadcast wrapper intercepting `agent.status` events). Queries `pipeline_runs` on each tick. Broadcasts `monitor.tick` every 2s to subscribed clients. AGENT_TTL_MS = 5min. PIPELINE_TICK_LIMIT = 20. | Gemma | Medium | — |
| 8.6b | `gateway/src/methods/monitor.ts` — `monitor.subscribe` → subscribe + return current tick. `monitor.unsubscribe` → unsubscribe. | Gemma | Small | — |
| 8.6c | `gateway/src/methods/monitoring-query.ts` — `monitoring.query`. Params: `type` (tool_calls / model_calls / errors / pipeline_runs), `agentId?`, `correlationId?`, `from?`, `to?`, `limit?` (default 50, max 500). Returns `{type, rows, total}`. | Claude | Medium | — |
| 8.6d | `gateway/src/index.ts` — add MonitorTracker: import, create after monitorBuffer, wire broadcast wrapper to call `tracker.updateAgentState()` on `agent.status`, register monitor + monitoring-query methods, add `tracker.stop()` to shutdown. | Claude | Small | 🔒 |
| 8.6e | `app/src/pages/MonitorPage.tsx` — **Minority Report + JARVIS aesthetic, not a table.** Centrepiece: live agent node graph — three-tier hierarchy, connecting lines pulse on comms, nodes glow when active. Left panel: active pipelines as horizontal step-flow, each step lights up as it runs, approval gates pulse amber. Right panel: gauges — token counter, cost meter (circular), context budget ring per agent, model latency pulse. Bottom: scrolling JARVIS-style event feed — tool calls, model calls, errors, correlationId drill-down. All driven by `monitor.tick` live. Build everything first, cut after seeing it. | OpenRouter | Large | — |

#### 8.7 — Memory tab

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.7a | `gateway/src/methods/memory-milestones.ts` — `memory.milestones` method. Queries `memory_entries WHERE type = 'milestone' AND valid_until IS NULL ORDER BY valid_from DESC`. Wire into index.ts. | Gemma | Small | — |
| 8.7b | `app/src/pages/MemoryPage.tsx` — card grid, newest first. Each card = one `type:milestone` memory entry written by Dave via `memory_write`. Date + time stamped. Expandable on click. Search bar. Nothing auto-logged — Dave decides what's a milestone. | Gemma | Medium | — |

#### 8.8 — Settings tab

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.8a | `app/src/pages/SettingsPage.tsx` — full rebuild. One page, 8 inner tabs. Quick (gateway status, active provider, Dave's model, exec on/off). Gateway (URL, port, token, Origin validation). Providers (local baseUrl, OpenRouter key, Anthropic key). Models (default model per tier, context length). Memory (cap per type, budget warning threshold). Infrastructure (workspace path, SQLite path, APPROVAL_SECRET, exec policy, watchdog interval). Appearance (theme, accent — real effect applied). Debug (log level, connection test, clear storage, gateway restart). Every input saves to real gateway config. If a setting can't change at runtime, label says so — no fake inputs. | Claude | Large | 🔒 |

#### 8.9 — Channels tab

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.9a | `app/src/pages/ChannelsPage.tsx` — card per channel: Telegram · Discord · Slack · WhatsApp · Signal · iMessage. Each card: name + icon + status (Connected/Not connected) + Connect → button + Last connect + Last message. All in "coming soon" state — honest, not fake config fields. | Gemma | Small | — |

#### 8.10 — Sidebar INSTANCES section

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.10a | `app/src/components/Sidebar.tsx` — add INSTANCES section below existing nav tabs. Dave slot + "+" button. Not wired to anything yet — just the structural slot. | Claude | Small | — |

#### 8.11 — Phase 8 test

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.11 | **Test:** Startup sequence works. Overview shows live stats. Sessions table loads. Chat shows token count + t/ps. Tool calls appear when toggled. Pipelines tab shows runs. Agents tab loads roster and sub-tabs. Monitor tab renders node graph + feed. Memory tab shows milestone cards (write one via Dave first). Settings all 8 inner tabs load, Quick tab shows live gateway status. Channels cards render. Sidebar INSTANCES section present. | Manual | — | — |



### Phase 8.5 — UI Polish Pass + Settings Rebuild (2026-05-30)

Tab-by-tab feedback walkthrough complete. All issues documented. Full rebuild required for Monitor and Settings. Visual polish across all pages. Design benchmark: Vercel / Linear / Raycast quality. Monitor: JARVIS + Minority Report mix.

#### 8.5.1 — Overview rebuild

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.5.1a ✅ | `app/src/pages/OverviewPage.tsx` — full visual redesign. Dave = large hero focal card top-left with pulsing status pill. Stat cards: large bold numbers as centrepiece, coloured accent top-border, inner glow on hover. System health: coloured pill badges not dots. Activity feed: full-width, colour-coded left border per event type (cyan=tool, violet=model, amber=approval, red=error). Quick Actions: icon + label, real visual weight. Breathing spacing. | Claude | Medium | — |

#### 8.5.2 — Chat additions

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.5.2a | `app/src/pages/ChatPage.tsx` — add missing features. Tool calls toggle in header (wire to session.tool events). Token count + t/ps under Dave responses (from chat.final). Attach file button in input bar. Voice: Start Talk + Talk Options buttons (STT + TTS). Context bubble untouched. Approval gates as inline Dave messages with Approve/Reject buttons. | Claude | Medium | 🔒 |

#### 8.5.3 — Agents fixes

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.5.3a ✅ | `app/src/pages/AgentsPage.tsx` — two fixes: (1) roster: remove T1/T2/T3 coloured badge boxes, replace with premium clean hierarchy indicators. (2) Files tab: add click-outside handler to re-blur revealed file content. | Claude | Small | — |

#### 8.5.4 — Monitor full rebuild

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.5.4a ✅ | `app/src/pages/MonitorPage.tsx` — full rebuild to JARVIS+Minority Report spec. Canvas: `#020408` bg, hex grid 3% opacity drifting 60s loop. Node network (JARVIS): Dave = two concentric rings 120px/90px + core dot, outer rotates 30s/rev always, inner pulses active. Orchestrator = 80px ring. Workers = 50px rings animate in when spawned. Connections = animated SVG dash lines flowing directionally, cyan `#00C8FF` live/ghost idle, particle flash on message. Pipeline flow (Minority Report): horizontal glassmorphic step blocks NOT circles, top-border colour = state (grey/cyan glow/solid/amber pulse/red). Gauges: 48px monospace token counter, circular SVG cost arc cyan→amber→red, context ring per agent, latency waveform. Event feed: full-width bottom strip, monospace, colour-coded left border (cyan=tool, violet=model, red=error, amber=approval). Idle: rings breathe scale 1.0→1.02→1.0 3s sine, lines ghost-pulse, grid drifts. JetBrains Mono for data. Palette: `#020408` bg, `#00C8FF` primary, `#7B61FF` violet, `#FFB800` amber, `#FF4444` error. | OpenRouter | Large | — |

#### 8.5.5 — Settings full rebuild

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.5.5a ✅ | `app/src/pages/SettingsPage.tsx` — full rebuild. Remove "Settings" heading + subtitle above tab bar on every inner tab. All 8 tabs get actual editable inputs. Quick: gateway status, active provider, Dave model, exec toggle. Gateway: URL/port/token/Origin editable, Save+Restart, Reconnect, better error state. Providers: local baseUrl editable, OpenRouter key editable (remove "planned" — already built), Anthropic key editable, Test button per provider. Models: default model dropdowns per tier, context length, connect-first empty state. Memory: token cap inputs per type, budget warning threshold, retention period. Infrastructure: paths editable, ports editable with Save+Restart, APPROVAL_SECRET masked with Regenerate, exec toggle, watchdog interval, Start/Stop/Restart per service. Appearance: working dark/light toggle, real colour picker, theme swatches. Debug: log level dropdown, test connection, clear storage, gateway restart, copy to clipboard, health refresh. Every input saves to real config or clearly labels why not. | Claude | Large | 🔒 |

#### 8.5.6 — Global style pass

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.5.6a ✅ | Apply Overview design language to all data tabs: SessionsPage, PipelinesPage, MemoryPage, ChannelsPage. Consistent card treatment, colour palette, typography. No content redesign — visual consistency only. | Claude | Medium | — |

#### 8.5.7 — Phase 8.5 test

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 8.5.7 ✅ | Test: Overview hero Dave card pulsing. Stat numbers large and bold. Monitor node graph glowing and breathing at idle. Monitor event feed present. Settings all 8 tabs have editable inputs. Settings heading text gone. Agents roster no box badges. Agents Files tab click-away re-blurs. Chat voice buttons present. Appearance dark/light toggle works. **COMPLETE 2026-05-30. Zero crashes, zero white screens.** | Manual | — | — |

### Dave Identity + Agent Specs (2026-05-30) ✅ COMPLETE

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| ✅ | `gateway/src/agents/specs/dave.md` — tier 1 spec, 13 tools, max-iterations 40, red lines | Claude | Small | — |
| ✅ | `gateway/src/agents/specs/orchestrator.md` — tier 2, 3 tools, hub-and-spoke enforced | Claude | Small | 🔒 |
| ✅ | `gateway/src/agents/specs/worker-researcher.md` — tier 3, 4 tools | Claude | Small | — |
| ✅ | `gateway/src/agents/specs/worker-coder.md` — tier 3, 5 tools | Claude | Small | — |
| ✅ | `gateway/package.json` build script — copies *.md specs to dist/agents/specs/ | Claude | Small | — |
| ✅ | `gateway/src/methods/memory-identity.ts` — `memory.identity` + `memory.identity.set` methods | Claude | Small | — |
| ✅ | `gateway/src/memory/loader.ts` — added `user` key to system prompt | Claude | Small | — |
| ✅ | Dave's identity seeded into SQLite (soul, agents, identity, user) under `tier1_agent` | Claude | Small | — |
| ✅ | `app/src/pages/AgentsPage.tsx` — Files tab wired: 5 boxes, load from gateway, save via gateway | Claude | Medium | — |
| ✅ | **Critical bug fix** — `index.ts`: pass `defaultAgentId: 'tier1_agent'` to `registerChatMethods`. Was defaulting to `'agent-dave'`, memory seeded under `'tier1_agent'` → blank system prompt → Dave had no personality | Claude | Small | 🔒 |

### Next — Dave Tool Use Test + Orchestrator Infrastructure

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| ✅ | Test Dave: tool use end-to-end — ALL 9 TOOLS CONFIRMED 2026-05-31 | Manual | — | — |
| ✅ | worker-loop.ts — headless worker execution engine (2026-05-31) | Claude | Large | 🔒 |
| ✅ | spawn.ts — real runWorker() wired, registry filtering, await support (2026-05-31) | Claude | Medium | 🔒 |
| ✅ | pipeline/runner.ts — llm + spawn_agent steps fully wired (2026-05-31) | Claude | Large | — |
| ✅ | methods/pipelines.ts — pipelines.run starts real runner with full deps (2026-05-31) | Claude | Medium | 🔒 |
| ✅ | research_task.yaml — fixed to route through Orchestrator LLM, not worker directly (2026-05-31) | Claude | Small | — |
| ✅ | orchestrator.md — updated with actionable worker table + step-by-step instructions (2026-05-31) | Claude | Small | 🔒 |
| ⬅ | End-to-end test: pipelines.run → Orchestrator LLM → subagent_spawn → worker-researcher → artifact. 2 runs done, fixes applied (researcher spec + watchdog timeout). Run 3 needed for clean confirmation. | Manual | — | — |
| ✅ | ArtifactsPage.tsx — built (was missing). List + expand + type badges. | Claude | Small | — |
| ✅ | pipelines.abort gateway method + Stop button in PipelinesPage | Claude | Small | — |
| ✅ | worker-researcher.md — prompt hardened, mandatory artifact_write | Claude | Small | — |
| ✅ | watchdog.ts — stuck timeout 5→15min for Gemma | Claude | Small | — |

### Full Codebase Security + Code Audit (MANDATORY — before Phase 9 and before any public release)

**Rule:** Nothing goes to GitHub, Docker, or any public distribution until this is complete and signed off.

Every file in the codebase read and checked for: security vulnerabilities, logic bugs, half-built stubs, spec vs implementation gaps, anything that would embarrass publicly. Output = PASS / WARN / FAIL per file. All FAILs fixed before release. Full file list in PROGRESS.md.

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| A.1 | Read + audit all gateway core files (index, server, router, broadcast, monitor, worker-loop, auth) | Claude | Large | 🔒 |
| A.2 | Read + audit all store files (db, monitor-buffer, redact) | Claude | Medium | 🔒 |
| A.3 | Read + audit all tools (file, web, exec, memory, artifact, spawn) | Claude | Large | 🔒 |
| A.4 | Read + audit pipeline runtime (runner, approval, watchdog, loader, types) | Claude | Large | 🔒 |
| A.5 | Read + audit all gateway methods (chat, pipelines, sessions, artifacts, agents, monitor, memory-identity, monitoring-query, connect) | Claude | Large | 🔒 |
| A.6 | Read + audit agents (registry, loop, loader, all 4 specs) | Claude | Medium | 🔒 |
| A.7 | Read + audit app UI (gateway-client, all pages, sidebar, App.tsx) | Claude | Large | — |
| A.8 | Read + audit pipeline definitions (research_task.yaml) | Claude | Small | — |
| A.9 | Fix all FAILs. Document all WARNs. Sign off. | Claude | TBD | 🔒 |

---

### Phase 9 — Hardening + Docker

| Step | Task | Agent | Size | Security |
|------|------|-------|------|----------|
| 9.1 | `gateway/Dockerfile` — production container image | Gemma | Small | — |
| 9.2 | `docker-compose.yml` — gateway + volume mounts for Mac staging | Gemma | Small | — |
| 9.3 | Systemd user service for Beelink production | Gemma | Small | — |
| 9.4 | **Test:** Docker build runs on Mac, gateway connects from Mac browser | Manual | — | — |

---

### Full Stress Test (MANDATORY — after Phase 9, before public release)

**Two configs:** Local (Gemma 4 26B A4B via LM Studio) + Cloud (OpenRouter, bigger models — GPT-4o, Claude etc)

**Goal:** Push every part of the build until it breaks. Fix what matters. No known bugs at public release.

| Area | Tests |
|------|-------|
| **Agents/Chat** | Dave all 9 tools in one session. Context budget warning at 95%. memory_replace/supersede/remove (untested). Extended conversation under load. |
| **Pipelines** | 10 consecutive research_task runs — no state leakage. Complex multi-part questions. Multiple web_fetch per run. Abort mid-run cleanup. Budget enforcement (maxCostUsd + maxTokens). Concurrent pipelines. |
| **Approval gates** | Pause → approve → resume. Pause → reject → clean end. |
| **Memory** | Write to cap, hard limit fires. memory_supersede atomicity. FTS5 search at scale. Persists across gateway restart. |
| **Artifacts** | 20+ artifacts, page renders correctly. Large content (10k+ chars). |
| **UI data verification** | Every Monitor Live field confirmed real DB data. Token counter, cost, tool calls increment in real time. Pipeline steps light up in correct order. All pages match DB. |
| **Provider switching** | Dave local → OpenRouter mid-session. Orchestrator on OpenRouter vs Gemma — quality comparison. Worker-researcher on OpenRouter — artifact quality. |
| **Resilience** | Kill LM Studio mid-pipeline. Gateway restart mid-pipeline. Rapid fire 5 pipelines. WebSocket disconnect/reconnect. |

**Output:** Bug list. All FAILs fixed. Sign off before GitHub/Docker/public access.

---

## 5. Quality Gates

Nothing moves to the next phase until the test at the end of the current phase passes.

- Claude reviews all 🔒 security-sensitive files personally before they enter the codebase
- OpenCode runs a build + lint check after every phase
- No file is accepted from an agent without Claude reading it first
- If an agent output is wrong or incomplete, Claude either fixes it directly or writes a correction brief and sends it back

---

## 6. Communication Protocol

### Claude → Agent (task brief)
Dropped into `/home/oldge/.openclaw/workspace/tasks/inbox/` as a `.md` file.  
Format: see §3.3 above.

### Agent → Claude (output)
Agent writes completed code to the project folder (or `/tasks/review/` if project isn't synced yet), then writes a short completion note to the brief file:
```
## Output
- Created: `gateway/src/server.ts` (142 lines)
- Notes: used X approach for Y reason
- Anything Claude should check: line 47, the timeout value
```

### Claude → Agent (correction)
Claude edits the brief directly, adds a `## Corrections` section, moves it back to `inbox/`.

---

## 7. One-Time Setup Checklist

Before Phase 1 begins:

- [ ] Boot Mac, confirm Syncthing home directory sync is active on both sides
- [ ] If yes: move mission-control to `~/mission-control/` in WSL
- [ ] If no: add `mission-control/` as new Syncthing folder on both sides
- [ ] Create `/home/oldge/.openclaw/workspace/tasks/inbox|inprogress|review|done` folders
- [ ] Confirm OpenRouter agent on Mac can read from workspace tasks folder
- [ ] Confirm `npm` and `node` available in WSL (for gateway dev)
- [ ] Run `npm install` in `gateway/` once package.json is ready

---

*This plan works alongside ARCHITECTURE.md. Architecture is the what. This is the who and when.*
