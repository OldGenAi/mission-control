# Mission Control — Agent Instructions

> **Read `VERIFIED_STATE.md` (Obsidian vault: `Mission Control/VERIFIED_STATE.md`)
> FIRST.** It is the single source of truth for current state and known bugs,
> from a full-codebase read on 2026-06-02. If any other doc contradicts it,
> VERIFIED_STATE wins.

## What this is
A standalone **agentic OS** — own WebSocket gateway, own agent runtime, own
deterministic pipeline engine, own temporal memory, own React UI. No OpenClaw
dependency (pivoted 2026-05-26). Three tiers: **Dave** (Tier 1, chat) →
**Orchestrator** (Tier 2, pipelines) → **Workers** (Tier 3, single-task).

## Current status
Feature-complete through Phase 9; **not yet released.** The live picture — current
state, next task, deferred items, what's shipped vs unproven — lives in
`VERIFIED_STATE.md` and `BACKLOG.md`. Do not duplicate status here; it drifts.
Read VERIFIED_STATE every session for the truth.

## ⛔ Read-gate (non-negotiable — before responding to ANY task this session)

Before you respond to the user's first task message, propose any change, or write
any code, read ALL of these **in full** — to the bottom, not just the headers:

1. `Mission Control/VERIFIED_STATE.md` — source of truth + freshness + the
   "FIRST TASK NEXT SESSION" block at the top
2. `Mission Control/COMPONENTS.md` — file-level status of every component
3. `gateway/src/agents/specs/tier1_agent.md` — Dave: 17 tools, Mode A/B, STOP rules
4. `gateway/src/agents/specs/orchestrator.md` — exactly 1 spawn (single or batch) + 1 summary + STOP
5. `gateway/src/agents/specs/worker-researcher.md` — ≤3 fetches + mandatory artifact_write
6. `gateway/src/agents/specs/worker-coder.md` — workspace boundary + tools

If the user's first message scopes you to specific files or a task, read this gate
set FIRST anyway, THEN address the scope. A scoped instruction does NOT override the
gate — it exists so a scoped change lands on the right architectural picture.

**Confirmation:** open your first substantive response with one line per file — the
literal last sentence (or last table row) of each — to prove the read reached the
bottom. The user can ask "quote the last line of X" any time to verify.

**Read on demand only — do NOT auto-read:** `docs/ARCHITECTURE.md` (design changes),
`docs/BUILD_PLAN.md` (next phase), vault `PLANNING.md` (decisions log),
`PROGRESS.md` (session history — 1167 lines, read targeted offsets),
`CLAIMS.md` (before any public claim), `AUDIT.md` (before claiming security posture),
`CHEATSHEET.md` (operational commands).

**⚠️ Stale twin — do not read:** `C:\Users\oldge\Projects\mission-control\CLAUDE.md`
is dated 2026-05-28 ("Phase 1 not started"). It is NOT this file. Ignore it if a tool
surfaces it.

## Hard rules (non-negotiable — from memory)
- **Never blame the model first.** Our code/specs/prompts/tool-surface are the
  suspects. 100% facts + user agreement before the model is ever the verdict.
- **Stop on "step back" / "stop" / frustration.** Halt, summarise, ask. No more
  tool calls that turn.
- **Verify before claiming.** Read the code before proposing a fix (diagnosis is
  a claim); paste deploy proof before saying "fixed". Source edits ≠ deployed code.
- **No tmux/nohup for long-lived services.** Give the user the command for his own
  visible Ubuntu terminal.
- **Driver-narrator.** User is a 50-yr non-technical beginner; drive the keyboard,
  narrate plainly, no instruction-list dumps. "Quality or don't ship."
- **Never `kill <pid>` the gateway** — `docker restart mission-control-gateway-1`
  (graceful SIGTERM). `kill -9` corrupts FTS5.

## Deploy recipe (the container loads `/app/dist`, NOT the host mount)
```bash
cd ~/mission-control/gateway && npm run build
docker cp dist/. mission-control-gateway-1:/app/dist/
docker restart mission-control-gateway-1
docker logs --tail 10 mission-control-gateway-1   # must show: tier1_agent (tier 1, 17 tools)
```
Use `npm run build` (not bare `tsc` — it skips copying `.md`/`.yaml` into dist).

## Two filesystems
- **Canonical:** WSL `/home/oldge/mission-control/` (synced via Syncthing).
- **Docs:** Obsidian `C:\Users\oldge\Documents\newfolder\obsidian\Mission Control\`.
- Retired files live in `_archive/` (gitignored) — not current, don't resurrect.

## Key paths
- Runtime data / settings / DB: `~/.missioncontrol/` (`settings.json`, `config.json`, `gateway.sqlite`)
- Gateway env: `~/mission-control/gateway/.env` (APPROVAL_SECRET, OPENROUTER_API_KEY, SEARCH_API_KEY)
- Gateway WS: `ws://127.0.0.1:4747` · UI: `http://localhost:5173`

## Mac Claude (only if running on the Mac Mini)
Coordination/troubleshooting only — do not edit memory, docs, or decide on
output. To relay a task to Mac OpenCode: read the brief from
`/users/jb/mission-control/tasks/inbox/`, confirm OpenCode is in
`/users/jb/mission-control/gateway`, and give the user the exact paste-in prompt.
All decisions flow from the Beelink instance.
